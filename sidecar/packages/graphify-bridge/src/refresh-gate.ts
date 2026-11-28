/**
 * Machine-wide gate for graph refreshes (ADR-0041 addendum, 2026-11-28).
 *
 * Every per-turn refresh — the project's code graph, its knowledge graph and
 * each tab worktree's code graph (ADR-0124) — spawns a graphify process that
 * holds 3.6-4.2 GB on a large project. One sidecar serves every tab, and
 * nothing limited how many ran at once: nine did at 00:46 on 28.11.2026
 * (~36 GB) and the machine ran out of memory.
 *
 * The gate keeps at most `MARVIN_GRAPH_REFRESH_MAX` (default 1, 1..4) running,
 * queues the rest FIFO, coalesces a request for a key already queued or
 * running, drops a request that waited past STALE_MS (the next turn asks
 * again), and refuses to start one while available memory is below
 * `MARVIN_GRAPH_REFRESH_MIN_FREE_PCT` (default 30, 5..90). It only manages
 * processes MARVIN spawned itself, via the child handle it is given — never
 * by pattern.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export const DEFAULT_REFRESH_MAX = 1;
export const DEFAULT_MIN_FREE_PCT = 30;
export const STALE_MS = 10 * 60 * 1000;
const SKIP_LOG_EVERY_MS = 60 * 1000;

function boundedInt(raw: string | undefined, lo: number, hi: number, fallback: number): number {
  const s = raw?.trim();
  if (!s || !/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return n >= lo && n <= hi ? n : fallback;
}

/** `MARVIN_GRAPH_REFRESH_MAX`: integer 1..4, anything else is the default. */
export function graphRefreshMax(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.MARVIN_GRAPH_REFRESH_MAX, 1, 4, DEFAULT_REFRESH_MAX);
}

/** `MARVIN_GRAPH_REFRESH_MIN_FREE_PCT`: integer 5..90, anything else is the default. */
export function graphRefreshMinFreePct(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.MARVIN_GRAPH_REFRESH_MIN_FREE_PCT, 5, 90, DEFAULT_MIN_FREE_PCT);
}

/**
 * Available memory as a percentage of total, or null when it cannot be read
 * (the guard then lets the refresh run — the cap still bounds it).
 *
 * macOS: `os.freemem()` is only the "free" pages, which on a Mac in steady
 * state is a few percent because the kernel keeps the rest as file cache; it
 * would skip every refresh. Memory that can be reclaimed without paging is
 * free + inactive + speculative + purgeable, so those `vm_stat` page counts
 * are summed. Linux: `MemAvailable` from /proc/meminfo, else `os.freemem()`.
 */
export async function readAvailableMemoryPct(): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const out = (await pExecFile("/usr/bin/vm_stat", [], { timeout: 3000 })).stdout;
      const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
      const pages = (label: string): number => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(out)?.[1] ?? 0);
      const avail = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
      const total = totalmem();
      return total > 0 ? Math.min(100, ((avail * page) / total) * 100) : null;
    }
    if (process.platform === "linux") {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8"));
      if (m) return Math.min(100, ((Number(m[1]) * 1024) / totalmem()) * 100);
    }
    return (freemem() / totalmem()) * 100;
  } catch {
    return null;
  }
}

export type RefreshOutcome = "started" | "queued" | "coalesced";

export interface RefreshRequest {
  outcome: RefreshOutcome;
  /** Resolves when the job has finished, been dropped or been skipped; the run time in ms (null when it never ran). */
  done: Promise<number | null>;
}

interface Job {
  key: string;
  start: () => ChildProcess | null;
  queuedAt: number;
  done: Promise<number | null>;
  settle: (ms: number | null) => void;
}

interface Deps {
  readFreePct: () => Promise<number | null>;
  now: () => number;
  env: () => NodeJS.ProcessEnv;
  log: (line: string) => void;
}

const defaultDeps = (): Deps => ({
  readFreePct: readAvailableMemoryPct,
  now: Date.now,
  env: () => process.env,
  // eslint-disable-next-line no-console
  log: (line) => console.log(`[graph-refresh] ${line}`),
});

let deps: Deps = defaultDeps();
const running = new Map<string, Job>();
const queue: Job[] = [];
let lastSkipLogAt = -Infinity;

/** Test hook: replace the clock, memory reader, env or logger; `{}` restores defaults. */
export function configureGraphRefreshGate(over: Partial<Deps> = {}): void {
  deps = { ...defaultDeps(), ...over };
}

export function resetGraphRefreshGate(): void {
  running.clear();
  queue.length = 0;
  lastSkipLogAt = -Infinity;
  deps = defaultDeps();
}

export function graphRefreshStatus(): { running: number; queued: number; max: number } {
  return { running: running.size, queued: queue.length, max: graphRefreshMax(deps.env()) };
}

function makeJob(key: string, start: () => ChildProcess | null): Job {
  let settle!: (ms: number | null) => void;
  const done = new Promise<number | null>((r) => {
    settle = r;
  });
  return { key, start, queuedAt: deps.now(), done, settle };
}

async function launch(job: Job): Promise<void> {
  // The slot is already held (running has the job); give it back on every path.
  const release = (ms: number | null) => {
    running.delete(job.key);
    job.settle(ms);
    pump();
  };
  const minFree = graphRefreshMinFreePct(deps.env());
  const free = await deps.readFreePct();
  if (free !== null && free < minFree) {
    const now = deps.now();
    if (now - lastSkipLogAt >= SKIP_LOG_EVERY_MS) {
      lastSkipLogAt = now;
      deps.log(`skipped-low-memory key=${job.key} available=${free.toFixed(0)}% min=${minFree}%`);
    }
    release(null);
    return;
  }
  const t0 = deps.now();
  let child: ChildProcess | null = null;
  try {
    child = job.start();
  } catch {
    child = null;
  }
  if (!child) return release(null);
  deps.log(`started key=${job.key} running=${running.size} queued=${queue.length}`);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    const ms = deps.now() - t0;
    deps.log(`finished key=${job.key} duration=${ms}ms`);
    release(ms);
  };
  child.once("close", end);
  child.once("error", end);
}

function pump(): void {
  const max = graphRefreshMax(deps.env());
  while (running.size < max && queue.length > 0) {
    const job = queue.shift() as Job;
    if (deps.now() - job.queuedAt > STALE_MS) {
      deps.log(`dropped-stale key=${job.key} waited=${deps.now() - job.queuedAt}ms`);
      job.settle(null);
      continue;
    }
    running.set(job.key, job);
    void launch(job);
  }
}

/**
 * Ask for a refresh. `start` spawns the graphify child and returns it (null
 * when it could not); it runs only when a slot is free and memory allows.
 */
export function requestGraphRefresh(key: string, start: () => ChildProcess | null): RefreshRequest {
  const existing = running.get(key) ?? queue.find((j) => j.key === key);
  if (existing) {
    deps.log(`coalesced key=${key}`);
    return { outcome: "coalesced", done: existing.done };
  }
  const job = makeJob(key, start);
  if (running.size < graphRefreshMax(deps.env()) && queue.length === 0) {
    running.set(key, job);
    void launch(job);
    return { outcome: "started", done: job.done };
  }
  queue.push(job);
  deps.log(`queued key=${key} running=${running.size} queued=${queue.length}`);
  return { outcome: "queued", done: job.done };
}

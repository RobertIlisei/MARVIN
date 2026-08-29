/**
 * Background jobs with event-based completion wakeups (ADR-0038).
 *
 * MARVIN used to narrate "I started the build in the background, I'll be
 * notified when it's done" — but the only wakeup type was time-based
 * (ADR-0031), nothing watched the process, and shell-level backgrounding
 * (`cmd &`, `nohup`) slipped past the ADR-0032 deny. So the job ran
 * orphaned and MARVIN forgot. This is the missing piece: a tracked child
 * process whose EXIT fires a real follow-up turn — the same mechanism this
 * very harness uses to re-invoke an agent when its background task ends.
 *
 * The job is a child of the long-lived sidecar (not detached): it outlives
 * the turn that started it, but dies if the app quits (acceptable — the
 * user quit). On exit we build a {@link WakeupRecord} and reuse the shared
 * wakeup fire handler ({@link fireNow}) — an EVENT-triggered wakeup instead
 * of a clock-triggered one. Same turn-dispatch path, same posture
 * inheritance, same chain-depth guard against runaway.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stepDownEffort } from "./effort";
import { randomUUID } from "node:crypto";

import { MAX_CHAIN_DEPTH, fireNow, type WakeupRecord } from "./wakeup-scheduler";

/** Max concurrent background jobs per session — a rail, not a workload. */
export const MAX_JOBS_PER_SESSION = 3;
/**
 * Output kept for the completion turn: the first `HEAD_BYTES` (where a build
 * announces its failure) and the last `TAIL_BYTES` (where it announces its
 * result). Was a single 8 KB tail — which, for a `make smoke`, is Hikari
 * shutdown noise and a Postgres stack trace after `System.exit(0)`, injected
 * as ~2.2K tokens of user message per job (measured 2026-08-29); the one
 * line that mattered, `Tests run: 1663 … BUILD SUCCESS`, survived by luck.
 */
const HEAD_BYTES = 1024;
const TAIL_BYTES = 2 * 1024;

/**
 * Signals that mean the job was STOPPED, not that it finished (ADR-0038
 * follow-up). A long-running job (a dev server) never exits on its own — it
 * only ends when killed, and the dominant case is the sidecar being torn down
 * on app quit, which SIGTERMs its child jobs (this module's own contract:
 * "dies if the app quits"). Firing a "job did NOT succeed — diagnose" turn for
 * that is noise that resurfaces in the chat on every relaunch. A job that
 * finishes on its own exits with a numeric code (success OR failure) and still
 * earns a turn; a genuine crash (SIGSEGV / SIGABRT / SIGBUS / SIGFPE) is NOT in
 * this set, so real crashes still notify.
 */
const STOP_SIGNALS = new Set<NodeJS.Signals>([
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "SIGKILL",
]);

/** Per-turn identity + config the completion turn inherits — same shape
 *  as the wakeup tool context (no capability elevation). */
export interface BackgroundJobContext {
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral" | "ultron";
  permissionStrategy: "auto" | "gated";
  thinkingMode: string;
  advisorThinkingMode?: string | undefined;
  /** Depth of the turn starting the job (chain-depth guard). */
  depth: number;
}

interface JobRecord {
  id: string;
  command: string;
  reason: string;
  pid: number;
  startedAt: string;
  child: ChildProcess;
  tail: string;
  /** First HEAD_BYTES of output, frozen once full. */
  head: string;
  /** Total output bytes seen — decides whether head + tail overlap. */
  bytesSeen: number;
  /** Set when the user cancels — suppresses the completion turn. */
  cancelled: boolean;
  ctx: BackgroundJobContext;
}

// GLOBAL singleton for the same standalone-bundle reason as the wakeup
// scheduler: instrumentation.ts and the route chunk can get separate module
// copies; the running-jobs map must be shared so a job started on the route
// path and the fire handler wired there land on one object.
interface JobsState {
  jobs: Map<string, JobRecord>;
}
const STATE_KEY = "__marvinBackgroundJobsState__";
const g = globalThis as unknown as Record<string, JobsState | undefined>;
const state: JobsState = g[STATE_KEY] ?? (g[STATE_KEY] = { jobs: new Map() });

export type StartJobResult =
  | { ok: true; id: string; pid: number }
  | { ok: false; error: string };

export function startBackgroundJob(input: {
  command: string;
  reason: string;
  ctx: BackgroundJobContext;
}): StartJobResult {
  const { command, reason, ctx } = input;
  if (!command.trim()) return { ok: false, error: "command is empty" };

  const nextDepth = ctx.depth + 1;
  if (nextDepth > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      error: `job chain depth ${nextDepth} exceeds the cap of ${MAX_CHAIN_DEPTH} — refusing to start another background job from a job-completion turn.`,
    };
  }
  const running = [...state.jobs.values()].filter(
    (j) => j.ctx.marvinSessionId === ctx.marvinSessionId,
  );
  if (running.length >= MAX_JOBS_PER_SESSION) {
    return {
      ok: false,
      error: `this session already has ${running.length} background jobs running (cap ${MAX_JOBS_PER_SESSION}); wait for one to finish or cancel it.`,
    };
  }

  let child: ChildProcess;
  try {
    child = spawn("/bin/bash", ["-lc", command], {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rec: JobRecord = {
    id: randomUUID(),
    command,
    reason,
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    child,
    tail: "",
    head: "",
    bytesSeen: 0,
    cancelled: false,
    ctx,
  };
  const appendOutput = (buf: Buffer) => {
    const chunk = buf.toString("utf-8");
    rec.bytesSeen += chunk.length;
    if (rec.head.length < HEAD_BYTES) rec.head = (rec.head + chunk).slice(0, HEAD_BYTES);
    // The rolling window is head + tail wide so a job that fits inside it is
    // reported whole, with no stitching.
    rec.tail = (rec.tail + chunk).slice(-(HEAD_BYTES + TAIL_BYTES));
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.on("error", (err) => {
    rec.tail += `\n[spawn error] ${err.message}\n`;
  });
  child.on("exit", (code, signal) => onExit(rec, code, signal));

  state.jobs.set(rec.id, rec);
  return { ok: true, id: rec.id, pid: rec.pid };
}

/** Whole output when it fit the window; otherwise head + elision + tail. */
function outputExcerpt(rec: JobRecord): string {
  if (rec.bytesSeen <= HEAD_BYTES + TAIL_BYTES) return rec.tail;
  const tail = rec.tail.slice(-TAIL_BYTES);
  const elided = rec.bytesSeen - rec.head.length - tail.length;
  return `${rec.head}\n…[${elided} bytes elided]…\n${tail}`;
}

function onExit(rec: JobRecord, code: number | null, signal: NodeJS.Signals | null): void {
  state.jobs.delete(rec.id);
  // A user-cancelled job doesn't earn a "diagnose the failure" turn.
  if (rec.cancelled) return;
  // Neither does a job that was STOPPED by a shutdown/stop signal rather than
  // finishing — overwhelmingly the sidecar being SIGTERM'd on app quit, which
  // kills its child jobs. Without this, every app quit fires a spurious
  // "killed by signal SIGTERM — it did NOT succeed" turn that resurfaces in the
  // chat on the next launch (ADR-0038 follow-up). A real exit code, or a crash
  // signal, still fires below.
  if (signal != null && STOP_SIGNALS.has(signal)) return;

  const failed = signal != null || (code ?? 1) !== 0;
  const status = signal ? `killed by signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const tail = outputExcerpt(rec).trim() || "(no output captured)";
  const prompt =
    "A background job you started earlier has finished.\n\n" +
    `Command: \`${rec.command}\`\n` +
    `Result: ${status}\n\n` +
    "Last output:\n```\n" +
    tail +
    "\n```\n\n" +
    (failed
      ? "It did NOT succeed — read the output, diagnose the cause, and fix it or report clearly to the user."
      : "It succeeded — continue the work that depended on it, or report completion to the user.");

  const record: WakeupRecord = {
    id: rec.id,
    marvinSessionId: rec.ctx.marvinSessionId,
    projectId: rec.ctx.projectId,
    cwd: rec.ctx.cwd,
    model: rec.ctx.model,
    advisorModel: rec.ctx.advisorModel,
    personality: rec.ctx.personality,
    permissionStrategy: rec.ctx.permissionStrategy,
    thinkingMode: rec.ctx.thinkingMode,
    ...(rec.ctx.advisorThinkingMode ? { advisorThinkingMode: rec.ctx.advisorThinkingMode } : {}),
    // Dynamic effort (see effort.ts): a job that succeeded wakes the session
    // one rung down — the follow-up is "read the result and carry on". A job
    // that failed keeps the user's ceiling; diagnosing is real work.
    ...(failed ? {} : { effort: stepDownEffort(rec.ctx.thinkingMode, rec.ctx.model) }),
    prompt,
    reason: `background job done: ${rec.reason || rec.command.slice(0, 40)}`,
    createdAt: rec.startedAt,
    fireAt: Date.now(),
    depth: rec.ctx.depth + 1,
  };
  void fireNow(record);
}

export interface BackgroundJobSummary {
  id: string;
  command: string;
  reason: string;
  pid: number;
  startedAt: string;
}

export function listBackgroundJobs(marvinSessionId?: string): BackgroundJobSummary[] {
  return [...state.jobs.values()]
    .filter((j) => !marvinSessionId || j.ctx.marvinSessionId === marvinSessionId)
    .map((j) => ({
      id: j.id,
      command: j.command,
      reason: j.reason,
      pid: j.pid,
      startedAt: j.startedAt,
    }));
}

/** Cancel a running job. SIGTERM, then SIGKILL if stubborn. No completion
 *  turn fires (the user asked for it to stop). */
export function cancelBackgroundJob(id: string): boolean {
  const rec = state.jobs.get(id);
  if (!rec) return false;
  rec.cancelled = true;
  try {
    rec.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (!rec.child.killed) rec.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }, 2000).unref?.();
  return true;
}

/** Test-only: kill + clear all jobs. Marks each cancelled first so the
 *  SIGKILL'd exit doesn't fire a completion turn during teardown. */
export function __resetBackgroundJobsForTests(): void {
  for (const j of state.jobs.values()) {
    j.cancelled = true;
    try {
      j.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  state.jobs.clear();
}

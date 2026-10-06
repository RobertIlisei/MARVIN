/**
 * Graphify watchdog — keeps a project's knowledge graph fresh.
 *
 * Re-runs AST-only `graphify update <workDir>` when HEAD advances, debounced
 * to one run per GRAPHIFY_REFRESH_MIN_INTERVAL_MS (default 10 min).
 *
 * The caller passes `workDir` in directly; project selection lives
 * in `@marvin/runtime/projects`, not here.
 */

import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { setPriority } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GRAPHIFY_MIN_VERSION,
  graphifyBelowMinimum,
  graphifyEnv,
  graphifyMissingHint,
  graphifyVersion,
  resolveGraphifyBin,
} from "./graphify-bin";

const pExecFile = promisify(execFile);

const REFRESH_MIN_INTERVAL_MS =
  Number(process.env.GRAPHIFY_REFRESH_MIN_INTERVAL_MS) || 10 * 60 * 1000;

/**
 * How long to wait after a run that took `lastRunMs`. A large graph (65K
 * nodes) takes minutes at 100% of a core and 1.2 GB; with several tabs
 * committing, HEAD moves constantly, so the flat 10-minute floor kept one
 * running most of the time on an already loaded machine (2026-09-30). Waiting
 * ten times the last run bounds graphify to ~10% of wall time.
 */
export function refreshIntervalMs(lastRunMs: number, floorMs = REFRESH_MIN_INTERVAL_MS): number {
  return Math.max(floorMs, lastRunMs * 10);
}

/** Background graph builds yield the CPU to the user's builds and the sidecar. */
export function deprioritise(pid: number | undefined): void {
  if (!pid) return;
  try {
    setPriority(pid, 15);
  } catch {
    // The child may already have exited; priority is an optimisation only.
  }
}

let checkedVersionOf: string | null = null;

/** Once per binary per process: an incremental `update` from a graphify below
 *  the floor silently drops the cross-file edges the blast-radius tools read. */
function warnIfBelowMinimum(bin: string): void {
  if (checkedVersionOf === bin) return;
  checkedVersionOf = bin;
  const v = graphifyVersion(bin);
  if (graphifyBelowMinimum(v)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[graphify-watchdog] ${bin} is graphify ${v?.join(".")}; MARVIN needs ${GRAPHIFY_MIN_VERSION.join(".")}+ — older versions drop cross-file call edges on every incremental update, so graph_affected under-reports. Upgrade: uv tool install graphifyy@latest --force`,
    );
  }
}

interface WatchdogState {
  lastTriggerAt: number;
  lastTriggeredForHead: string | null;
  running: boolean;
  lastRunMs: number;
}

const stateByWorkDir = new Map<string, WatchdogState>();

function getState(workDir: string): WatchdogState {
  let s = stateByWorkDir.get(workDir);
  if (!s) {
    s = { lastTriggerAt: 0, lastTriggeredForHead: null, running: false, lastRunMs: 0 };
    stateByWorkDir.set(workDir, s);
  }
  return s;
}

async function gitHead(workDir: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile("git", ["-C", workDir, "rev-parse", "HEAD"], {
      timeout: 4000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// A missing binary fails every turn; say so once per process, not per turn.
let warnedMissing = false;

export interface GraphifyRefreshResult {
  triggered: boolean;
  reason: string;
  workDir: string;
  head?: string;
}

export async function maybeRefreshGraphify(
  workDir: string,
  options?: { force?: boolean; source?: string },
): Promise<GraphifyRefreshResult> {
  const state = getState(workDir);
  const now = Date.now();
  const source = options?.source ?? "manual";

  if (!options?.force) {
    if (state.running) return { triggered: false, reason: "already running", workDir };
    if (now - state.lastTriggerAt < refreshIntervalMs(state.lastRunMs)) {
      return { triggered: false, reason: "debounced", workDir };
    }
  }

  const head = await gitHead(workDir);
  if (!options?.force) {
    if (head && head === state.lastTriggeredForHead) {
      return { triggered: false, reason: "head unchanged", workDir };
    }
  }

  // Touch the graph path so we capture a "prior" mtime even when graphify-out
  // doesn't exist yet.
  const graphPath = join(workDir, "graphify-out", "graph.json");
  try {
    await stat(graphPath);
  } catch {
    // first run on this workDir — fine
  }

  state.lastTriggerAt = now;
  state.lastTriggeredForHead = head ?? null;
  state.running = true;

  try {
    const bin = resolveGraphifyBin();
    warnIfBelowMinimum(bin);
    const child = spawn(bin, ["update", workDir], {
      cwd: workDir,
      detached: true,
      stdio: "ignore",
      env: graphifyEnv(),
    });
    deprioritise(child.pid);
    child.on("close", () => {
      state.running = false;
      state.lastRunMs = Date.now() - now;
    });
    child.on("error", (err) => {
      state.running = false;
      const hint = graphifyMissingHint(err);
      if (hint && !warnedMissing) {
        warnedMissing = true;
        console.warn(`[graphify-watchdog] ${hint}`);
      }
    });
    child.unref();
  } catch {
    state.running = false;
    return { triggered: false, reason: "spawn failed", workDir };
  }

  return {
    triggered: true,
    reason: source,
    workDir,
    head: head ?? undefined,
  };
}

export function resetGraphifyState(workDir?: string): void {
  if (workDir) stateByWorkDir.delete(workDir);
  else stateByWorkDir.clear();
}

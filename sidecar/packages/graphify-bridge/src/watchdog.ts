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
import { join } from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

const REFRESH_MIN_INTERVAL_MS =
  Number(process.env.GRAPHIFY_REFRESH_MIN_INTERVAL_MS) || 10 * 60 * 1000;

interface WatchdogState {
  lastTriggerAt: number;
  lastTriggeredForHead: string | null;
  running: boolean;
}

const stateByWorkDir = new Map<string, WatchdogState>();

function getState(workDir: string): WatchdogState {
  let s = stateByWorkDir.get(workDir);
  if (!s) {
    s = { lastTriggerAt: 0, lastTriggeredForHead: null, running: false };
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

function findGraphifyBin(): string {
  return process.env.GRAPHIFY_BIN || "graphify";
}

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
    if (now - state.lastTriggerAt < REFRESH_MIN_INTERVAL_MS) {
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
    const child = spawn(findGraphifyBin(), ["update", workDir], {
      cwd: workDir,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.on("close", () => {
      state.running = false;
    });
    child.on("error", () => {
      state.running = false;
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

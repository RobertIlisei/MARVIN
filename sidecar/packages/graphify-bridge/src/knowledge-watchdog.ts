/**
 * Knowledge-graph watchdog (ADR-0041) — keeps the ACTIVE PROJECT's knowledge
 * graph (`<workDir>/graphify-out/knowledge/graph.json`) fresh, the sibling of
 * the code-graph `maybeRefreshGraphify`. Runs the AST-only knowledge-graph
 * builder (`scripts/build-knowledge-graph.py`, no LLM cost) when HEAD advances,
 * debounced.
 *
 * Strictly scoped to the workDir the caller passes (the active project) — like
 * everything else in this bridge it never touches MARVIN's own repo.
 *
 * Best-effort: if `python3` or the builder script can't be found, it no-ops
 * (returns `triggered: false`). The code graph still refreshes and the
 * first-message context degrades to reading ADR files directly, so a missing
 * knowledge graph never breaks a turn.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/**
 * Locate the knowledge-graph builder script. Prefers the explicit
 * `MARVIN_KNOWLEDGE_GRAPH_SCRIPT` env (set by `bin/marvin start`), then walks
 * up from cwd looking for `scripts/build-knowledge-graph.py`. Returns null when
 * it can't be found (bundled .app without the script shipped — caller no-ops).
 */
function findBuilderScript(): string | null {
  const env = process.env.MARVIN_KNOWLEDGE_GRAPH_SCRIPT;
  if (env && existsSync(env)) return env;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, "scripts", "build-knowledge-graph.py");
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface KnowledgeGraphRefreshResult {
  triggered: boolean;
  reason: string;
  workDir: string;
  head?: string;
}

export async function maybeRefreshKnowledgeGraph(
  workDir: string,
  options?: { force?: boolean; source?: string },
): Promise<KnowledgeGraphRefreshResult> {
  const state = getState(workDir);
  const now = Date.now();
  const source = options?.source ?? "manual";

  if (!options?.force) {
    if (state.running) return { triggered: false, reason: "already running", workDir };
    if (now - state.lastTriggerAt < REFRESH_MIN_INTERVAL_MS) {
      return { triggered: false, reason: "debounced", workDir };
    }
  }

  const script = findBuilderScript();
  if (!script) {
    return { triggered: false, reason: "builder script not found", workDir };
  }

  const head = await gitHead(workDir);
  if (!options?.force && head && head === state.lastTriggeredForHead) {
    return { triggered: false, reason: "head unchanged", workDir };
  }

  // Capture a prior mtime even when the knowledge graph doesn't exist yet.
  const graphPath = join(workDir, "graphify-out", "knowledge", "graph.json");
  try {
    await stat(graphPath);
  } catch {
    /* first build on this workDir — fine */
  }

  state.lastTriggerAt = now;
  state.lastTriggeredForHead = head ?? null;
  state.running = true;

  try {
    const child = spawn("python3", [script, workDir], {
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

  return { triggered: true, reason: source, workDir, head: head ?? undefined };
}

export function resetKnowledgeGraphState(workDir?: string): void {
  if (workDir) stateByWorkDir.delete(workDir);
  else stateByWorkDir.clear();
}

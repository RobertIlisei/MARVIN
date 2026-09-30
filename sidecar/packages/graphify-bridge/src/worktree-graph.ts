/**
 * Per-worktree code graph (ADR-0124 B).
 *
 * Since ADR-0107 a chat tab runs in its own git worktree, but every graph tool
 * read `<workDir>/graphify-out/graph.json` — built from the MAIN checkout. A
 * tab's own new code was invisible to its own graph: measured 2026-09-30, a
 * tab reported "graph is stale for platform.guidance; graph_affected found no
 * callers" for a module it had written an hour earlier.
 *
 * The fix gives each worktree its own code graph, in the worktree:
 * `<worktree>/graphify-out/`. That is where `graphify update <worktree>` writes
 * by default, its `source_file` paths are relative to the tree the tab sees,
 * and it is deleted with the worktree — no sweep, no second lifecycle. The
 * `.marvin/`-scoped services still key on `workDir` (ADR-0107); a graph is a
 * property of a tree, not of the project's bookkeeping. The knowledge graph
 * (docs/ADRs) and graph work-memory stay project-scoped.
 *
 * Cost is bounded the way ADR-0041 bounds the project refresh: AST-only, no
 * LLM. The first build copies the project's graph, manifest and extraction
 * cache, so the incremental update re-extracts only what the tab changed. One
 * refresh at a time per project (a Mac running three tabs must not run three
 * graphify processes), debounced per worktree, skipped when the tree has not
 * changed since the last build.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { graphifyEnv, graphifyMissingHint, resolveGraphifyBin } from "./graphify-bin";

const pExecFile = promisify(execFile);

/** Debounce per worktree. Short, because a tab's changes are what it queries next. */
const WORKTREE_REFRESH_MIN_INTERVAL_MS =
  Number(process.env.GRAPHIFY_WORKTREE_REFRESH_MIN_INTERVAL_MS) || 60 * 1000;

export const WORKTREE_GRAPH_FALLBACK_NOTE =
  "(project graph; this worktree's changes are not indexed yet — its own graph builds in the background)";

/** The tab worktree `cwd` sits in (`<workDir>/.marvin/worktrees/<slug>`), or null. */
export function worktreeOf(workDir: string, cwd: string | undefined): string | null {
  if (!cwd) return null;
  const rel = relative(workDir, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] !== ".marvin" || parts[1] !== "worktrees" || !parts[2]) return null;
  return join(workDir, ".marvin", "worktrees", parts[2]);
}

export interface GraphRoot {
  /** Directory whose `graphify-out/graph.json` the code-scope tools read. */
  root: string;
  /** The tab's worktree, when the session runs in one. */
  worktree: string | null;
  /** Set when a worktree session is answered from the project graph. */
  note: string | null;
}

/** Which code graph answers a session running in `cwd`. */
export function resolveGraphRoot(workDir: string, cwd?: string): GraphRoot {
  const worktree = worktreeOf(workDir, cwd);
  if (!worktree) return { root: workDir, worktree: null, note: null };
  if (existsSync(join(worktree, "graphify-out", "graph.json"))) return { root: worktree, worktree, note: null };
  return { root: workDir, worktree, note: WORKTREE_GRAPH_FALLBACK_NOTE };
}

interface ProjectRefreshState {
  running: string | null;
  queue: string[];
}
interface WorktreeRefreshState {
  lastTriggerAt: number;
  lastFingerprint: string | null;
}

const projectState = new Map<string, ProjectRefreshState>();
const worktreeState = new Map<string, WorktreeRefreshState>();

export interface WorktreeGraphRefreshResult {
  triggered: boolean;
  reason: string;
  worktree: string | null;
  seeded?: boolean;
}

async function treeFingerprint(worktree: string): Promise<string | null> {
  try {
    const head = (await pExecFile("git", ["-C", worktree, "rev-parse", "HEAD"], { timeout: 4000 })).stdout.trim();
    const status = (
      await pExecFile("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"], {
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
    return createHash("sha1").update(head).update("\0").update(status).digest("hex");
  } catch {
    return null;
  }
}

/** Keep `graphify-out/` out of the tab's `git status`, unless the repo tracks it. */
async function excludeGraphOut(worktree: string): Promise<void> {
  try {
    const tracked = (await pExecFile("git", ["-C", worktree, "ls-files", "graphify-out"], { timeout: 4000 })).stdout.trim();
    if (tracked) return;
    const ignored = await pExecFile("git", ["-C", worktree, "check-ignore", "-q", "graphify-out/graph.json"], { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (ignored) return;
    const common = (await pExecFile("git", ["-C", worktree, "rev-parse", "--git-common-dir"], { timeout: 4000 })).stdout.trim();
    const exclude = join(isAbsolute(common) ? common : join(worktree, common), "info", "exclude");
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (existing.split("\n").some((l) => l.trim() === "graphify-out/")) return;
    mkdirSync(join(exclude, ".."), { recursive: true });
    appendFileSync(exclude, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}graphify-out/\n`);
  } catch {
    /* best-effort: a visible graphify-out/ is noise, not damage */
  }
}

/**
 * Seed a worktree's graph from the project's: graph, manifest and extraction
 * cache, so the first incremental update re-extracts only what differs.
 * Returns false when there is nothing to seed from.
 */
export function seedWorktreeGraph(workDir: string, worktree: string): boolean {
  const from = join(workDir, "graphify-out");
  const to = join(worktree, "graphify-out");
  if (!existsSync(join(from, "graph.json"))) return false;
  if (existsSync(join(to, "graph.json"))) return true;
  mkdirSync(to, { recursive: true });
  for (const name of ["graph.json", "manifest.json", "cache"]) {
    const src = join(from, name);
    if (!existsSync(src)) continue;
    cpSync(src, join(to, name), { recursive: true, force: false, errorOnExist: false });
  }
  return true;
}

// A missing binary fails every refresh; say so once per process.
let warnedMissing = false;

function startUpdate(workDir: string, worktree: string, st: ProjectRefreshState): void {
  st.running = worktree;
  const done = () => {
    st.running = null;
    const next = st.queue.shift();
    if (next) startUpdate(workDir, next, st);
  };
  try {
    const child = spawn(resolveGraphifyBin(), ["update", worktree], {
      cwd: worktree,
      stdio: "ignore",
      env: graphifyEnv(),
    });
    child.on("close", done);
    child.on("error", (err) => {
      const hint = graphifyMissingHint(err);
      if (hint && !warnedMissing) {
        warnedMissing = true;
        console.warn(`[graphify-worktree] ${hint}`);
      }
      done();
    });
    child.unref();
  } catch {
    done();
  }
}

/**
 * Bring the code graph of the worktree `cwd` sits in up to date — seed it on
 * first use, then an incremental AST update. Fire-and-forget from the turn
 * runner; a no-op for a session in the shared checkout.
 */
export async function maybeRefreshWorktreeGraph(
  workDir: string,
  cwd: string | undefined,
  options?: { force?: boolean; source?: string },
): Promise<WorktreeGraphRefreshResult> {
  const worktree = worktreeOf(workDir, cwd);
  if (!worktree) return { triggered: false, reason: "not a worktree", worktree: null };
  if (!existsSync(worktree)) return { triggered: false, reason: "worktree missing", worktree };
  const wt = worktreeState.get(worktree) ?? { lastTriggerAt: 0, lastFingerprint: null };
  worktreeState.set(worktree, wt);
  const now = Date.now();
  const hasGraph = existsSync(join(worktree, "graphify-out", "graph.json"));
  if (!options?.force && hasGraph && now - wt.lastTriggerAt < WORKTREE_REFRESH_MIN_INTERVAL_MS) {
    return { triggered: false, reason: "debounced", worktree };
  }
  const fingerprint = await treeFingerprint(worktree);
  if (!options?.force && hasGraph && fingerprint && fingerprint === wt.lastFingerprint) {
    return { triggered: false, reason: "tree unchanged", worktree };
  }
  let seeded = false;
  if (!hasGraph) {
    try {
      seeded = seedWorktreeGraph(workDir, worktree);
    } catch {
      seeded = false;
    }
    if (!seeded) return { triggered: false, reason: "no project graph to seed from", worktree };
    await excludeGraphOut(worktree);
  }
  wt.lastTriggerAt = now;
  wt.lastFingerprint = fingerprint;
  const st = projectState.get(workDir) ?? { running: null, queue: [] };
  projectState.set(workDir, st);
  if (st.running) {
    if (st.running !== worktree && !st.queue.includes(worktree)) st.queue.push(worktree);
    return { triggered: false, reason: "queued behind another refresh", worktree, seeded };
  }
  startUpdate(workDir, worktree, st);
  return { triggered: true, reason: options?.source ?? "manual", worktree, seeded };
}

export function resetWorktreeGraphState(): void {
  projectState.clear();
  worktreeState.clear();
}

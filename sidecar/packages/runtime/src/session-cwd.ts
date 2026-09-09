/**
 * Session-aware cwd validation (ADR-0107).
 *
 * `validateProjectCwd` is exact-match against the registered project dirs,
 * and every route that writes `.marvin/` into its result must keep using it.
 * A chat session may run in a per-session git worktree instead — a directory
 * MARVIN itself created under `<workDir>/.marvin/worktrees/` and recorded in
 * `<workDir>/.marvin/worktrees.json`. This validator accepts exactly two
 * shapes:
 *
 *   1. a registered project dir                → workDir === cwd
 *   2. a REGISTERED worktree of a registered project, that git itself still
 *      lists (`git worktree list`)             → workDir = the project root
 *
 * Never an arbitrary directory, never a path under `.marvin/worktrees/` the
 * registry does not know, never a registry entry whose checkout is gone.
 */

import { resolve } from "node:path";

import { listProjects } from "./projects";
import { findWorktreeByPath, listGitWorktreePaths, type WorktreeRecord } from "./worktrees";

export type ValidateSessionCwdResult =
  | { ok: true; workDir: string; cwd: string; worktree: WorktreeRecord | null }
  | { ok: false; status: number; error: string };

export function validateSessionCwd(raw: unknown): ValidateSessionCwdResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, status: 400, error: "cwd is required" };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, status: 400, error: "cwd must be an absolute path" };
  }
  const resolved = resolve(raw);
  const projects = listProjects();
  const exact = projects.find((p) => resolve(p.workDir) === resolved);
  if (exact) {
    return { ok: true, workDir: resolved, cwd: resolved, worktree: null };
  }
  for (const p of projects) {
    const workDir = resolve(p.workDir);
    // Cheap prefix guard before touching the registry: a session worktree
    // always lives under its project.
    if (!resolved.startsWith(`${workDir}/`)) continue;
    const rec = findWorktreeByPath(workDir, resolved);
    if (!rec) continue;
    const live = listGitWorktreePaths(workDir);
    if (!live.includes(rec.path)) {
      return { ok: false, status: 409, error: "worktree checkout is gone", };
    }
    return { ok: true, workDir, cwd: rec.path, worktree: rec };
  }
  return { ok: false, status: 403, error: "workDir is not a registered project" };
}

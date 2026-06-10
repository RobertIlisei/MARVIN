/**
 * Data paths for MARVIN.
 *
 * Resolution order:
 *   1. `MARVIN_DATA_DIR` env var (wins when set).
 *   2. `~/.marvin/` (default).
 *
 * MARVIN is user-scoped, not project-scoped. Every project's graph / git
 * state lives under the project's own `workDir` — this directory only holds
 * MARVIN-owned state: conversation transcripts, cost tracker, registered
 * project list, MARVIN's own config.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** Root data directory for MARVIN. Guaranteed to exist after this call. */
export function getMarvinDataDir(): string {
  const raw = process.env.MARVIN_DATA_DIR?.trim();
  const dir = raw ? resolve(raw) : resolve(getHomeDir(), ".marvin");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Audit 🟡 #12 + #13: tighten root dir mode to 0700, both on
  // create AND on every call (idempotent re-chmod). Other users on
  // a shared machine should not be able to read MARVIN's
  // auth-config.json / projects.json / session JSONLs / cost
  // tracker / honeycomb.json. Re-chmod-on-every-call ensures
  // existing installs that pre-date this fix get tightened too;
  // it's a single fchmod syscall on the happy path.
  // Best-effort; mode bits may not stick on every filesystem.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* non-fatal */
  }
  return dir;
}

/**
 * Centralized registry of every file / directory MARVIN reads or writes
 * inside its own data dir. Keep this list small — if a caller needs a new
 * path it gets added here, not computed ad-hoc.
 */
export const marvinPaths = {
  /** App-level config: default model, personality mode, UI prefs. */
  config: () => join(getMarvinDataDir(), "config.json"),
  /** Registered projects (id, name, workDir, createdAt). */
  projects: () => join(getMarvinDataDir(), "projects.json"),
  /** Cumulative cost ledger — one aggregate file, not per-project. */
  costTracker: () => join(getMarvinDataDir(), "cost-tracker.json"),
  /** Per-project session transcripts. */
  sessionsDir: (projectId: string) =>
    join(getMarvinDataDir(), "sessions", projectId),
  /** Individual session transcript (JSONL). */
  sessionFile: (projectId: string, sessionId: string) =>
    join(getMarvinDataDir(), "sessions", projectId, `${sessionId}.jsonl`),
  /** Active project pointer (last project the user opened). */
  activeProject: () => join(getMarvinDataDir(), "active-project.json"),
  /** Directory of per-project pending-wakeup files (ADR-0031). */
  wakeupsDir: () => join(getMarvinDataDir(), "wakeups"),
  /** Per-project pending self-scheduled wakeups (ADR-0031). */
  wakeupsFile: (projectId: string) =>
    join(getMarvinDataDir(), "wakeups", `${projectId}.json`),
  /** Per-session agent-edit checkpoint store (ADR-0034). */
  checkpointsDir: (projectId: string, marvinSessionId: string) =>
    join(getMarvinDataDir(), "checkpoints", projectId, marvinSessionId),
} as const;

/** Ensure the parent directory of a file exists. Safe to call on every write. */
export function ensureDir(path: string): void {
  const dir = path.endsWith("/") ? path : path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Audit 🟡 #12: ~/.marvin/ contains auth-config.json, projects.json,
    // sessions/, cost-tracker.json — secret-bearing files that
    // shouldn't be readable by other users on the same machine.
    // Default mkdir mode is 0755 (group + world read); tighten to
    // 0700 on creation. Best-effort: chmod may not stick on some
    // filesystems but we don't fail the write if it doesn't.
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* non-fatal */
    }
  }
}

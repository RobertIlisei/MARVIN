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

import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

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
} as const;

/** Ensure the parent directory of a file exists. Safe to call on every write. */
export function ensureDir(path: string): void {
  const dir = path.endsWith("/") ? path : path.substring(0, path.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

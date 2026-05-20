/**
 * Project registry for MARVIN.
 *
 * Persists the user's registered projects (display name + absolute workDir)
 * plus a pointer to the active one. Both files live under the MARVIN data
 * dir (default `~/.marvin/`):
 *
 *   projects.json         – list of registered projects
 *   active-project.json   – `{ projectId }` — optional; the client mirrors
 *                           this in localStorage so we don't race.
 *
 * `projectId` is a stable slug derived from the workDir path at add time.
 * That matches the slug the `/api/chat` route was already using, so session
 * transcripts keep working across the upgrade without a migration.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { ensureDir, marvinPaths } from "./paths";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Absolute path to the project working directory. */
  workDir: string;
  createdAt: string;
  /** ISO timestamp of the last time the project was used for a chat turn. */
  lastUsedAt: string | null;
}

interface ProjectsFileShape {
  projects: ProjectRecord[];
}

interface ActiveProjectShape {
  projectId: string | null;
}

export function slugifyWorkDir(workDir: string): string {
  const resolved = resolve(workDir);
  return (
    resolved.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() ||
    "default"
  );
}

function readProjectsFile(): ProjectsFileShape {
  const path = marvinPaths.projects();
  if (!existsSync(path)) return { projects: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ProjectsFileShape;
    if (!parsed || !Array.isArray(parsed.projects)) return { projects: [] };
    return parsed;
  } catch {
    return { projects: [] };
  }
}

function writeProjectsFile(data: ProjectsFileShape): void {
  const path = marvinPaths.projects();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function readActiveFile(): ActiveProjectShape {
  const path = marvinPaths.activeProject();
  if (!existsSync(path)) return { projectId: null };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ActiveProjectShape;
    if (!parsed || typeof parsed !== "object") return { projectId: null };
    return { projectId: parsed.projectId ?? null };
  } catch {
    return { projectId: null };
  }
}

function writeActiveFile(data: ActiveProjectShape): void {
  const path = marvinPaths.activeProject();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export function listProjects(): ProjectRecord[] {
  const file = readProjectsFile();
  // Newest-used first, falling back to createdAt for never-used entries.
  return [...file.projects].sort((a, b) => {
    const aLast = a.lastUsedAt ?? a.createdAt;
    const bLast = b.lastUsedAt ?? b.createdAt;
    return bLast.localeCompare(aLast);
  });
}

/**
 * Validate that `raw` is a workDir belonging to a registered project.
 * Mutating routes that take a workDir from the client (skills, plugin
 * manifest, etc.) MUST call this before writing — otherwise a caller
 * who slips past CSRF could pass any absolute path and we'd write
 * `.marvin/` inside it. ADR-0024 makes `<workDir>/.marvin/` a sanctioned
 * project-local storage location, but only for projects the user has
 * explicitly opened.
 *
 * Returns the canonical workDir on success, or an error result the
 * caller turns into a 4xx response. Comparison is done on resolved
 * absolute paths so `/foo/bar`, `/foo/bar/`, `/foo/./bar` all match
 * an entry recorded as `/foo/bar`.
 */
export type ValidateProjectCwdResult =
  | { ok: true; workDir: string }
  | { ok: false; status: number; error: string };

export function validateProjectCwd(raw: unknown): ValidateProjectCwdResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, status: 400, error: "workDir is required" };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, status: 400, error: "workDir must be an absolute path" };
  }
  const resolved = resolve(raw);
  const projects = listProjects();
  const match = projects.find((p) => resolve(p.workDir) === resolved);
  if (!match) {
    // Don't leak the registered project list — same 403 for "not a
    // project" as for "doesn't exist." The user's UI only ever sends
    // workDirs it got from `GET /api/projects`, so a 403 here means
    // either a stale UI cache or a hostile client.
    return {
      ok: false,
      status: 403,
      error: "workDir is not a registered project",
    };
  }
  return { ok: true, workDir: resolved };
}

export function getProject(id: string): ProjectRecord | null {
  return readProjectsFile().projects.find((p) => p.id === id) ?? null;
}

export interface AddProjectInput {
  name?: string;
  workDir: string;
}

export function addProject(input: AddProjectInput): ProjectRecord {
  const workDir = resolve(input.workDir);
  if (!workDir) {
    throw new Error("workDir is required");
  }
  const id = slugifyWorkDir(workDir);
  const now = new Date().toISOString();
  const file = readProjectsFile();
  const existing = file.projects.find((p) => p.id === id);
  if (existing) {
    // Update name if the caller supplied a better one; treat as touch.
    if (input.name?.trim() && input.name.trim() !== existing.name) {
      existing.name = input.name.trim();
    }
    existing.lastUsedAt = now;
    writeProjectsFile(file);
    return existing;
  }
  const record: ProjectRecord = {
    id,
    name: (input.name?.trim()) || basename(workDir) || id,
    workDir,
    createdAt: now,
    lastUsedAt: null,
  };
  file.projects.push(record);
  writeProjectsFile(file);
  return record;
}

export function removeProject(id: string): boolean {
  const file = readProjectsFile();
  const before = file.projects.length;
  file.projects = file.projects.filter((p) => p.id !== id);
  if (file.projects.length === before) return false;
  writeProjectsFile(file);
  const active = readActiveFile();
  if (active.projectId === id) {
    writeActiveFile({ projectId: null });
  }
  return true;
}

/** Bump lastUsedAt to now. Called by the chat route on every successful turn. */
export function touchProject(id: string): void {
  const file = readProjectsFile();
  const hit = file.projects.find((p) => p.id === id);
  if (!hit) return;
  hit.lastUsedAt = new Date().toISOString();
  writeProjectsFile(file);
}

export function getActiveProjectId(): string | null {
  return readActiveFile().projectId;
}

export function setActiveProjectId(id: string | null): void {
  writeActiveFile({ projectId: id });
}

export interface VerifyWorkDirResult {
  ok: boolean;
  absolutePath: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  error: string | null;
}

export function verifyWorkDir(rawPath: string): VerifyWorkDirResult {
  const absolutePath = resolve(rawPath);
  const out: VerifyWorkDirResult = {
    ok: false,
    absolutePath,
    exists: false,
    isDirectory: false,
    readable: false,
    error: null,
  };
  try {
    if (!existsSync(absolutePath)) {
      out.error = "Path does not exist.";
      return out;
    }
    out.exists = true;
    const st = statSync(absolutePath);
    if (!st.isDirectory()) {
      out.error = "Path is not a directory.";
      return out;
    }
    out.isDirectory = true;
    // readFileSync on a directory throws EISDIR, but the stat alone is enough
    // to prove we can traverse it. `readable` mirrors `isDirectory` for now.
    out.readable = true;
    out.ok = true;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

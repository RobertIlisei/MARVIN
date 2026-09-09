/**
 * Per-session metadata (ADR-0107) — the tree a chat session runs in and the
 * posture its turns use, persisted NEXT TO the transcript it belongs to:
 *
 *   <dataDir>/sessions/<projectId>/<sessionId>.meta.json
 *
 * Same file discipline as `plan-state.ts` (ADR-0052): identity whitelist,
 * atomic tmp+rename, a small size cap, and a corrupt file reads as "nothing
 * stored" so it can never brick a turn.
 *
 * Why a sidecar file and not a field on the transcript: the transcript is
 * append-only JSONL and the tree can change mid-session (a tab switched from
 * its worktree to the shared checkout). A mutable record beside it is the
 * shape that already exists for plan state.
 *
 * `projectId` stays the PROJECT. Only `tree` — hence the cwd a turn runs in —
 * varies per session. Transcripts, cost, wakeups and checkpoints remain keyed
 * by project (see the research note under docs/research, 2026-09-09).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { marvinPaths } from "./paths";

export const SESSION_META_MAX_BYTES = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

/** Which checkout a session's turns run in. */
export type SessionTree =
  | {
      mode: "worktree";
      slug: string;
      /** Absolute path of the session's checkout. */
      path: string;
      branch: string;
      /** Commit the branch was cut from. */
      base: string;
    }
  | {
      mode: "shared";
      /** Repo-relative path prefixes this tab owns (ADR-0107 lanes). */
      lane?: string[];
    };

/** The model / permission posture a session's turns run with. Captured on
 *  every turn start so a server-initiated resume can rebuild the turn exactly. */
export interface SessionPosture {
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral" | "ultron";
  permissionStrategy: "auto" | "gated";
  playwrightEnabled?: boolean;
  thinkingMode: string;
  advisorThinkingMode?: string;
  mode?: "agent" | "ask" | "plan";
}

export interface SessionLastTurn {
  turnId: string;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "error" | "interrupted";
  error?: string;
}

export interface SessionMeta {
  version: 1;
  marvinSessionId: string;
  projectId: string;
  /** The project root — never the worktree. */
  workDir: string;
  createdAt: string;
  updatedAt: string;
  tree: SessionTree;
  posture: SessionPosture;
  title?: string;
  lastTurn?: SessionLastTurn;
  /** Set when the tab was closed through `/api/sessions/close`. */
  closedAt?: string;
}

export function sessionMetaPath(projectId: string, sessionId: string): string {
  return marvinPaths.sessionMetaFile(projectId, sessionId);
}

export function readSessionMeta(projectId: string, sessionId: string): SessionMeta | null {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return null;
  const p = sessionMetaPath(projectId, sessionId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<SessionMeta>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    if (!parsed.tree || !parsed.posture || typeof parsed.workDir !== "string") return null;
    return parsed as SessionMeta;
  } catch {
    // A corrupt file must not brick a turn — the caller treats "no meta" as
    // a shared-tree session with the posture the request carries.
    return null;
  }
}

export type WriteSessionMetaResult = { ok: true } | { ok: false; error: string };

export function writeSessionMeta(meta: SessionMeta): WriteSessionMetaResult {
  if (!isSafeId(meta.projectId) || !isSafeId(meta.marvinSessionId)) {
    return { ok: false, error: "invalid projectId or sessionId" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(meta, null, 2);
  } catch {
    return { ok: false, error: "meta is not serializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") > SESSION_META_MAX_BYTES) {
    return { ok: false, error: `meta exceeds ${SESSION_META_MAX_BYTES} bytes` };
  }
  const p = sessionMetaPath(meta.projectId, meta.marvinSessionId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${serialized}\n`, "utf8");
    renameSync(tmp, p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/**
 * Create-or-merge. A missing record is created from `seed` (the fields a
 * turn start always knows); an existing one gets `patch` merged over it.
 * `updatedAt` is stamped on every write.
 */
export function upsertSessionMeta(
  projectId: string,
  sessionId: string,
  seed: { workDir: string; tree: SessionTree; posture: SessionPosture },
  patch: Partial<Omit<SessionMeta, "version" | "marvinSessionId" | "projectId" | "createdAt">> = {},
): SessionMeta | null {
  const now = new Date().toISOString();
  const existing = readSessionMeta(projectId, sessionId);
  const next: SessionMeta = existing
    ? { ...existing, ...patch, updatedAt: now }
    : {
        version: 1,
        marvinSessionId: sessionId,
        projectId,
        workDir: seed.workDir,
        createdAt: now,
        updatedAt: now,
        tree: seed.tree,
        posture: seed.posture,
        ...patch,
      };
  const res = writeSessionMeta(next);
  return res.ok ? next : null;
}

/** Patch an existing record only; a missing record is left missing. */
export function updateSessionMeta(
  projectId: string,
  sessionId: string,
  patch: Partial<Omit<SessionMeta, "version" | "marvinSessionId" | "projectId" | "createdAt">>,
): SessionMeta | null {
  const existing = readSessionMeta(projectId, sessionId);
  if (!existing) return null;
  const next: SessionMeta = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  return writeSessionMeta(next).ok ? next : null;
}

export function listSessionMetas(projectId: string): SessionMeta[] {
  if (!isSafeId(projectId)) return [];
  const dir = marvinPaths.sessionsDir(projectId);
  if (!existsSync(dir)) return [];
  const out: SessionMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".meta.json")) continue;
    const sessionId = name.slice(0, -".meta.json".length);
    const meta = readSessionMeta(projectId, sessionId);
    if (meta) out.push(meta);
  }
  return out;
}

/** The cwd a session's turns should run in, and whether it is on disk. */
export function resolveSessionCwd(meta: SessionMeta): { cwd: string; present: boolean } {
  if (meta.tree.mode === "worktree") {
    return { cwd: meta.tree.path, present: existsSync(meta.tree.path) };
  }
  return { cwd: meta.workDir, present: existsSync(meta.workDir) };
}

/** Lane entries are repo-relative prefixes: normalised, no `..`, no leading
 *  `/`, deduplicated, capped. `null` when the input is not a usable list. */
export function normaliseLane(lane: unknown): string[] | null {
  if (!Array.isArray(lane)) return null;
  const out: string[] = [];
  for (const raw of lane) {
    if (typeof raw !== "string") continue;
    let s = raw.trim().replace(/\\/g, "/");
    if (!s) continue;
    if (s.startsWith("/")) return null;
    s = posix.normalize(s).replace(/\/+$/, "");
    if (s === "" || s === "." ) {
      s = ".";
    } else if (s === ".." || s.startsWith("../") || s.includes("/../")) {
      return null;
    }
    if (!out.includes(s)) out.push(s);
    if (out.length >= 32) break;
  }
  return out;
}

/** Test seam: the directory a project's metas live in. */
export function sessionMetaDir(projectId: string): string {
  return join(marvinPaths.sessionsDir(projectId));
}

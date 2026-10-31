/**
 * Follows — the runtime-held record of "tell me how X goes" (ADR-0128 §5,
 * plan milestone [7.3]).
 *
 * A follow names a tab, what it waits for (`scope-met`, or `merge-ready`: the
 * user asked for the merge too) and the user message that asked for it. While
 * it is open, a wake started by one of that tab's EXISTING triggers may report
 * into the conversation. A follow adds no wake trigger, no read authority and
 * no delegation: it is the record, so the supervisor never has to remember.
 *
 * - **Event-sourced, append-only.** `<MARVIN_DATA_DIR>/supervisor/<projectId>/follows.jsonl`
 *   beside the inbox: `O_APPEND`, fsync, 0600, never the project's `.marvin/`.
 *   The newest line per id is the follow.
 * - **Validated where it is read.** The file sits next to stores a tab's
 *   transcript content reaches, so every line is checked field by field and a
 *   line that does not fit is skipped, never coerced.
 * - **Capped.** At most {@link MAX_OPEN_FOLLOWS} open per project; at the cap a
 *   new follow is refused with the open ones listed. None is evicted silently.
 * - **The feed** carries ids and states only (`supervisor.follow`).
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";
import { announceProjectEvent } from "./turn-registry";

export const FOLLOW_UNTIL = ["scope-met", "merge-ready"] as const;
export type FollowUntil = (typeof FOLLOW_UNTIL)[number];

/** What ended a follow: the scope-met review, the merge settled or dismissed, the tab closed, the verb, or the user's chip. */
export const FOLLOW_ENDS = ["scope-met", "merge-settled", "merge-dismissed", "closed", "unfollow", "user"] as const;
export type FollowEnd = (typeof FOLLOW_ENDS)[number];

export interface FollowRecord {
  id: string;
  revision: number;
  createdAt: string;
  sessionId: string;
  until: FollowUntil;
  /** The user message that asked for it (ADR-0128 §2's request). */
  requestId: string;
  state: "open" | "ended";
  endedAt: string | null;
  endedBy: FollowEnd | null;
}

/** ADR-0128 §5 — open follows per project. */
export const MAX_OPEN_FOLLOWS = 5;
/** ADR-0128 §2 — how long a user message stays a request a follow may cite. */
export const REQUEST_WINDOW_MS = 24 * 60 * 60_000;

const MAX_LINE_CHARS = 4_096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function followsPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "follows.jsonl");
}

const isTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

/** One line's follow, or null when any field is not what this module writes. */
export function parseFollowLine(line: string): FollowRecord | null {
  if (line.length > MAX_LINE_CHARS) return null;
  let raw: unknown;
  try {
    raw = (JSON.parse(line) as { follow?: unknown }).follow;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !ID_RE.test(f.id)) return null;
  if (typeof f.sessionId !== "string" || !SESSION_RE.test(f.sessionId)) return null;
  if (typeof f.requestId !== "string" || !ID_RE.test(f.requestId)) return null;
  if (!(FOLLOW_UNTIL as readonly unknown[]).includes(f.until)) return null;
  if (f.state !== "open" && f.state !== "ended") return null;
  if (typeof f.revision !== "number" || !Number.isInteger(f.revision) || f.revision < 1) return null;
  if (!isTime(f.createdAt)) return null;
  const ended = f.state === "ended";
  if (ended ? !isTime(f.endedAt) || !(FOLLOW_ENDS as readonly unknown[]).includes(f.endedBy) : f.endedAt !== null || f.endedBy !== null) return null;
  return {
    id: f.id,
    revision: f.revision,
    createdAt: f.createdAt,
    sessionId: f.sessionId,
    until: f.until as FollowUntil,
    requestId: f.requestId,
    state: f.state,
    endedAt: ended ? (f.endedAt as string) : null,
    endedBy: ended ? (f.endedBy as FollowEnd) : null,
  };
}

const cache = new Map<string, { size: number; mtimeMs: number; follows: Map<string, FollowRecord> }>();

function load(projectId: string): Map<string, FollowRecord> {
  const p = followsPath(projectId);
  if (!existsSync(p)) return new Map();
  const st = statSync(p);
  const hit = cache.get(p);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.follows;
  const follows = new Map<string, FollowRecord>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const f = parseFollowLine(line);
    if (f) follows.set(f.id, f);
  }
  cache.set(p, { size: st.size, mtimeMs: st.mtimeMs, follows });
  return follows;
}

function write(projectId: string, rec: FollowRecord): FollowRecord {
  ensureSupervisorDir(projectId);
  const p = followsPath(projectId);
  const fd = openSync(p, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), follow: rec })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  cache.delete(p);
  try {
    announceProjectEvent({ event: "supervisor.follow", data: { projectId, id: rec.id, sessionId: rec.sessionId, state: rec.state } });
  } catch {
    /* the follow stands; only the notification is lost */
  }
  return rec;
}

/** Follows, oldest first. */
export function listFollows(projectId: string, opts: { state?: FollowRecord["state"]; sessionId?: string } = {}): FollowRecord[] {
  return [...load(projectId).values()]
    .filter((f) => (opts.state === undefined || f.state === opts.state) && (opts.sessionId === undefined || f.sessionId === opts.sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function getFollow(projectId: string, id: string): FollowRecord | null {
  return load(projectId).get(id) ?? null;
}

export type OpenFollowResult = { ok: true; follow: FollowRecord; created: boolean } | { ok: false; code: "cap"; open: FollowRecord[] };

/**
 * Open a follow on a tab. A tab has at most one open follow: asking again
 * updates what it waits for (the newest request wins). At the cap, refused
 * with the open follows, so the reply can list them with their chips.
 */
export function openFollow(projectId: string, a: { sessionId: string; until: FollowUntil; requestId: string }): OpenFollowResult {
  const open = listFollows(projectId, { state: "open" });
  const same = open.find((f) => f.sessionId === a.sessionId);
  if (same) {
    if (same.until === a.until && same.requestId === a.requestId) return { ok: true, follow: same, created: false };
    return { ok: true, follow: write(projectId, { ...same, until: a.until, requestId: a.requestId, revision: same.revision + 1 }), created: false };
  }
  if (open.length >= MAX_OPEN_FOLLOWS) return { ok: false, code: "cap", open };
  const rec: FollowRecord = {
    id: randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    sessionId: a.sessionId,
    until: a.until,
    requestId: a.requestId,
    state: "open",
    endedAt: null,
    endedBy: null,
  };
  return { ok: true, follow: write(projectId, rec), created: true };
}

/** End an open follow. Null when it is gone or already ended — ending is once. */
export function endFollow(projectId: string, id: string, endedBy: FollowEnd): FollowRecord | null {
  const cur = getFollow(projectId, id);
  if (!cur || cur.state !== "open") return null;
  return write(projectId, { ...cur, state: "ended", endedAt: new Date().toISOString(), endedBy, revision: cur.revision + 1 });
}

/** End every open follow the predicate picks. */
export function endFollows(projectId: string, pick: (f: FollowRecord) => boolean, endedBy: FollowEnd): number {
  let n = 0;
  for (const f of listFollows(projectId, { state: "open" })) if (pick(f) && endFollow(projectId, f.id, endedBy)) n += 1;
  return n;
}

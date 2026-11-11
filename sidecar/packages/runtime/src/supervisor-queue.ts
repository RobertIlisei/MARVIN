/**
 * The approved queue's store (ADR-0133).
 *
 * A queue is a list of briefs the USER approved as a list; the runtime opens
 * them as slots free (`supervisor-queue-opener.ts`). This module is the one
 * place the list, the cap and the guard command are read and written.
 *
 * - **Where it lives.** `<MARVIN_DATA_DIR>/supervisor/<projectId>/queue.json`
 *   — the supervisor dir, which a tab cannot reach (`supervisor-boundary.ts`).
 *   Never the project's `.marvin/`: a repository can write that, and this file
 *   holds the user's authority to open tabs and a command the runtime executes.
 * - **Only the user's click approves.** An entry is written by `approveEntries`
 *   alone, which the inbox consent calls with the user's authority. `readQueue`
 *   drops anything without `approvedBy: "user"` and a valid `approvedAt`, so a
 *   hand-edited or model-written line never reaches the opener.
 * - **The supervisor's narrow powers** are here too, each ledgered by its verb:
 *   lower the cap and restore it, hold one entry with a reason. It cannot
 *   raise the cap, reorder, approve, or open.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type PosturePatch, validatePosturePatch } from "./posture";
import { containsSecretShape } from "./session";
import type { SessionPosture } from "./session-meta";
import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";
import { MAX_SUPERVISOR_MESSAGE_CHARS } from "./supervisor-send";
import { announceProjectEvent } from "./turn-registry";

export const QUEUE_EXPIRY_MS = 7 * 24 * 3600 * 1000;
export const DEFAULT_QUEUE_CAP = 1;
export const MAX_QUEUE_CAP = 20;
export const MAX_QUEUE_ENTRIES = 50;
export const MAX_PROPOSAL_ENTRIES = 20;
export const MAX_GUARD_CHARS = 1000;
export const MAX_HOLD_REASON_CHARS = 300;
/** A queue of more than this many entries with none carrying a `scopeRef` shows a warning on its card (ADR-0133 open question 3). */
export const SCOPE_REF_WARN_ABOVE = 5;

const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface QueueScopeRef {
  /** A path in the project's own plan document, relative to the project root. */
  path: string;
  /** The heading the entry's id must still appear under. */
  heading: string;
}

/** What the supervisor proposes and the card shows. Nothing here is consent. */
export interface QueueEntryProposal {
  id: string;
  title: string;
  brief: string;
  /** The full posture the tab opens at: the approved one, never wider. */
  posture: SessionPosture;
  /** Posture dimensions wider than the base tab's — the card marks each. */
  wider: string[];
  after?: string[];
  scopeRef?: QueueScopeRef;
}

export type QueueEntryStatus = "queued" | "opening" | "opened" | "expired" | "removed" | "failed";

/** Why an entry is not opening right now — the runtime's last evaluation, for the workspace. */
export interface QueueBlock {
  code: string;
  reason: string;
  at: string;
}

export interface QueueEntry extends QueueEntryProposal {
  approvedAt: string;
  approvedBy: "user";
  status: QueueEntryStatus;
  openedAt?: string;
  openedSessionId?: string;
  /** The branch of the tab this entry opened; `after` reads its DERIVED state (ADR-0103). */
  openedBranch?: string;
  /** The supervisor's hold: it may hold, never release (the user does). */
  hold?: { reason: string; at: string };
  blocked?: QueueBlock | null;
}

export interface QueueGuard {
  command: string;
  approvedAt: string;
  approvedBy: "user";
}

export interface QueueFile {
  version: 1;
  /** The user's cap. */
  cap: number;
  /** The supervisor lowered the cap for an alarm; effective = min(cap, to). */
  capLowered: { from: number; to: number; reason: string; at: string } | null;
  guard: QueueGuard | null;
  /** The guard's last run, for the workspace. */
  guardLast: { at: string; ok: boolean; exitCode: number | null; timedOut: boolean } | null;
  entries: QueueEntry[];
}

export const emptyQueue = (): QueueFile => ({ version: 1, cap: DEFAULT_QUEUE_CAP, capLowered: null, guard: null, guardLast: null, entries: [] });

export function queuePath(projectId: string): string {
  return path.join(supervisorDir(projectId), "queue.json");
}

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function effectiveCap(q: QueueFile): number {
  return q.capLowered ? Math.min(q.cap, q.capLowered.to) : q.cap;
}

function readScopeRef(v: unknown): QueueScopeRef | undefined {
  const o = asRecord(v);
  if (!o || !isStr(o.path, 200) || !isStr(o.heading, 200)) return undefined;
  return { path: o.path, heading: o.heading };
}

/**
 * One entry as stored. An entry without the user's approval is not an entry:
 * `approvedBy` must be exactly "user" with a real `approvedAt`, and every
 * other field is re-checked, because a file in a data dir is still a file.
 */
function readEntry(raw: unknown): QueueEntry | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (o.approvedBy !== "user" || !isIso(o.approvedAt)) return null;
  if (typeof o.id !== "string" || !ENTRY_ID_RE.test(o.id) || !isStr(o.title, 120) || !isStr(o.brief, MAX_SUPERVISOR_MESSAGE_CHARS)) return null;
  const posture = asRecord(o.posture);
  if (!posture || typeof posture.model !== "string") return null;
  const status = o.status;
  if (status !== "queued" && status !== "opening" && status !== "opened" && status !== "expired" && status !== "removed" && status !== "failed") return null;
  const after = Array.isArray(o.after) ? o.after.filter((x): x is string => typeof x === "string" && ENTRY_ID_RE.test(x)).slice(0, 10) : [];
  const scopeRef = readScopeRef(o.scopeRef);
  const hold = asRecord(o.hold);
  const blocked = asRecord(o.blocked);
  return {
    id: o.id,
    title: o.title,
    brief: o.brief,
    posture: posture as unknown as SessionPosture,
    wider: Array.isArray(o.wider) ? o.wider.filter((x): x is string => typeof x === "string").slice(0, 8) : [],
    ...(after.length ? { after } : {}),
    ...(scopeRef ? { scopeRef } : {}),
    approvedAt: o.approvedAt,
    approvedBy: "user",
    status,
    ...(isIso(o.openedAt) ? { openedAt: o.openedAt } : {}),
    ...(typeof o.openedSessionId === "string" ? { openedSessionId: o.openedSessionId } : {}),
    ...(typeof o.openedBranch === "string" ? { openedBranch: o.openedBranch } : {}),
    ...(hold && isStr(hold.reason, MAX_HOLD_REASON_CHARS) && isIso(hold.at) ? { hold: { reason: hold.reason, at: hold.at } } : {}),
    ...(blocked && typeof blocked.code === "string" && typeof blocked.reason === "string" && isIso(blocked.at) ? { blocked: { code: blocked.code, reason: blocked.reason.slice(0, 400), at: blocked.at } } : {}),
  };
}

/** The queue, validated at the read boundary. A missing or corrupt file is an empty queue. */
export function readQueue(projectId: string): QueueFile {
  const p = queuePath(projectId);
  if (!existsSync(p)) return emptyQueue();
  let raw: Record<string, unknown> | null;
  try {
    raw = asRecord(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return emptyQueue();
  }
  if (!raw) return emptyQueue();
  const cap = typeof raw.cap === "number" && Number.isInteger(raw.cap) && raw.cap >= 0 && raw.cap <= MAX_QUEUE_CAP ? raw.cap : DEFAULT_QUEUE_CAP;
  const lowered = asRecord(raw.capLowered);
  const guard = asRecord(raw.guard);
  const last = asRecord(raw.guardLast);
  const seen = new Set<string>();
  const entries: QueueEntry[] = [];
  for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
    const entry = readEntry(e);
    if (!entry || seen.has(entry.id) || entries.length >= MAX_QUEUE_ENTRIES * 4) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return {
    version: 1,
    cap,
    capLowered:
      lowered && Number.isInteger(lowered.to) && Number.isInteger(lowered.from) && isIso(lowered.at) && typeof lowered.reason === "string"
        ? { from: lowered.from as number, to: lowered.to as number, reason: lowered.reason.slice(0, MAX_HOLD_REASON_CHARS), at: lowered.at }
        : null,
    // A command counts only with the user's approval recorded beside it.
    guard: guard && isStr(guard.command, MAX_GUARD_CHARS) && guard.approvedBy === "user" && isIso(guard.approvedAt) ? { command: guard.command, approvedAt: guard.approvedAt, approvedBy: "user" } : null,
    guardLast:
      last && isIso(last.at) && typeof last.ok === "boolean"
        ? { at: last.at, ok: last.ok, exitCode: typeof last.exitCode === "number" ? last.exitCode : null, timedOut: last.timedOut === true }
        : null,
    entries,
  };
}

function writeQueue(projectId: string, q: QueueFile, change: string): void {
  const dir = ensureSupervisorDir(projectId);
  const file = path.join(dir, "queue.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    announceProjectEvent({ event: "supervisor.queue", data: { projectId, change } });
  } catch {
    /* the file stands; only the notification is lost */
  }
}

/** Read, change, write — synchronous, so two callers in one process cannot interleave. */
export function updateQueue(projectId: string, change: string, fn: (q: QueueFile) => void): QueueFile {
  const q = readQueue(projectId);
  fn(q);
  writeQueue(projectId, q, change);
  return q;
}

// ── The user's acts ─────────────────────────────────────────────────────────

/** Entries the queue still holds: not opened, expired, removed or failed. */
export const isPending = (e: QueueEntry) => e.status === "queued" || e.status === "opening";

/**
 * The user approved these entries (the card's click). The ONLY writer of an
 * entry; `approvedBy` is set here and nowhere else. Order is the proposal's.
 */
export function approveEntries(projectId: string, entries: readonly QueueEntryProposal[], now = new Date()): { ok: true; added: number } | { ok: false; error: string } {
  const q = readQueue(projectId);
  const live = q.entries.filter((e) => e.status !== "removed" && e.status !== "expired");
  if (live.length + entries.length > MAX_QUEUE_ENTRIES) return { ok: false, error: `a queue holds at most ${MAX_QUEUE_ENTRIES} entries` };
  const known = new Set(q.entries.map((e) => e.id));
  for (const e of entries) if (known.has(e.id)) return { ok: false, error: `an entry named "${e.id}" is already in the queue` };
  const ids = new Set([...known, ...entries.map((e) => e.id)]);
  for (const e of entries) {
    for (const a of e.after ?? []) if (!ids.has(a)) return { ok: false, error: `"${e.id}" comes after "${a}", which is not in the queue — approve it with the list` };
  }
  const at = now.toISOString();
  updateQueue(projectId, "approved", (f) => {
    for (const e of entries) f.entries.push({ ...e, approvedAt: at, approvedBy: "user", status: "queued" });
  });
  return { ok: true, added: entries.length };
}

/** The user's cap (`POST /api/supervisor/queue`). */
export function setUserCap(projectId: string, cap: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > MAX_QUEUE_CAP) return { ok: false, error: `the cap is a whole number from 0 to ${MAX_QUEUE_CAP}` };
  updateQueue(projectId, "cap", (q) => {
    q.cap = cap;
  });
  return { ok: true };
}

/** The user approved this guard command on a card showing it in full. A changed text is a new approval. */
export function setGuard(projectId: string, command: string, now = new Date()): void {
  updateQueue(projectId, "guard", (q) => {
    q.guard = { command, approvedAt: now.toISOString(), approvedBy: "user" };
    q.guardLast = null;
  });
}

export function clearGuard(projectId: string): void {
  updateQueue(projectId, "guard", (q) => {
    q.guard = null;
    q.guardLast = null;
  });
}

/** The user lifts a hold or retries a failed entry. */
export function releaseEntry(projectId: string, id: string): boolean {
  let done = false;
  updateQueue(projectId, "released", (q) => {
    const e = q.entries.find((x) => x.id === id);
    if (e && (e.status === "queued" || e.status === "failed" || e.status === "opening")) {
      delete e.hold;
      e.status = "queued";
      e.blocked = null;
      done = true;
    }
  });
  return done;
}

export function removeEntry(projectId: string, id: string): boolean {
  let done = false;
  updateQueue(projectId, "removed", (q) => {
    const e = q.entries.find((x) => x.id === id);
    if (e && e.status !== "opened" && e.status !== "removed") {
      e.status = "removed";
      done = true;
    }
  });
  return done;
}

// ── The supervisor's narrow powers (each ledgered by its verb) ──────────────

/** Lower the cap for an alarm. Raising — or a no-op — is refused. */
export function lowerCap(projectId: string, to: unknown, reason: string, now = new Date()): { ok: true; from: number; to: number } | { ok: false; error: string } {
  const q = readQueue(projectId);
  const cur = effectiveCap(q);
  if (typeof to !== "number" || !Number.isInteger(to) || to < 0) return { ok: false, error: "the cap is a whole number, 0 or more" };
  if (to >= cur) return { ok: false, error: `the cap is ${cur}; the supervisor may lower it, never raise it` };
  updateQueue(projectId, "cap-lowered", (f) => {
    f.capLowered = { from: f.capLowered?.from ?? f.cap, to, reason: reason.slice(0, MAX_HOLD_REASON_CHARS), at: now.toISOString() };
  });
  return { ok: true, from: cur, to };
}

/** Put the cap back to the user's number. */
export function restoreCap(projectId: string): { ok: true; cap: number } | { ok: false; error: string } {
  const q = readQueue(projectId);
  if (!q.capLowered) return { ok: false, error: "the cap is not lowered — nothing to restore" };
  updateQueue(projectId, "cap-restored", (f) => {
    f.capLowered = null;
  });
  return { ok: true, cap: q.cap };
}

/** The supervisor holds an entry, with a reason. It cannot release one. */
export function holdEntry(projectId: string, id: string, reason: string, now = new Date()): { ok: true } | { ok: false; error: string } {
  const q = readQueue(projectId);
  const e = q.entries.find((x) => x.id === id);
  if (!e || e.status !== "queued") return { ok: false, error: `no queued entry "${id}"` };
  updateQueue(projectId, "held", (f) => {
    const t = f.entries.find((x) => x.id === id);
    if (t) t.hold = { reason: reason.slice(0, MAX_HOLD_REASON_CHARS), at: now.toISOString() };
  });
  return { ok: true };
}

// ── The proposal (what the supervisor writes) ───────────────────────────────

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export interface RawProposalEntry {
  id?: unknown;
  title?: unknown;
  brief?: unknown;
  posture?: unknown;
  after?: unknown;
  scopeRef?: unknown;
}

/**
 * Check what the supervisor proposed and turn it into entries the card lists.
 * Writes nothing: a proposal is a card, and only the user's click on it makes
 * entries. `base` is the posture a tab would start from; an entry's own patch
 * may differ from it and the card marks the wider dimensions.
 */
export function buildProposal(
  projectId: string,
  raw: readonly RawProposalEntry[],
  base: SessionPosture,
  widerOf: (patch: PosturePatch) => string[],
): { ok: true; entries: QueueEntryProposal[]; warnings: string[]; dedupeKey: string } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PROPOSAL_ENTRIES) return { ok: false, error: `a proposal lists 1–${MAX_PROPOSAL_ENTRIES} entries` };
  const q = readQueue(projectId);
  const taken = new Set(q.entries.filter((e) => e.status !== "removed" && e.status !== "expired").map((e) => e.id));
  const ids = new Set<string>(taken);
  const entries: QueueEntryProposal[] = [];
  const own = new Set<string>();
  for (const r of raw) {
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!ENTRY_ID_RE.test(id)) return { ok: false, error: `an entry id is 1–40 characters of letters, digits, ".", "_" or "-" (got ${JSON.stringify(r.id)})` };
    if (taken.has(id) || own.has(id)) return { ok: false, error: `the id "${id}" is already used` };
    own.add(id);
    ids.add(id);
  }
  for (const r of raw) {
    const id = String(r.id).trim();
    const title = typeof r.title === "string" ? r.title.trim().slice(0, 120) : "";
    const brief = typeof r.brief === "string" ? r.brief.trim() : "";
    if (!title) return { ok: false, error: `entry "${id}" needs a title` };
    if (!brief || brief.length > MAX_SUPERVISOR_MESSAGE_CHARS) return { ok: false, error: `entry "${id}": the brief needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters` };
    if (containsSecretShape(brief) || containsSecretShape(title)) return { ok: false, error: `entry "${id}" carries a secret-shaped string (ADR-0127 §6)` };
    const valid = r.posture && typeof r.posture === "object" && Object.keys(r.posture).length ? validatePosturePatch(r.posture) : { ok: true as const, patch: {} };
    if (!valid.ok) return { ok: false, error: `entry "${id}": ${valid.error}` };
    const patch = valid.patch;
    const posture: SessionPosture = {
      ...base,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinkingMode !== undefined ? { thinkingMode: patch.thinkingMode } : {}),
      ...(patch.permissionStrategy !== undefined ? { permissionStrategy: patch.permissionStrategy } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    };
    let after: string[] | undefined;
    if (r.after !== undefined) {
      if (!Array.isArray(r.after) || r.after.length > 10 || (r.after as unknown[]).some((a) => typeof a !== "string" || !ids.has(a) || a === id)) {
        return { ok: false, error: `entry "${id}": \`after\` names other entries of the queue, at most 10` };
      }
      after = [...new Set(r.after as string[])];
    }
    let scopeRef: QueueScopeRef | undefined;
    if (r.scopeRef !== undefined) {
      scopeRef = readScopeRef(r.scopeRef);
      const p = scopeRef?.path ?? "";
      if (!scopeRef || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
        return { ok: false, error: `entry "${id}": scopeRef is { path, heading } — a path inside the project, and a heading of its plan document` };
      }
    }
    entries.push({ id, title, brief, posture, wider: widerOf(patch), ...(after?.length ? { after } : {}), ...(scopeRef ? { scopeRef } : {}) });
  }
  const warnings: string[] = [];
  const total = taken.size + entries.length;
  if (total > SCOPE_REF_WARN_ABOVE && !entries.some((e) => e.scopeRef) && !q.entries.some((e) => isPending(e) && e.scopeRef)) {
    warnings.push(`This queue holds ${total} entries and none names a scopeRef — nothing checks any of them against the plan before it opens.`);
  }
  return { ok: true, entries, warnings, dedupeKey: `queue:${digest(entries)}` };
}

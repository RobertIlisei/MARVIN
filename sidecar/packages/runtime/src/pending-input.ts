/**
 * Durable queue for user messages that arrive while a turn is running
 * (ADR-0069).
 *
 * ## The failure this replaces
 *
 * MARVIN runs one turn per session. Machine-initiated turns — scheduled
 * wakeups (ADR-0031), background-job completions (ADR-0038), auto-reconcile
 * (ADR-0057), transport auto-continue (ADR-0067) — occupy that single slot
 * exactly like a human turn. A user message arriving during one was answered
 * with `409 turn-in-progress` and **discarded**.
 *
 * Observed 2026-08-17 (local times): a wakeup fired at 22:19:20, the user sent
 * "Update graphify and check what else needs to be updated" moments later and
 * got a 409, a second wakeup fired at 22:20:13 — and the instruction never ran.
 * Checked against the transcript: 150 `turn.user` records, none of them that
 * message. Two machine turns talked past the human for 76 seconds and the
 * human's input was the only thing thrown away.
 *
 * ## Why disk, not an in-memory array
 *
 * An in-memory queue still loses everything the moment the sidecar restarts —
 * and this app is reinstalled, relaunched and occasionally OOM-killed. A queued
 * instruction is the user's words; it is the one thing in the system that
 * cannot be regenerated. It goes on disk next to the transcript it belongs to,
 * for the same reason plan state does (ADR-0052).
 *
 * ## Staleness is surfaced, never silently applied
 *
 * A turn here routinely runs 5+ minutes. An instruction queued behind one can
 * be moot by the time it drains ("park it as a backlog item" means something
 * different once the context has moved). Entries therefore carry `queuedAt`,
 * and the drained prompt states the age so MARVIN can notice rather than
 * blindly execute stale intent.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";

/** One queued user message. */
export interface PendingMessage {
  id: string;
  /** The user's text, verbatim. Never rewritten. */
  text: string;
  /** Epoch ms when the server accepted it. Drives the staleness note. */
  queuedAt: number;
}

export interface PendingFile {
  messages: PendingMessage[];
}

/**
 * Cap on queued messages per session. Generous — this exists to stop an
 * unbounded file if a client loops, not to ration the user. Past the cap the
 * OLDEST is dropped rather than the newest: if someone is queuing faster than
 * MARVIN drains, their most recent intent is the one that still matters.
 */
export const MAX_PENDING = 20;

/** Same identity alphabet the session store uses — rejects path traversal. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

/** Next to the transcript and the plan state it belongs to (as ADR-0052 does). */
export function pendingPath(projectId: string, sessionId: string): string {
  return join(marvinPaths.sessionsDir(projectId), `${sessionId}.pending.json`);
}

function read(path: string): PendingFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as PendingFile;
    return Array.isArray(raw?.messages) ? { messages: raw.messages } : { messages: [] };
  } catch {
    // A corrupt queue must not wedge the session. Start clean rather than
    // throwing on every subsequent send.
    return { messages: [] };
  }
}

/** Atomic write — a half-written queue would lose messages on the next read. */
function write(path: string, data: PendingFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

export type EnqueueResult =
  | { ok: true; queued: PendingMessage; depth: number }
  | { ok: false; error: string };

export function enqueuePending(
  projectId: string,
  sessionId: string,
  text: string,
  now: number = Date.now(),
): EnqueueResult {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) {
    return { ok: false, error: "invalid session identity" };
  }
  if (!text.trim()) return { ok: false, error: "empty message" };

  const path = pendingPath(projectId, sessionId);
  const file = read(path);
  const msg: PendingMessage = {
    id: `${now}-${file.messages.length}`,
    text,
    queuedAt: now,
  };
  file.messages.push(msg);
  // Drop from the FRONT — newest intent wins over oldest.
  while (file.messages.length > MAX_PENDING) file.messages.shift();
  write(path, file);
  return { ok: true, queued: msg, depth: file.messages.length };
}

export function listPending(projectId: string, sessionId: string): PendingMessage[] {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return [];
  return read(pendingPath(projectId, sessionId)).messages;
}

/** Take everything queued and clear the file, atomically enough for one process. */
export function drainPending(projectId: string, sessionId: string): PendingMessage[] {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return [];
  const path = pendingPath(projectId, sessionId);
  if (!existsSync(path)) return [];
  const file = read(path);
  if (file.messages.length === 0) return [];
  write(path, { messages: [] });
  return file.messages;
}

export function clearPending(projectId: string, sessionId: string): void {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) return;
  write(pendingPath(projectId, sessionId), { messages: [] });
}

/** Anything older than this is called out explicitly when it drains. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

function ageLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins >= 1) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  return `${Math.max(1, Math.round(ms / 1000))}s ago`;
}

/**
 * Turn drained messages into ONE prompt.
 *
 * Coalescing matters: three messages sent while blocked should produce one
 * turn that sees all three, not three sequential turns each acting on partial
 * intent — the later ones frequently supersede the earlier.
 */
export function renderPendingPrompt(
  messages: PendingMessage[],
  now: number = Date.now(),
): string | null {
  if (messages.length === 0) return null;

  if (messages.length === 1) {
    const m = messages[0]!;
    const age = now - m.queuedAt;
    if (age < STALE_AFTER_MS) return m.text;
    return (
      `[queued ${ageLabel(age)}, while another turn was running]\n\n${m.text}\n\n` +
      "(Check whether this is still what's needed before acting — the situation " +
      "may have moved on since it was sent.)"
    );
  }

  const lines = [
    `[${messages.length} messages queued while another turn was running, oldest first]`,
    "",
  ];
  for (const m of messages) {
    lines.push(`— (${ageLabel(now - m.queuedAt)}) ${m.text}`);
  }
  lines.push(
    "",
    "Treat these as one instruction set in order. Where a later message " +
      "supersedes an earlier one, the later wins. Check whether the earlier ones " +
      "are still relevant before acting on them.",
  );
  return lines.join("\n");
}

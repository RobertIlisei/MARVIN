/**
 * The wait stretch (ADR-0130 addendum, 2026-11-24).
 *
 * `waitingOn.since` is the start of ONE wait: a job's start, or a wakeup's
 * creation. A tab that waits on the commit gate re-arms a new job after every
 * result, so `since` restarts each time and a tab that had been on the gate for
 * 13 minutes read "3 min". The stretch is the start of the UNBROKEN run in
 * which the session has had something pending, kept on the session meta so a
 * sidecar restart does not reset it.
 *
 * THE RULE. The sidecar cannot tell "reading a log" from "thinking", and in
 * measured gate-lane sessions almost every wake turn runs `tail` / `sed` /
 * `grep` before re-arming — so "ran a tool other than re-arming" would break the
 * stretch on every turn and fix nothing. A stretch is therefore broken by:
 *
 *   1. a turn that ends with nothing pending (the session stopped waiting);
 *   2. a turn that EDITED FILES (Edit / Write / NotebookEdit / MultiEdit): it
 *      did work of its own, and the wait it arms afterwards is a new stretch;
 *   3. a person's or the supervisor's turn starting on a tab that has nothing
 *      pending: whatever stretch was recorded is stale (a job cancelled
 *      without a turn leaves one behind).
 *
 * Anything else — reading, searching, graph calls, TodoWrite, re-arming a job
 * or wakeup, a Bash command — leaves the stretch running. A Bash command is
 * never "an edit": its write-or-read nature is not knowable here.
 *
 * Known limit: a wait that disappears with no turn at the end of it (a job
 * cancelled from the app, a wakeup dropped as stale) leaves its stretch on the
 * meta until the next turn start (rule 3) or end (rule 1) clears it.
 */

import {
  readSessionMeta,
  updateSessionMeta,
  WAIT_CAUSES,
  type SessionMeta,
  type WaitCause,
  type WaitStretch,
} from "./session-meta";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** True for the tools that write a file by name. Deliberately excludes Bash. */
export function isFileEditToolCall(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

/** The stretch on a meta, validated: a bad `since` is no stretch, an unknown `cause` is dropped. */
export function readWaitStretch(meta: Pick<SessionMeta, "waitStretch"> | null | undefined): WaitStretch | undefined {
  const raw = meta?.waitStretch as unknown;
  if (!raw || typeof raw !== "object") return undefined;
  const { since, cause } = raw as { since?: unknown; cause?: unknown };
  if (typeof since !== "string" || !Number.isFinite(Date.parse(since))) return undefined;
  const known = typeof cause === "string" && (WAIT_CAUSES as readonly string[]).includes(cause);
  return { since, ...(known ? { cause: cause as WaitCause } : {}) };
}

/** What the row reports as `waitingSince`: the stretch's start, never later than this wait's own start. */
export function waitingSinceOf(stretch: WaitStretch | undefined, since: string): string {
  if (!stretch) return since;
  return Date.parse(stretch.since) <= Date.parse(since) ? stretch.since : since;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export type WaitStretchEvent =
  | { phase: "start"; kind: "human" | "machine"; author?: "user" | "supervisor"; pending: boolean }
  | { phase: "end"; filesEdited: boolean; waitStart: string | null };

/** The transition, pure. `undefined` = no stretch. See the rule above. */
export function nextWaitStretch(prev: WaitStretch | undefined, e: WaitStretchEvent): WaitStretch | undefined {
  if (e.phase === "start") {
    const someoneSpoke = e.kind === "human" || e.author === "supervisor";
    return someoneSpoke && !e.pending ? undefined : prev;
  }
  if (e.waitStart === null) return undefined;
  if (!prev || e.filesEdited) return { since: e.waitStart };
  return { since: earlier(prev.since, e.waitStart), ...(prev.cause ? { cause: prev.cause } : {}) };
}

function settle(projectId: string, sessionId: string, event: WaitStretchEvent): void {
  try {
    const meta = readSessionMeta(projectId, sessionId);
    if (!meta) return;
    const prev = readWaitStretch(meta);
    const next = nextWaitStretch(prev, event);
    if (JSON.stringify(next) === JSON.stringify(meta.waitStretch)) return;
    updateSessionMeta(projectId, sessionId, { waitStretch: next });
  } catch {
    /* the clock is bookkeeping; a turn never fails on it */
  }
}

/** Turn start: `pending` = the session has a job or own wakeup right now. */
export function settleWaitStretchAtTurnStart(
  projectId: string,
  sessionId: string,
  e: { kind: "human" | "machine"; author?: "user" | "supervisor"; pending: boolean },
): void {
  settle(projectId, sessionId, { phase: "start", ...e });
}

/** Turn end: `waitStart` = the earliest start among the session's pending waits, null when none. */
export function settleWaitStretchAtTurnEnd(projectId: string, sessionId: string, e: { filesEdited: boolean; waitStart: string | null }): void {
  settle(projectId, sessionId, { phase: "end", ...e });
}

/**
 * Boot recovery re-queued a wait for this session: continue its stretch (or
 * start one at the interrupted job's start) and mark it. A session with no
 * meta gets none; the wakeup's own `cause` still says why.
 */
export function markRestartRearmed(projectId: string, sessionId: string, since: string): void {
  try {
    const meta = readSessionMeta(projectId, sessionId);
    if (!meta) return;
    const prev = readWaitStretch(meta);
    updateSessionMeta(projectId, sessionId, { waitStretch: { since: prev ? earlier(prev.since, since) : since, cause: "restart" } });
  } catch {
    /* bookkeeping */
  }
}

/**
 * In-process registry of live agent turns.
 *
 * Why it exists: the original `/api/chat` implementation tied the SDK
 * abortController to `req.signal`, which meant closing the browser tab
 * (or refreshing) killed the in-flight agent. That's unacceptable for
 * multi-minute turns — the user refreshes, loses the work, and has to
 * re-start the prompt.
 *
 * This registry decouples the agent from the HTTP request lifecycle.
 * When `/api/chat` begins a turn it registers a `LiveTurn` here and
 * pumps events to (a) the transcript on disk, (b) the in-memory
 * `EventEmitter` attached to the LiveTurn. A reconnecting client hits
 * `/api/chat/resume?marvinSessionId=…` which subscribes to the
 * emitter, catching every event emitted from subscription onwards.
 * Past events already landed in the session transcript and the client
 * can replay them from there.
 *
 * Cancellation: only an explicit user action (`/api/chat/cancel`)
 * triggers `abortController.abort()`. Tab refresh leaves the turn
 * untouched.
 *
 * Lives in memory only — MARVIN is a single-process web app. If we
 * ever move to multi-process, swap this for Redis pub/sub keyed by
 * `marvinSessionId`.
 */

import { EventEmitter } from "node:events";

export interface LiveTurnEvent {
  /** SSE event name — e.g. `cli.event`, `confirm.request`, `turn.completed`. */
  event: string;
  /** JSON-serialisable payload for the event. */
  data: unknown;
}

export interface LiveTurn {
  turnId: string;
  marvinSessionId: string;
  projectId: string;
  startedAt: number;
  /** AbortController for an EXPLICIT user cancel. Not tied to the HTTP request. */
  abortController: AbortController;
  /** Event bus. Each HTTP subscriber wires a `.on("event", …)` listener. */
  bus: EventEmitter;
  /** True once the turn has emitted a terminal event (`turn.completed` / `turn.error`). */
  ended: boolean;
  /**
   * Who started this turn (ADR-0069).
   *
   * `"machine"` = a scheduled wakeup, a background-job completion, an
   * auto-reconcile, or a transport auto-continue. Those exist to serve the
   * user, so they must never outrank one.
   */
  kind: "human" | "machine";
  /**
   * True once this turn has been ALLOWED a workspace-mutating tool call.
   *
   * This is the preemption safety rule. Interrupting a turn that has only read
   * is free; interrupting one that has started writing can leave a half-applied
   * edit. Deciding on observed behaviour beats guessing from the turn's kind —
   * a transport auto-continue is machine-started but resumes real
   * implementation work, and must not be cut off mid-edit.
   */
  mutated: boolean;
  /**
   * ADR-0076 — deliver a user message INTO this running turn (Claude Code's
   * mid-turn steering). Set by the orchestrator when the turn runs with a
   * streaming input channel; absent for turns started without one. Returns
   * false when the turn can no longer take input (channel closed), in which
   * case the caller falls back to the durable queue (ADR-0069).
   */
  inject?: (text: string) => boolean;
}

/**
 * Emitted by {@link registerLiveTurn} for EVERY new turn — human POST, timed
 * wakeup (ADR-0031), or background-job completion (ADR-0038). The
 * `/api/chat/announce` SSE route forwards these so an idle client can learn a
 * turn it did NOT start has begun and re-attach via `/api/chat/resume`
 * (ADR-0043). Carries no payload beyond identity — the client renders the turn
 * through the existing resume path, not from the announcement.
 */
export interface TurnAnnouncement {
  marvinSessionId: string;
  projectId: string;
  turnId: string;
  /** Epoch ms the turn was registered. */
  startedAt: number;
}

const live = new Map<string, LiveTurn>();

// Single, process-wide announcer. Same single-process assumption as `live`
// above (MARVIN is one Node process); it rides the same module instance shared
// across the POST / resume / announce route chunks. NOT pinned to globalThis —
// unlike `wakeup-scheduler`, this module is never imported from
// `instrumentation.ts`, so there is no second module copy to reconcile.
const announcer = new EventEmitter();
// Tab/app reconnect churn can briefly stack listeners; don't warn.
announcer.setMaxListeners(0);

/**
 * Subscribe to new-turn announcements. Returns an unsubscribe fn. Used by the
 * `/api/chat/announce` SSE route; one subscription per connected client.
 */
export function subscribeTurnAnnouncements(
  listener: (announcement: TurnAnnouncement) => void,
): () => void {
  announcer.on("turn", listener);
  return () => {
    announcer.off("turn", listener);
  };
}

export function registerLiveTurn(input: {
  turnId: string;
  marvinSessionId: string;
  projectId: string;
  /** ADR-0069 — defaults to "human" so an un-migrated caller is never
   *  mistaken for a machine turn and preempted. */
  kind?: "human" | "machine";
}): LiveTurn {
  // If a prior turn was registered under this session but never ended
  // cleanly (rare — server crash, or an explicit replace), evict it so
  // the new turn wins. The `/api/chat` POST route now refuses a second
  // turn while one is live (409 turn-in-progress), so reaching this
  // branch means something bypassed that guard — abort the evicted
  // turn's agent rather than merely disconnecting it. Removing the bus
  // listeners alone left the old SDK turn running detached, still
  // mutating the workspace while the UI believed it had stopped.
  const existing = live.get(input.marvinSessionId);
  if (existing && !existing.ended) {
    existing.ended = true;
    existing.abortController.abort();
    existing.bus.emit("event", {
      event: "turn.error",
      data: { error: "replaced by a newer turn on the same session" },
    });
    existing.bus.removeAllListeners();
  }
  const bus = new EventEmitter();
  // 0 = unlimited. Tab refresh cycles can briefly create multiple
  // concurrent listeners — we don't want Node's warning.
  bus.setMaxListeners(0);
  const turn: LiveTurn = {
    turnId: input.turnId,
    marvinSessionId: input.marvinSessionId,
    projectId: input.projectId,
    startedAt: Date.now(),
    abortController: new AbortController(),
    bus,
    ended: false,
    kind: input.kind ?? "human",
    mutated: false,
  };
  live.set(input.marvinSessionId, turn);
  // Announce AFTER the turn is in the map, so any listener that reacts by
  // calling getLiveTurn / resume finds it. ADR-0043.
  announcer.emit("turn", {
    marvinSessionId: turn.marvinSessionId,
    projectId: turn.projectId,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
  } satisfies TurnAnnouncement);
  return turn;
}

export function getLiveTurn(marvinSessionId: string): LiveTurn | null {
  return live.get(marvinSessionId) ?? null;
}

export function getLiveTurnByTurnId(turnId: string): LiveTurn | null {
  for (const t of live.values()) if (t.turnId === turnId) return t;
  return null;
}

/**
 * Every turn still running for a project, newest first.
 *
 * `endLiveTurn` keeps a finished turn in the map for a 60 s grace period so a
 * reconnecting client can still collect the terminal event, so `ended` has to
 * be filtered here — a turn that has completed is not a co-tenant and must not
 * raise a conflict against a session that is only tidying up.
 *
 * Used by the shared-tree gate (`maybeSharedTreeConfirm`) to answer "is
 * another session working in this checkout right now".
 */
export function listLiveTurns(projectId: string): LiveTurn[] {
  const out: LiveTurn[] = [];
  for (const t of live.values()) {
    if (t.ended) continue;
    if (t.projectId !== projectId) continue;
    out.push(t);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function emitTurnEvent(
  turn: LiveTurn,
  event: string,
  data: unknown,
): void {
  turn.bus.emit("event", { event, data } satisfies LiveTurnEvent);
}

/**
 * Mark the turn finished and emit a terminal event. Keeps the record
 * around for a short grace period so a slow reconnect can still see
 * the terminal event; after that the entry is evicted.
 */
export function endLiveTurn(
  turn: LiveTurn,
  terminal: { event: "turn.completed" | "turn.error"; data: unknown },
): void {
  if (turn.ended) return;
  turn.ended = true;
  turn.bus.emit("event", { event: terminal.event, data: terminal.data });
  // 60 seconds is plenty for a reconnecting tab to notice and pick up
  // the terminal event. After that, GC the entry.
  setTimeout(() => {
    // Only evict if the map still points at the same turn — a newer
    // turn may have replaced us.
    if (live.get(turn.marvinSessionId) === turn) {
      live.delete(turn.marvinSessionId);
      turn.bus.removeAllListeners();
    }
  }, 60_000).unref?.();
}

/** Explicit user cancel. Returns true when a live turn was force-ended. */
/**
 * Abort a session's live turn.
 *
 * `source` exists because a cancelled turn is otherwise anonymous. A turn
 * that dies mid-thinking surfaces as the SDK's own "Claude Code process
 * aborted by user" — the abort signal reaching the CLI — and NOT as the
 * "cancelled by user" written below, because `endLiveTurn`'s `ended` guard
 * keeps whichever terminal lands first. So the log showed a killed turn with
 * no way to tell whether a person pressed Stop, a Stop-All ran, or a machine
 * turn was preempted. Every caller now names itself, so the next occurrence
 * identifies its own cause instead of needing to be guessed at
 * (user, 2026-09-01: aborts appearing on session switch).
 */
export function cancelLiveTurn(
  marvinSessionId: string,
  source = "unspecified",
): boolean {
  const turn = live.get(marvinSessionId);
  if (!turn || turn.ended) return false;
  // eslint-disable-next-line no-console
  console.log(
    `[marvin.telemetry] ${JSON.stringify({
      kind: "turn.cancelled",
      marvinSessionId,
      turnId: turn.turnId,
      source,
      at: new Date().toISOString(),
    })}`,
  );
  // Ask the agent to stop gracefully...
  turn.abortController.abort();
  // ...but do NOT wait for it. Force the turn terminal now so the session
  // unblocks even if the agent ignores the abort (hung model stream, wedged
  // subprocess) — otherwise the 409 turn-in-progress guard would lock the
  // user out with no in-app recovery. A still-running orphan is left to be
  // reaped; if it later unwinds, `endLiveTurn`'s `ended` guard no-ops the
  // duplicate terminal.
  endLiveTurn(turn, {
    event: "turn.error",
    data: { error: "cancelled by user", cancelled: true },
  });
  return true;
}

/**
 * Mark the session's live turn as having mutated the workspace (ADR-0069).
 *
 * Called from the permission gate the moment a mutating tool call is ALLOWED —
 * not when it completes. A turn that is midway through a write is exactly the
 * one that must not be preempted, so the flag has to be set before the edit
 * lands, never after.
 */
export function markTurnMutated(marvinSessionId: string): void {
  const turn = live.get(marvinSessionId);
  if (turn && !turn.ended) turn.mutated = true;
}

/**
 * May an arriving human message interrupt the turn in flight?
 *
 * Only a machine-initiated turn that has not yet written anything. Everything
 * else queues. This deliberately keeps the protection the 409 was introduced
 * for — never evict a turn that could be mid-mutation — while removing the
 * case where a wakeup outranks the person it exists to serve.
 */
export function isPreemptible(turn: LiveTurn | null): boolean {
  if (!turn || turn.ended) return false;
  return turn.kind === "machine" && !turn.mutated;
}

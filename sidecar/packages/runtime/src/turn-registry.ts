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
}

const live = new Map<string, LiveTurn>();

export function registerLiveTurn(input: {
  turnId: string;
  marvinSessionId: string;
  projectId: string;
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
  };
  live.set(input.marvinSessionId, turn);
  return turn;
}

export function getLiveTurn(marvinSessionId: string): LiveTurn | null {
  return live.get(marvinSessionId) ?? null;
}

export function getLiveTurnByTurnId(turnId: string): LiveTurn | null {
  for (const t of live.values()) if (t.turnId === turnId) return t;
  return null;
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

/** Explicit user cancel. Returns true when a live turn was aborted. */
export function cancelLiveTurn(marvinSessionId: string): boolean {
  const turn = live.get(marvinSessionId);
  if (!turn || turn.ended) return false;
  turn.abortController.abort();
  return true;
}

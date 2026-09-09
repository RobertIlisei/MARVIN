/**
 * Session activity (ADR-0107 addendum) — what each session's turn is doing
 * RIGHT NOW: thinking, writing a reply, or using a tool (and which), for
 * every session of a project, not just the one on screen.
 *
 * The brain used to be a single slot fed by the selected session's own
 * stream; a session that was not on screen had no activity anywhere — a
 * tab thinking and a tab running `Bash` both read as "working". This module
 * derives the same three states the client's `peekCLIEvent` derives, from
 * the same stream events, in the orchestrator's `onEvent` — and announces a
 * change on the project event bus so every watcher (tab dots, the Sessions
 * pane, and the brain for whichever session is selected) sees it.
 *
 * Announced only on CHANGE: a turn streams hundreds of events, a state
 * changes a handful of times.
 */

import { announceProjectEvent } from "./turn-registry";

export type ActivityState = "thinking" | "writing" | "tool";

export interface SessionActivity {
  state: ActivityState;
  /** The tool in use, when `state === "tool"`. */
  tool?: string;
  turnId: string;
  /** ISO timestamp of the change. */
  since: string;
}

const current = new Map<string, SessionActivity>();

/** Derive an activity from one stream event. `null` = no opinion (system events, results, …). */
export function deriveActivity(event: unknown): { state: ActivityState; tool?: string } | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { type?: unknown; message?: { content?: unknown } };
  if (e.type === "assistant") {
    const blocks = Array.isArray(e.message?.content) ? (e.message?.content as Array<{ type?: unknown; name?: unknown }>) : [];
    const tool = blocks.find((b) => b && b.type === "tool_use");
    if (tool) return { state: "tool", ...(typeof tool.name === "string" ? { tool: tool.name } : {}) };
    if (blocks.some((b) => b && b.type === "text")) return { state: "writing" };
    return null;
  }
  // A tool result came back: the model is reading it and thinking again.
  if (e.type === "user") return { state: "thinking" };
  return null;
}

function same(a: SessionActivity | undefined, state: ActivityState, tool: string | undefined): boolean {
  return !!a && a.state === state && a.tool === tool;
}

/** Record + announce an activity change for a session's live turn. */
export function setActivity(
  ids: { projectId: string; marvinSessionId: string; turnId: string },
  state: ActivityState,
  tool?: string,
  now = new Date(),
): void {
  const prev = current.get(ids.marvinSessionId);
  if (same(prev, state, tool) && prev?.turnId === ids.turnId) return;
  const next: SessionActivity = { state, ...(tool ? { tool } : {}), turnId: ids.turnId, since: now.toISOString() };
  current.set(ids.marvinSessionId, next);
  announceProjectEvent({
    event: "session.activity",
    data: { marvinSessionId: ids.marvinSessionId, projectId: ids.projectId, turnId: ids.turnId, state, ...(tool ? { tool } : {}) },
  });
}

/** Feed one stream event; announces only when the derived state changes. */
export function noteActivityEvent(ids: { projectId: string; marvinSessionId: string; turnId: string }, event: unknown): void {
  const d = deriveActivity(event);
  if (!d) return;
  setActivity(ids, d.state, d.tool);
}

/** The turn ended: nothing is happening in this session now. */
export function clearActivity(marvinSessionId: string): void {
  current.delete(marvinSessionId);
}

export function getActivity(marvinSessionId: string): SessionActivity | null {
  return current.get(marvinSessionId) ?? null;
}

/** Test seam. */
export function __resetActivityForTests(): void {
  current.clear();
}

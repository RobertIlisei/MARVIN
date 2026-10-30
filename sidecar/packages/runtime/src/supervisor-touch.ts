/**
 * Supervisor-touched turns (ADR-0127 §5).
 *
 * A turn is touched when a supervisor message started it, or when the
 * supervisor answered a question inside it. From then on every human-only act
 * (§4) in that turn raises a confirm only the user can answer — in every
 * posture, `full` included — and the supervisor's verbs refuse such a confirm.
 *
 * The mark lives in memory for the gate's hot path and on the session meta
 * (`supervisorTouched`) so a resume after a restart inherits it and the watch
 * row reads it with no live turn. The transcript gets a line too, which is
 * where the UI draws the touched-turn divider.
 */

import { getPendingConfirm } from "./confirm-registry";
import { appendSessionTurn } from "./session";
import { readSessionMeta, type SessionMeta, updateSessionMeta } from "./session-meta";
import { HUMAN_ONLY_CONFIRM_RULES } from "./supervisor-acts";
import { announceProjectEvent } from "./turn-registry";

/** `confirm` — the supervisor answered an ordinary permission confirm (milestone 5). */
export type TouchBy = "message" | "answer" | "confirm";

export interface TouchedTurn {
  turnId: string;
  at: string;
  by: TouchBy;
}

const G = globalThis as unknown as { __marvinSupervisorTouches?: Map<string, TouchedTurn> };
/** marvinSessionId → the session's touched turn. One per session: a touch belongs to one turn. */
const touches = (): Map<string, TouchedTurn> => {
  G.__marvinSupervisorTouches ??= new Map();
  return G.__marvinSupervisorTouches;
};

export function markTurnTouched(args: { projectId: string; marvinSessionId: string; turnId: string; by: TouchBy }): TouchedTurn {
  const existing = touches().get(args.marvinSessionId);
  if (existing?.turnId === args.turnId) return existing;
  const touched: TouchedTurn = { turnId: args.turnId, at: new Date().toISOString(), by: args.by };
  touches().set(args.marvinSessionId, touched);
  // The gate reads memory; the records below must never undo the mark.
  try {
    updateSessionMeta(args.projectId, args.marvinSessionId, { supervisorTouched: touched });
    appendSessionTurn(args.projectId, args.marvinSessionId, { type: "turn.supervisor-touched", ...touched });
  } catch {
    /* the mark stands in memory; only the record is lost */
  }
  announceProjectEvent({ event: "turn.supervisor-touched", data: { projectId: args.projectId, marvinSessionId: args.marvinSessionId, ...touched } });
  return touched;
}

export function isTurnTouched(turnId: string): boolean {
  for (const t of touches().values()) if (t.turnId === turnId) return true;
  return false;
}

/** The session's touched turn — from memory, else from the meta (after a restart). Pass the meta when the caller has it. */
export function touchedTurnFor(projectId: string, marvinSessionId: string, meta?: SessionMeta | null): TouchedTurn | null {
  const inMemory = touches().get(marvinSessionId);
  if (inMemory) return inMemory;
  return (meta === undefined ? readSessionMeta(projectId, marvinSessionId) : meta)?.supervisorTouched ?? null;
}

/**
 * Only the user may answer this confirm: the touched-turn rule's own card,
 * or a containment / money confirm in a turn that is touched NOW. Decided
 * when asked rather than when raised, so a confirm raised before the
 * supervisor answered a question in the same turn is covered too.
 */
export function isUserOnlyConfirm(turnId: string, toolUseId: string): boolean {
  const rule = getPendingConfirm(turnId, toolUseId)?.raisedBy;
  if (!rule || !HUMAN_ONLY_CONFIRM_RULES.has(rule)) return false;
  return rule === "supervisor-touched" || isTurnTouched(turnId);
}

export function resetTouchesForTests(): void {
  touches().clear();
}

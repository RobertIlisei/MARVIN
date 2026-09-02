/**
 * Turn-close hook (ADR-0105 follow-up, 2026-09-03) — the SDK `Stop` event.
 *
 * Two of the practice backtest's top findings are about how a turn ENDS:
 * real-work turns ending without the scope-met handoff (41 % of them, 677
 * turns) and turns that stopped with plan steps open and no question asked,
 * answered by a bare "continue" (25 sessions, 21.5 h of waiting). Both are
 * prose MUSTs in the personality (Phase 7, ADR-0067), and the recurring
 * lesson of this repo is that prose MUSTs fire ~0×.
 *
 * `Stop` is the mechanism the prompt lacked. When the model is about to end
 * the turn, this hook reads the last assistant message and, ONCE per turn,
 * blocks the stop with the reason — Claude Code then continues the same
 * request with that reason in front of it. One continuation inside a cached
 * request, not a fresh turn, not a wakeup.
 *
 * Brakes: never fires when `stop_hook_active` (the SDK's own loop guard),
 * never twice in a turn, never on a wakeup / machine turn, never when the
 * ending is a question, a named human action, or a background job, and it
 * honours `MARVIN_DESIGN_HOOKS` (`off` / `measure`). Pure decision here; the
 * caller supplies the counters.
 */

import type { HookCallback, HookJSONOutput, StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { readDesignHooksMode } from "./design-hooks";
import { classifyTurnEnding } from "./practice-extractors";
import { hasScopeMet, openTodos } from "./workflow-guard";

export interface TurnCloseFacts {
  /** Edit / Write / NotebookEdit calls this turn (own, not subagent). */
  mutations: number;
  /** The last TodoWrite payload this turn, if any. */
  lastTodos: unknown;
  /** True for wakeups / queued replays — never nag a machine turn. */
  machineTurn: boolean;
  /** Has this hook already blocked once this turn? */
  alreadyFired: boolean;
}

export interface TurnCloseDecision {
  kind: "scope-met-missing" | "plan-steps-open";
  reason: string;
}

/** The decision, or null to let the turn end. Exported for tests. */
export function decideTurnClose(lastText: string, facts: TurnCloseFacts): TurnCloseDecision | null {
  if (facts.alreadyFired || facts.machineTurn) return null;
  const ending = classifyTurnEnding(lastText);
  if (ending === "asked" || ending === "blocked-on-human" || ending === "background") return null;
  if (facts.mutations > 0 && !hasScopeMet(lastText)) {
    return {
      kind: "scope-met-missing",
      reason:
        `This turn edited ${facts.mutations} file${facts.mutations === 1 ? "" : "s"} and is ending without the handoff. ` +
        "Before you stop: state what you verified against the Definition of Done, then end with " +
        "`**Scope met:** <the DoD, past tense>. Anything else, or should I stop?` and the sentinel " +
        "`<!-- marvin:scope-met -->` on its own line. If the scope is NOT met, say exactly what remains " +
        "instead — never claim it to clear this. (Measured across this project's sessions: 41 % of " +
        "real-work turns ended without the handoff. Once per turn; this will not repeat.)",
    };
  }
  if (ending === "stopped") {
    const open = openTodos(facts.lastTodos);
    if (open.length > 0) {
      const shown = open.slice(0, 3).map((s) => `"${s.slice(0, 70)}"`).join(", ");
      return {
        kind: "plan-steps-open",
        reason:
          `${open.length} step${open.length === 1 ? "" : "s"} of the approved plan remain (${shown}${open.length > 3 ? ", …" : ""}) ` +
          "and this turn is ending with no question asked. ADR-0067: an approved plan is standing authorization — " +
          "CONTINUE with the next step in this turn. Stop only at the plan's end, on a real trade-off, or when " +
          "genuinely blocked, and then END WITH THE QUESTION. (Measured: turns like this one were answered with a " +
          "bare \"continue\" after 21.5 h of waiting in total. Once per turn; this will not repeat.)",
      };
    }
  }
  return null;
}

export function makeTurnCloseStopHook(args: {
  turnId: string;
  facts: () => Omit<TurnCloseFacts, "alreadyFired">;
  onFired: (decision: TurnCloseDecision) => void;
}): HookCallback {
  let fired = false;
  return async (input) => {
    if (input.hook_event_name !== "Stop") return {} as HookJSONOutput;
    const evt = input as StopHookInput;
    if (evt.stop_hook_active) return {} as HookJSONOutput;
    const mode = readDesignHooksMode();
    if (mode === "off") return {} as HookJSONOutput;
    const decision = decideTurnClose(evt.last_assistant_message ?? "", { ...args.facts(), alreadyFired: fired });
    if (!decision) return {} as HookJSONOutput;
    fired = true;
    args.onFired(decision);
    try {
      console.info(
        "[marvin.telemetry] " +
          JSON.stringify({
            kind: mode === "measure" ? "turn.close.measured" : "turn.close.block",
            turnId: args.turnId,
            decision: decision.kind,
            at: new Date().toISOString(),
          }),
      );
    } catch {
      /* never break a turn on telemetry */
    }
    if (mode === "measure") return {} as HookJSONOutput;
    return { decision: "block", reason: decision.reason } as HookJSONOutput;
  };
}

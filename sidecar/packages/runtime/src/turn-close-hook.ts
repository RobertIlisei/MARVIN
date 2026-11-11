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
import { BUILTIN_GATE_MAX_DENIES, readDesignHooksMode } from "./design-hooks";
import { parsePlanTag } from "./plan-spine";
import { builtinGate, notePracticeRuleFired } from "./practice";
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
  /** Open steps of the persisted plan spine, when no TodoWrite ran this turn. */
  planOpenSteps?: string[];
  /** Did this turn write TodoWrite at all? */
  todoWrittenThisTurn?: boolean;
  /** ADR-0124 D — open `[N]` steps of a plan MARVIN seeded, this turn's
   *  TodoWrite already applied. */
  seededOpenSteps?: string[];
  /** ADR-0132 — the turn's mode; the go-ahead rule applies in `agent` only. */
  mode?: "agent" | "plan" | "ask";
  /** ADR-0132 — did this turn call `AskUserQuestion`? */
  askedUserQuestion?: boolean;
  /** ADR-0132 — step count of the seeded spine, the frame a `[N]` tag joins to. */
  seededStepCount?: number;
}

export interface TurnCloseDecision {
  kind: "scope-met-missing" | "plan-steps-open" | "plan-stale" | "seeded-steps-open" | "go-ahead";
  reason: string;
}

/**
 * ADR-0124 D — a scope-met close while a seeded step is still open is a claim
 * the plan contradicts. Unlike the advisories below this is a gate: it fires
 * on machine turns too, and its brake is ADR-0104's (two blocks, then the
 * close is let through and the bypass logged), not once per turn. Exported
 * for tests.
 */
export function decideSeededClose(lastText: string, seededOpen: string[] | undefined): TurnCloseDecision | null {
  if (!seededOpen || seededOpen.length === 0) return null;
  if (!hasScopeMet(lastText)) return null;
  const shown = seededOpen.slice(0, 4).join("; ");
  return {
    kind: "seeded-steps-open",
    reason:
      `plan-spine gate (ADR-0124): this turn claims scope met, but ${seededOpen.length} step${seededOpen.length === 1 ? "" : "s"} ` +
      `of the plan seeded from the brief ${seededOpen.length === 1 ? "is" : "are"} still open (${shown}${seededOpen.length > 4 ? "; …" : ""}). ` +
      "Either finish them, or reconcile the plan honestly: TodoWrite with each `[N]` marked completed (only if it " +
      "is), or superseded with the reason — then close. If the scope is NOT met, say what remains instead of the " +
      `scope-met line. (After ${BUILTIN_GATE_MAX_DENIES} refusals the close is allowed and the bypass logged.)`,
  };
}

const GO_AHEAD_QUESTION =
  /\b(?:shall|should) i (?:go ahead|proceed|start|begin|continue|get started)\b|\bwant me to (?:go ahead|proceed|start|begin|continue|get started)\b|\bready to (?:go ahead|proceed|start|begin)\b/i;

/** True when the text's final paragraph is one go-ahead question offering no choice. */
function endsOnGoAheadQuestion(lastText: string): boolean {
  const paras = lastText.trim().split(/\n\s*\n/);
  const last = (paras[paras.length - 1] ?? "").trim().replace(/[*_`"')\s]+$/, "");
  if (!last.endsWith("?") || (last.match(/\?/g) ?? []).length !== 1) return false;
  // The clause holding the question: after the last sentence break before it.
  const clause = last.split(/[.!:]\s+|\n/).pop() ?? last;
  return GO_AHEAD_QUESTION.test(clause) && !/\bor\b/i.test(clause);
}

/** True when a TodoWrite batch holds an item that does not join the seeded spine. */
function todosFailJoin(todos: unknown, stepCount: number): boolean {
  if (!Array.isArray(todos)) return false;
  return todos.some((t) => {
    const content = t && typeof t === "object" ? (t as { content?: unknown }).content : undefined;
    const tag = typeof content === "string" ? parsePlanTag(content) : null;
    return !tag || tag.hi > stepCount;
  });
}

/**
 * ADR-0132 — a turn in Agent mode that restates a seeded plan and stops on
 * "Shall I go ahead with step 1?" is asking permission the brief already
 * granted (ADR-0067). Pure; the caller owns the tier, the once-per-turn
 * brake and `stop_hook_active`. Unlike `decideTurnClose` it applies to machine
 * turns too. Exported for tests.
 */
export function decideGoAheadClose(lastText: string, facts: TurnCloseFacts): TurnCloseDecision | null {
  if (facts.mode !== "agent" || facts.askedUserQuestion) return null;
  const open = facts.seededOpenSteps ?? [];
  if (open.length === 0) return null;
  if (!endsOnGoAheadQuestion(lastText)) return null;
  if (facts.todoWrittenThisTurn && todosFailJoin(facts.lastTodos, facts.seededStepCount ?? 0)) return null;
  return {
    kind: "go-ahead",
    reason:
      `go-ahead rule (ADR-0132): this turn ends by asking whether to start, but the brief IS the plan — ${open.length} ` +
      `seeded step${open.length === 1 ? "" : "s"} remain (first: ${open[0]}). ADR-0067: permission the plan already ` +
      "granted is not asked for. Continue with the first open seeded step in this turn. Steps you said you will " +
      "leave out stay open on the spine — do not mark them done. Stop only at the plan's end, on a real " +
      "trade-off, or when genuinely blocked, and then ask with AskUserQuestion. (Once per turn; this will not repeat.)",
  };
}

/** The decision, or null to let the turn end. Exported for tests. */
export function decideTurnClose(lastText: string, facts: TurnCloseFacts): TurnCloseDecision | null {
  if (facts.alreadyFired || facts.machineTurn) return null;
  const ending = classifyTurnEnding(lastText);
  // "scope-not-met" is the alternative this hook's own message asks for.
  if (ending === "asked" || ending === "blocked-on-human" || ending === "background" || ending === "scope-not-met") return null;
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
  // Plan-stale (practice backtest: 48 sessions, 21 % of real-work turns):
  // three or more edits under a plan whose checklist this turn never touched.
  if (facts.mutations >= 3 && !facts.todoWrittenThisTurn && (facts.planOpenSteps?.length ?? 0) > 0) {
    const open = facts.planOpenSteps ?? [];
    return {
      kind: "plan-stale",
      reason:
        `This turn edited ${facts.mutations} files under an approved plan with ${open.length} open step${open.length === 1 ? "" : "s"} ` +
        `(${open.slice(0, 2).map((s) => `"${s.slice(0, 60)}"`).join(", ")}${open.length > 2 ? ", …" : ""}) and never updated the ` +
        "checklist. Before you stop, write the TodoWrite snapshot with the steps this work completed marked done and " +
        "the next one in_progress — the plan spine is what the next session resumes from. (Measured across this " +
        "project's sessions: 21 % of real-work turns left the plan untouched. Once per turn; this will not repeat.)",
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
  let seededBlocks = 0;
  let goAheadBlocked = false;
  return async (input) => {
    if (input.hook_event_name !== "Stop") return {} as HookJSONOutput;
    const evt = input as StopHookInput;
    const mode = readDesignHooksMode();
    if (mode === "off") return {} as HookJSONOutput;
    // ADR-0124 D — checked before the SDK's loop guard: a continuation the
    // first block caused can still end on the same false claim.
    const gate = builtinGate("builtin:plan-spine");
    const facts = args.facts();
    const seeded = gate.off ? null : decideSeededClose(evt.last_assistant_message ?? "", facts.seededOpenSteps);
    if (seeded) {
      const tel = (kind: string) => {
        try {
          console.info("[marvin.telemetry] " + JSON.stringify({ kind, turnId: args.turnId, open: facts.seededOpenSteps?.length ?? 0, at: new Date().toISOString() }));
        } catch {
          /* never break a turn on telemetry */
        }
      };
      if (mode === "measure") {
        tel("plan.spine.close.measured");
      } else if (gate.tier !== "deny") {
        tel("plan.spine.close.nudge");
      } else if (seededBlocks >= BUILTIN_GATE_MAX_DENIES) {
        tel("plan.spine.close.bypass");
        notePracticeRuleFired("builtin:plan-spine", "bypass");
      } else {
        seededBlocks += 1;
        tel("plan.spine.close.block");
        notePracticeRuleFired("builtin:plan-spine", "fired");
        args.onFired(seeded);
        return { decision: "block", reason: gate.message ?? seeded.reason } as HookJSONOutput;
      }
    }
    if (evt.stop_hook_active) return {} as HookJSONOutput;
    // ADR-0132 — the go-ahead rule: machine turns included, once per turn.
    const goGate = builtinGate("builtin:go-ahead");
    const goAhead = goGate.off || goAheadBlocked ? null : decideGoAheadClose(evt.last_assistant_message ?? "", { ...facts, alreadyFired: fired });
    if (goAhead) {
      const tel = (kind: string) => {
        try {
          console.info("[marvin.telemetry] " + JSON.stringify({ kind, turnId: args.turnId, open: facts.seededOpenSteps?.length ?? 0, at: new Date().toISOString() }));
        } catch {
          /* never break a turn on telemetry */
        }
      };
      if (mode === "measure") {
        tel("plan.goahead.measured");
      } else if (goGate.tier !== "deny") {
        tel("plan.goahead.nudge");
      } else {
        goAheadBlocked = true;
        tel("plan.goahead.block");
        notePracticeRuleFired("builtin:go-ahead", "fired");
        args.onFired(goAhead);
        return { decision: "block", reason: goGate.message ?? goAhead.reason } as HookJSONOutput;
      }
    }
    const decision = decideTurnClose(evt.last_assistant_message ?? "", { ...facts, alreadyFired: fired });
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

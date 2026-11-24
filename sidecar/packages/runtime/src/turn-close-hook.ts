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
import { type BacklogItem, extractPathRefs } from "./backlog";
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
  kind:
    | "scope-met-missing"
    | "plan-steps-open"
    | "plan-stale"
    | "seeded-steps-open"
    | "go-ahead"
    | "backlog-claimed-open"
    | "backlog-related";
  reason: string;
}

/** A backlog item as the close check names it. */
export interface BacklogBrief {
  id: string;
  title: string;
}

/** ADR-0137 — what the close check needs from the project's backlog. */
export interface BacklogCloseFacts {
  /** `doing` items this session holds. */
  claimed: BacklogBrief[];
  /** Open, unclaimed items that name a file this turn edited. */
  related: BacklogBrief[];
}

const RELATED_AT_CLOSE_MAX = 3;

/**
 * ADR-0137 — pick the two lists from the project's backlog. Pure.
 *
 * `related` is deliberately narrow: an open item nobody holds whose text names
 * a file this turn edited, matched on the path as the item wrote it. Title
 * similarity is not used: at a close it would offer every item about the same
 * screen, and a suggestion that is usually wrong teaches the model to ignore it.
 */
export function backlogCloseCandidates(items: BacklogItem[], sessionId: string, editedFiles: string[]): BacklogCloseFacts {
  const claimed = items
    .filter((i) => i.status === "doing" && !!sessionId && i.claimedBy === sessionId)
    .map((i) => ({ id: i.id, title: i.title }));
  const edited = editedFiles.map((f) => f.replace(/\\/g, "/"));
  const names = (item: BacklogItem): boolean =>
    extractPathRefs(`${item.title}\n${item.body}`).some(
      (ref) => ref.includes("/") && edited.some((f) => f === ref || f.endsWith(`/${ref}`)),
    );
  const related = items
    .filter((i) => i.status === "open" && !i.claimedBy && names(i))
    .slice(0, RELATED_AT_CLOSE_MAX)
    .map((i) => ({ id: i.id, title: i.title }));
  return { claimed, related };
}

/**
 * ADR-0137 — the backlog at a scope-met close. A claimed item still `doing`
 * is a gate (the claim says "I am working this"; the close says "I am done");
 * an unclaimed look-alike is a suggestion and says so. Null when the turn does
 * not claim scope met. Exported for tests.
 */
export function decideBacklogClose(lastText: string, facts: BacklogCloseFacts): TurnCloseDecision | null {
  if (!hasScopeMet(lastText)) return null;
  const list = (xs: BacklogBrief[]): string => xs.map((x) => `\`${x.id}\` (${x.title.slice(0, 70)})`).join("; ");
  if (facts.claimed.length > 0) {
    const n = facts.claimed.length;
    return {
      kind: "backlog-claimed-open",
      reason:
        `backlog check (ADR-0137): this turn claims scope met while this session still holds ${n} claimed backlog ` +
        `item${n === 1 ? "" : "s"}: ${list(facts.claimed)}. For each one: if this work finished it, call ` +
        "`backlog_resolve` with the evidence (the commit and the test that proves it); if it did not, release it " +
        "back to open with a note saying exactly what remains. Do not resolve an item on the strength of this " +
        `message. (After ${BUILTIN_GATE_MAX_DENIES} refusals the close is allowed and the bypass logged.)`,
    };
  }
  if (facts.related.length > 0) {
    return {
      kind: "backlog-related",
      reason:
        `backlog check (ADR-0137): ${facts.related.length} open backlog item${facts.related.length === 1 ? "" : "s"} ` +
        `nobody holds name${facts.related.length === 1 ? "s" : ""} a file this turn edited: ${list(facts.related)}. ` +
        "Read each one. Resolve it only if this work really finished it, with the evidence; otherwise leave it " +
        "exactly as it is and say in one line why it is not covered. This is a suggestion, not a finding. " +
        "(Once per turn; this will not repeat.)",
    };
  }
  return null;
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
  /** ADR-0137 — read lazily, and only when the turn claims scope met. */
  backlog?: () => Promise<BacklogCloseFacts>;
  onFired: (decision: TurnCloseDecision) => void;
}): HookCallback {
  let fired = false;
  let seededBlocks = 0;
  let goAheadBlocked = false;
  let backlogBlocks = 0;
  let backlogSuggested = false;
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
    // ADR-0137 — the backlog at a scope-met close. Machine turns included (a
    // supervised tab closes on a wakeup), and before the SDK's loop guard for
    // the same reason as the plan gate above. A failed read never blocks.
    if (args.backlog && hasScopeMet(evt.last_assistant_message ?? "")) {
      let bk: BacklogCloseFacts = { claimed: [], related: [] };
      try {
        bk = await args.backlog();
      } catch {
        /* the backlog must never break a close */
      }
      const d = decideBacklogClose(evt.last_assistant_message ?? "", bk);
      const tel = (kind: string) => {
        try {
          console.info("[marvin.telemetry] " + JSON.stringify({ kind, turnId: args.turnId, claimed: bk.claimed.length, related: bk.related.length, at: new Date().toISOString() }));
        } catch {
          /* never break a turn on telemetry */
        }
      };
      if (d && mode === "measure") {
        tel("backlog.close.measured");
      } else if (d?.kind === "backlog-claimed-open") {
        if (backlogBlocks >= BUILTIN_GATE_MAX_DENIES) {
          tel("backlog.close.bypass");
        } else {
          backlogBlocks += 1;
          tel("backlog.close.block");
          args.onFired(d);
          return { decision: "block", reason: d.reason } as HookJSONOutput;
        }
      } else if (d?.kind === "backlog-related" && !backlogSuggested && !evt.stop_hook_active) {
        backlogSuggested = true;
        tel("backlog.close.suggest");
        args.onFired(d);
        return { decision: "block", reason: d.reason } as HookJSONOutput;
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

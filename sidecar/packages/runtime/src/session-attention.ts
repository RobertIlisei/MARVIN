/**
 * ADR-0130 §2, §3 — the two silent stops. A turn that ends on a question in
 * prose, and a turn refused a background job or wakeup by the chain cap, both
 * leave a session nobody was told about. `decideAttention` names which of the
 * two (if any) a finished turn raises; `nextAttention` (session-meta.ts)
 * applies it.
 */

import { listBackgroundJobs } from "./background-jobs";
import { builtinGate, notePracticeRuleFired } from "./practice";
import { classifyTurnEnding } from "./practice-extractors";
import { nextAttention, type SessionAttention } from "./session-meta";
import { listWakeups } from "./wakeup-scheduler";

export const ATTENTION_EXCERPT_MAX = 300;

/** The refusal a turn noted when the chain cap turned a job or wakeup away. */
export interface ChainCapRefusal {
  what: "job" | "wakeup";
  /** The refused command, or the wakeup's reason. */
  label: string;
}

/** The last paragraph of the text, uncapped. */
function lastParagraph(text: string): string {
  const paras = text.trim().split(/\n\s*\n/);
  return (paras[paras.length - 1] ?? "").trim();
}

function cap(text: string, max = ATTENTION_EXCERPT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function decideAttention(input: {
  turnId: string;
  finalText: string;
  askedUserQuestion: boolean;
  scopeMet: boolean;
  /** The session has a job or wakeup of its own pending. */
  waitingOnOwn: boolean;
  chainCap?: ChainCapRefusal | null | undefined;
  /** `builtin:prose-question` is switched off. */
  proseQuestionOff: boolean;
}): Omit<SessionAttention, "since"> | null {
  // A refusal outranks a question from the same turn.
  if (input.chainCap) {
    const what = input.chainCap.what === "job" ? "background job" : "wakeup";
    return { kind: "chain-cap", excerpt: cap(`Refused a ${what} by the chain cap: ${input.chainCap.label}`), turnId: input.turnId };
  }
  if (input.proseQuestionOff || input.askedUserQuestion || input.scopeMet || input.waitingOnOwn) return null;
  // The turn's ENDING is its last paragraph: a question earlier in the text is
  // not a stop. `classifyTurnEnding` is the detector the Stop hook already uses.
  const last = lastParagraph(input.finalText);
  const ending = classifyTurnEnding(last);
  if (ending !== "asked" && ending !== "blocked-on-human") return null;
  return { kind: "prose-question", excerpt: cap(last), turnId: input.turnId };
}

/**
 * The turn-end half the orchestrator calls: gathers the facts (the practice
 * row, the session's own pending job or wakeup), decides, notes the row as
 * fired for a prose question, and returns the `nextAttention` patch (or null).
 */
export function attentionPatchForTurn(input: {
  marvinSessionId: string;
  turnId: string;
  result: { finalText?: string; askedUserQuestion?: boolean; scopeMet?: boolean; chainCap?: ChainCapRefusal };
}): ReturnType<typeof nextAttention> {
  const { result } = input;
  const raised = decideAttention({
    turnId: input.turnId,
    finalText: result.finalText ?? "",
    askedUserQuestion: !!result.askedUserQuestion,
    scopeMet: !!result.scopeMet,
    waitingOnOwn: listBackgroundJobs(input.marvinSessionId).length > 0 || listWakeups({ marvinSessionId: input.marvinSessionId }).length > 0,
    chainCap: result.chainCap,
    proseQuestionOff: builtinGate("builtin:prose-question").off,
  });
  if (raised?.kind === "prose-question") notePracticeRuleFired("builtin:prose-question", "fired");
  return nextAttention({ phase: "end", raised });
}

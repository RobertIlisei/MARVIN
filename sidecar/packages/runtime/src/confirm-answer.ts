/**
 * A first-class answer to an AskUserQuestion (ADR-0127 §9).
 *
 * Until now a caller had to hand-build `updatedInput: { questions, answers }`
 * and `/api/confirm` checked only that it was an object — an allow without it
 * resolved the question with no answers at all. `buildAnswerInput` takes the
 * question by its full text and the chosen option label(s) or "Other" text,
 * validates every label against the question the registry kept, and builds
 * the payload exactly as the native sheet does
 * (`macos/MARVIN/AskQuestionSheet.swift:248-266`):
 *
 *   - `answers` keys every question by its full text;
 *   - a question's value is its picked labels in OPTION order, then the
 *     trimmed "Other" text, joined with "," (no space); unanswered → "";
 *   - the original `questions` are echoed beside `answers`.
 *
 * One rule is stricter than the sheet: a single-select question takes exactly
 * one answer — an option or "Other", not both.
 *
 * `recordConfirmDecision` writes the transcript's `confirm.decision` with who
 * answered and announces `confirm.resolved`; `/api/confirm` uses it too.
 */

import { getPendingConfirm, resolvePendingConfirm } from "./confirm-registry";
import { appendSessionTurn } from "./session";
import { announceProjectEvent, getLiveTurnByTurnId } from "./turn-registry";

interface Question {
  question: string;
  multiSelect: boolean;
  options: string[];
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      question: String(q.question ?? ""),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => String(o.label ?? "")),
    }));
}

export type AnswerBuild =
  | { ok: true; updatedInput: { answers: Record<string, string>; questions?: unknown } }
  | { ok: false; status: 400; error: string };

export function buildAnswerInput(
  originalInput: Record<string, unknown>,
  answers: Record<string, string | string[]>,
  other: Record<string, string>,
): AnswerBuild {
  const fail = (error: string): AnswerBuild => ({ ok: false, status: 400, error });
  const qs = parseQuestions(originalInput);
  const byText = new Map(qs.map((q) => [q.question, q]));
  const keys = [...new Set([...Object.keys(answers ?? {}), ...Object.keys(other ?? {})])];
  if (keys.length === 0) return fail("no answer given");
  for (const k of keys) {
    if (!byText.has(k)) return fail(`"${k.slice(0, 120)}" is not one of the pending questions`);
  }

  const out: Record<string, string> = {};
  let answered = 0;
  for (const q of qs) {
    const raw = answers?.[q.question];
    const picked = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const label of picked) {
      if (typeof label !== "string" || !q.options.includes(label)) {
        return fail(`"${String(label).slice(0, 80)}" is not an option of "${q.question.slice(0, 80)}" (valid: ${q.options.join(", ")})`);
      }
    }
    const freeRaw = other?.[q.question];
    if (freeRaw !== undefined && (typeof freeRaw !== "string" || !freeRaw.trim() || freeRaw.length > 2_000)) {
      return fail(`the "Other" answer to "${q.question.slice(0, 80)}" must be 1–2000 characters`);
    }
    const free = typeof freeRaw === "string" ? freeRaw.trim() : "";
    if (!q.multiSelect && picked.length + (free ? 1 : 0) > 1) return fail(`"${q.question.slice(0, 80)}" takes one answer`);
    const parts = q.options.filter((label) => picked.includes(label));
    if (free) parts.push(free);
    if (parts.length) answered += 1;
    out[q.question] = parts.join(",");
  }
  if (answered === 0) return fail("no answer given");
  return {
    ok: true,
    updatedInput: { answers: out, ...(originalInput.questions !== undefined ? { questions: originalInput.questions } : {}) },
  };
}

/**
 * `/api/confirm`'s check on an `allow` for a question (ADR-0127 §9). The
 * native sheet already sends `{ answers, questions }`; what this refuses is
 * the allow that carries no answer — which used to resolve the question with
 * the original input and nothing chosen. Keys must be pending questions,
 * values strings, at least one non-empty; `questions` is taken from the
 * registry, never from the caller.
 */
export function normalizeSheetAnswer(
  originalInput: Record<string, unknown>,
  updatedInput: Record<string, unknown> | undefined,
): AnswerBuild {
  const fail = (error: string): AnswerBuild => ({ ok: false, status: 400, error });
  const answers = updatedInput?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return fail("an allow on a question must carry `updatedInput.answers` — or use POST /api/confirm/answer");
  }
  const qs = parseQuestions(originalInput);
  const known = new Set(qs.map((q) => q.question));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
    if (!known.has(k)) return fail(`"${k.slice(0, 120)}" is not one of the pending questions`);
    if (typeof v !== "string") return fail(`the answer to "${k.slice(0, 80)}" must be a string`);
    out[k] = v;
  }
  if (!Object.values(out).some((v) => v.trim())) return fail("no answer given");
  for (const q of qs) out[q.question] ??= "";
  return { ok: true, updatedInput: { answers: out, ...(originalInput.questions !== undefined ? { questions: originalInput.questions } : {}) } };
}

/** The transcript record and the project event for a decided confirm, with who decided it. */
export function recordConfirmDecision(args: {
  turnId: string;
  toolUseId: string;
  decision: "allow" | "deny";
  answeredBy: "user" | "supervisor";
  message?: string;
}): void {
  const owner = getLiveTurnByTurnId(args.turnId);
  if (!owner) return;
  // Written before the announce, so a crash between the two loses the
  // notification rather than the record. Never fails the decision itself.
  try {
    appendSessionTurn(owner.projectId, owner.marvinSessionId, {
      type: "confirm.decision",
      at: new Date().toISOString(),
      turnId: args.turnId,
      toolUseId: args.toolUseId,
      decision: args.decision,
      answeredBy: args.answeredBy,
      ...(args.message ? { message: args.message.slice(0, 500) } : {}),
    });
  } catch {
    /* the decision stands; only the record is lost */
  }
  announceProjectEvent({
    event: "confirm.resolved",
    data: { marvinSessionId: owner.marvinSessionId, projectId: owner.projectId, turnId: args.turnId, toolUseId: args.toolUseId, decision: args.decision },
  });
}

export type AnswerResult =
  | { ok: true; updatedInput: Record<string, unknown> }
  | { ok: false; status: 400 | 409; error: string };

/** Answer a pending AskUserQuestion by label. Resolves nothing unless the answer is valid. */
export function answerQuestion(args: {
  turnId: string;
  toolUseId: string;
  answers: Record<string, string | string[]>;
  other: Record<string, string>;
  answeredBy: "user" | "supervisor";
}): AnswerResult {
  const pending = getPendingConfirm(args.turnId, args.toolUseId);
  if (!pending) return { ok: false, status: 409, error: "no pending question with that id — already answered, or never asked" };
  if (pending.raisedBy !== "ask-user-question") {
    return { ok: false, status: 400, error: `that confirm was raised by the ${pending.raisedBy ?? "unknown"} rule; it is not a question` };
  }
  const built = buildAnswerInput(pending.originalInput, args.answers, args.other);
  if (!built.ok) return built;
  if (!resolvePendingConfirm(args.turnId, args.toolUseId, { behavior: "allow", updatedInput: built.updatedInput })) {
    return { ok: false, status: 409, error: "the question was answered a moment ago" };
  }
  recordConfirmDecision({ turnId: args.turnId, toolUseId: args.toolUseId, decision: "allow", answeredBy: args.answeredBy });
  return { ok: true, updatedInput: built.updatedInput };
}

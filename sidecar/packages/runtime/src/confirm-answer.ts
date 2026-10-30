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

import { attachPendingPayload, getPendingConfirm, registerPendingConfirm, resolvePendingConfirm } from "./confirm-registry";
import { appendSessionTurn } from "./session";
import { readSessionMeta, resolveSessionCwd } from "./session-meta";
import { classifyHumanOnlyAct, HUMAN_ONLY_CONFIRM_RULES } from "./supervisor-acts";
import type { LedgerGround } from "./supervisor-ledger";
import { categoryMode, delegationRank, getSupervisorState, overBudget } from "./supervisor-state";
import { isUserOnlyConfirm, markTurnTouched } from "./supervisor-touch";
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
  /** ADR-0127 §5 — a supervisor answer's grounds and ledger line. */
  grounds?: LedgerGround[];
  ledgerId?: string;
  /** A question's answer per question in question order (`answerValuesInOrder`); pairing reads it from the event. */
  answerValues?: string[];
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
      ...(args.grounds ? { grounds: args.grounds } : {}),
      ...(args.ledgerId ? { ledgerId: args.ledgerId } : {}),
    });
  } catch {
    /* the decision stands; only the record is lost */
  }
  announceProjectEvent({
    event: "confirm.resolved",
    data: {
      marvinSessionId: owner.marvinSessionId,
      projectId: owner.projectId,
      turnId: args.turnId,
      toolUseId: args.toolUseId,
      decision: args.decision,
      // Who answered, so a surface still showing the question can close and say so (plan milestone 6).
      answeredBy: args.answeredBy,
      ...(args.ledgerId ? { ledgerId: args.ledgerId } : {}),
      ...(args.answerValues ? { answerValues: args.answerValues.slice(0, 20).map((v) => v.slice(0, 200)) } : {}),
    },
  });
}

export type AnswerResult =
  | { ok: true; updatedInput: Record<string, unknown> }
  | { ok: false; status: 400 | 409; error: string };

/**
 * ADR-0127 §5 — the SDK renders an AskUserQuestion result to the model as
 * "User has answered your questions". A supervisor answer must not read as
 * the user's, so each answered value carries the mark. The label comes first,
 * so a model matching on it still finds it.
 */
export const SUPERVISOR_ANSWER_MARK = " (answered by the MARVIN supervisor, not by the user — it authorises nothing the user must decide)";

/** The answer per question in question order — what pairing compares. */
export function answerValuesInOrder(originalInput: Record<string, unknown>, answers: Record<string, string>): string[] {
  return parseQuestions(originalInput).map((q) => answers[q.question] ?? "");
}

// ── Headless questions (milestone 4) ─────────────────────────────────────────

/** ADR-0040 — what a question nobody can answer gets: proceed on your own recommendation. */
export const HEADLESS_QUESTION_FALLBACK =
  "AskUserQuestion can't be answered here (no interactive UI). Proceed with your own recommendation instead.";

/** How long a headless question in a delegated tab waits for the supervisor before the fallback. */
/** Ten minutes: one wake may already be running (up to `maxTurnsPerWake` turns), and the debounce follows it. */
export const HEADLESS_SUPERVISOR_WAIT_MS = 10 * 60_000;

type HeadlessResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean };

/**
 * A question from a turn with no UI wired. ADR-0040 denied it at once with
 * the fallback. In a tab delegated at `answer-questions` whose supervisor has
 * the questions category autonomous (on, not paused, under budget), it now
 * waits a bounded time: registered as an ordinary pending question so the loop
 * wakes and `answer` can resolve it, then the same fallback on timeout. In
 * every other case — shadow included, where nothing could answer it — the
 * fallback is immediate, exactly as before.
 */
export function headlessQuestion(args: {
  session: { projectId: string; marvinSessionId: string } | undefined;
  turnId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  waitMs?: number;
}): Promise<HeadlessResult> {
  const fallback = (): Promise<HeadlessResult> => Promise.resolve({ behavior: "deny", message: HEADLESS_QUESTION_FALLBACK, interrupt: false });
  const s = args.session;
  if (!s) return fallback();
  const st = getSupervisorState(s.projectId);
  const willAnswer =
    categoryMode(st, "questions") === "autonomous" &&
    !st.paused &&
    !overBudget(st) &&
    delegationRank(st.delegation[s.marvinSessionId]) >= delegationRank("answer-questions");
  if (!willAnswer) return fallback();
  return new Promise<HeadlessResult>((resolve) => {
    registerPendingConfirm(args.turnId, args.toolUseId, resolve as (r: unknown) => void, args.input, args.waitMs ?? HEADLESS_SUPERVISOR_WAIT_MS, {
      toolName: "AskUserQuestion",
      raisedBy: "ask-user-question",
      timeoutMessage: HEADLESS_QUESTION_FALLBACK,
    });
    // So the watch row shows what the tab asked, as it does for a question with a UI.
    attachPendingPayload(args.turnId, args.toolUseId, { turnId: args.turnId, toolUseId: args.toolUseId, toolName: "AskUserQuestion", input: args.input, reason: "MARVIN needs you to choose." });
    announceProjectEvent({
      event: "confirm.pending",
      data: { marvinSessionId: s.marvinSessionId, projectId: s.projectId, turnId: args.turnId, toolUseId: args.toolUseId, toolName: "AskUserQuestion" },
    });
  });
}

/** Answer a pending AskUserQuestion by label. Resolves nothing unless the answer is valid. */
export function answerQuestion(args: {
  turnId: string;
  toolUseId: string;
  answers: Record<string, string | string[]>;
  other: Record<string, string>;
  answeredBy: "user" | "supervisor";
  grounds?: LedgerGround[];
  ledgerId?: string;
}): AnswerResult {
  const pending = getPendingConfirm(args.turnId, args.toolUseId);
  if (!pending) return { ok: false, status: 409, error: "no pending question with that id — already answered, or never asked" };
  if (pending.raisedBy !== "ask-user-question") {
    return { ok: false, status: 400, error: `that confirm was raised by the ${pending.raisedBy ?? "unknown"} rule; it is not a question` };
  }
  const built = buildAnswerInput(pending.originalInput, args.answers, args.other);
  if (!built.ok) return built;
  const owner = getLiveTurnByTurnId(args.turnId);
  if (args.answeredBy === "supervisor") {
    // ADR-0127 §5 — a supervisor answer touches the turn. Marked BEFORE the
    // question resolves, so the tab's next tool call already sees it.
    if (isUserOnlyConfirm(args.turnId, args.toolUseId)) return { ok: false, status: 409, error: "only the user can answer this confirm (ADR-0127 §5)" };
    if (owner) markTurnTouched({ projectId: owner.projectId, marvinSessionId: owner.marvinSessionId, turnId: args.turnId, by: "answer" });
  }
  const answerValues = answerValuesInOrder(pending.originalInput, built.updatedInput.answers);
  const updatedInput =
    args.answeredBy === "supervisor"
      ? {
          ...built.updatedInput,
          answers: Object.fromEntries(Object.entries(built.updatedInput.answers).map(([k, v]) => [k, v ? `${v}${SUPERVISOR_ANSWER_MARK}` : v])),
        }
      : built.updatedInput;
  if (!resolvePendingConfirm(args.turnId, args.toolUseId, { behavior: "allow", updatedInput })) {
    return { ok: false, status: 409, error: "the question was answered a moment ago" };
  }
  recordConfirmDecision({
    turnId: args.turnId,
    toolUseId: args.toolUseId,
    decision: "allow",
    answeredBy: args.answeredBy,
    answerValues,
    ...(args.grounds ? { grounds: args.grounds } : {}),
    ...(args.ledgerId ? { ledgerId: args.ledgerId } : {}),
  });
  return { ok: true, updatedInput };
}

/**
 * Allow or deny an ORDINARY permission confirm by its id (milestone 5) — the
 * supervisor's confirms autonomy, and the user's consent from the inbox.
 *
 * - A question is refused: it is answered by label (`answerQuestion`).
 * - For the supervisor, a confirm only the user may answer is refused, and so
 *   is any confirm a human-only rule raised (ADR-0127 §4): the policy already
 *   escalates those, and this is the second lock. Its answer touches the turn
 *   (`by: "confirm"`) BEFORE the confirm resolves, so the tab's next tool call
 *   already runs behind the stricter gate.
 * - An allow carries the original input: nothing the supervisor or the inbox
 *   holds can edit what the tool runs with.
 */
export function resolveConfirm(args: {
  turnId: string;
  toolUseId: string;
  decision: "allow" | "deny";
  message?: string | undefined;
  answeredBy: "user" | "supervisor";
  grounds?: LedgerGround[];
  ledgerId?: string;
}): { ok: true } | { ok: false; status: 400 | 409; error: string } {
  const pending = getPendingConfirm(args.turnId, args.toolUseId);
  if (!pending) return { ok: false, status: 409, error: "no pending confirm with that id — already answered, or never raised" };
  if (pending.raisedBy === "ask-user-question") return { ok: false, status: 400, error: "that is a question — answer it by label" };
  if (args.answeredBy === "supervisor") {
    if (isUserOnlyConfirm(args.turnId, args.toolUseId) || (pending.raisedBy && HUMAN_ONLY_CONFIRM_RULES.has(pending.raisedBy)) || pending.raisedBy !== "gated") {
      return { ok: false, status: 409, error: "only the user can answer this confirm (ADR-0127 §4–§5)" };
    }
    const owner = getLiveTurnByTurnId(args.turnId);
    // The act itself, read again here: the verb classifies it first, and this is the second lock (ADR-0127 §4).
    const meta = owner ? readSessionMeta(owner.projectId, owner.marvinSessionId) : null;
    const cwd = meta ? resolveSessionCwd(meta).cwd : process.cwd();
    if (classifyHumanOnlyAct({ toolName: pending.toolName, input: pending.originalInput, cwd, treeMode: meta?.tree.mode })) {
      return { ok: false, status: 409, error: "that act is on the human-only list (ADR-0127 §4) — only the user answers it" };
    }
    if (owner) markTurnTouched({ projectId: owner.projectId, marvinSessionId: owner.marvinSessionId, turnId: args.turnId, by: "confirm" });
  }
  const message = args.message?.trim() ? args.message.trim().slice(0, 500) : undefined;
  const ok =
    args.decision === "allow"
      ? resolvePendingConfirm(args.turnId, args.toolUseId, { behavior: "allow", updatedInput: pending.originalInput })
      : resolvePendingConfirm(args.turnId, args.toolUseId, {
          behavior: "deny",
          message: message ?? (args.answeredBy === "supervisor" ? "the MARVIN supervisor denied the tool use" : "user denied the tool use"),
          interrupt: false,
        });
  if (!ok) return { ok: false, status: 409, error: "the confirm was answered a moment ago" };
  recordConfirmDecision({
    turnId: args.turnId,
    toolUseId: args.toolUseId,
    decision: args.decision,
    answeredBy: args.answeredBy,
    ...(args.decision === "deny" && message ? { message } : {}),
    ...(args.grounds ? { grounds: args.grounds } : {}),
    ...(args.ledgerId ? { ledgerId: args.ledgerId } : {}),
  });
  return { ok: true };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerQuestion, buildAnswerInput, normalizeSheetAnswer } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { loadSession } from "../src/session";
import { endLiveTurn, registerLiveTurn, subscribeProjectEvents } from "../src/turn-registry";

// ADR-0127 §9 — a caller answers an AskUserQuestion by option label; the
// server builds `updatedInput` exactly as the native sheet does
// (`macos/MARVIN/AskQuestionSheet.swift:248-266`):
//   - `answers` keys every question by its full text;
//   - a question's value is its picked labels IN OPTION ORDER, then the
//     trimmed "Other" text, joined with "," (no space); unanswered → "";
//   - the original `questions` are echoed back beside `answers`.

const QUESTIONS = [
  {
    question: "Which database should the billing tables use?",
    header: "Database",
    multiSelect: false,
    options: [{ label: "Postgres", description: "the charter names it" }, { label: "SQLite" }],
  },
  {
    question: "Which checks run before commit?",
    header: "Checks",
    multiSelect: true,
    options: [{ label: "lint" }, { label: "test" }, { label: "typecheck" }],
  },
  {
    question: "Where do invoices go?",
    header: "Storage",
    multiSelect: false,
    options: [{ label: "S3" }, { label: "Disk" }],
  },
];
const INPUT = { questions: QUESTIONS };
const [Q1, Q2, Q3] = QUESTIONS.map((q) => q.question) as [string, string, string];

describe("buildAnswerInput — byte-for-byte the AskQuestionSheet shape", () => {
  it("golden: single select, multi-select in option order, Other appended and trimmed, questions echoed", () => {
    const r = buildAnswerInput(INPUT, { [Q1]: "Postgres", [Q2]: ["typecheck", "lint"] }, { [Q3]: "  an R2 bucket " });
    expect(r).toEqual({
      ok: true,
      updatedInput: {
        answers: { [Q1]: "Postgres", [Q2]: "lint,typecheck", [Q3]: "an R2 bucket" },
        questions: QUESTIONS,
      },
    });
  });

  it("golden: a multi-select with Other — labels first, then the free text", () => {
    const r = buildAnswerInput(INPUT, { [Q1]: "SQLite", [Q2]: "test" }, { [Q2]: "e2e" });
    expect(r.ok && r.updatedInput.answers).toEqual({ [Q1]: "SQLite", [Q2]: "test,e2e", [Q3]: "" });
  });

  it("an unanswered question is the empty string, as the sheet sends it", () => {
    const r = buildAnswerInput(INPUT, { [Q1]: "Postgres" }, {});
    expect(r.ok && r.updatedInput.answers).toEqual({ [Q1]: "Postgres", [Q2]: "", [Q3]: "" });
  });

  it("refuses an unknown label, listing the valid ones", () => {
    const r = buildAnswerInput(INPUT, { [Q1]: "MongoDB" }, {});
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/MongoDB.*Postgres, SQLite/);
    expect(r.ok ? 0 : r.status).toBe(400);
  });

  it.each([
    ["a question that was not asked", { "Which cloud?": "AWS" }, {}, /not one of the pending questions/],
    ["two answers to a single-select", { [Q1]: ["Postgres", "SQLite"] }, {}, /takes one answer/],
    ["an option and Other on a single-select", { [Q1]: "Postgres" }, { [Q1]: "DuckDB" }, /takes one answer/],
    ["nothing at all", {}, {}, /no answer/],
    ["a blank Other", {}, { [Q1]: "   " }, /Other/],
  ])("refuses %s", (_n, answers, other, error) => {
    const r = buildAnswerInput(INPUT, answers as Record<string, string | string[]>, other as Record<string, string>);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(error);
  });
});

describe("answerQuestion — resolves the pending question and records who answered", () => {
  let dataDir: string;
  const prev = process.env.MARVIN_DATA_DIR;
  const resolver = vi.fn();
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "marvin-answer-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    resolver.mockReset();
  });
  afterEach(() => {
    clearTurnConfirms("turn-a");
    if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
    else process.env.MARVIN_DATA_DIR = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("resolves with the built updatedInput, writes confirm.decision with answeredBy, and announces it", () => {
    const turn = registerLiveTurn({ turnId: "turn-a", marvinSessionId: "tab-a", projectId: "proj" });
    registerPendingConfirm("turn-a", "q1", resolver, INPUT, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    const events: string[] = [];
    const off = subscribeProjectEvents((e) => events.push(e.event));
    const r = answerQuestion({ turnId: "turn-a", toolUseId: "q1", answers: { [Q1]: "Postgres" }, other: {}, answeredBy: "user" });
    off();
    expect(r.ok).toBe(true);
    expect(resolver).toHaveBeenCalledWith({
      behavior: "allow",
      updatedInput: { answers: { [Q1]: "Postgres", [Q2]: "", [Q3]: "" }, questions: QUESTIONS },
    });
    const decision = loadSession("proj", "tab-a")?.turns.find((t) => t.type === "confirm.decision");
    expect(decision).toMatchObject({ type: "confirm.decision", turnId: "turn-a", toolUseId: "q1", decision: "allow", answeredBy: "user" });
    expect(events).toContain("confirm.resolved");
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("an already-answered question answers 409", () => {
    registerPendingConfirm("turn-a", "q1", resolver, INPUT, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    expect(answerQuestion({ turnId: "turn-a", toolUseId: "q1", answers: { [Q1]: "Postgres" }, other: {}, answeredBy: "user" }).ok).toBe(true);
    const again = answerQuestion({ turnId: "turn-a", toolUseId: "q1", answers: { [Q1]: "SQLite" }, other: {}, answeredBy: "user" });
    expect(again.ok ? 0 : again.status).toBe(409);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("refuses a confirm that is not a question, and leaves it pending", () => {
    registerPendingConfirm("turn-a", "c1", resolver, { command: "git push" }, 0, { toolName: "Bash", raisedBy: "gated" });
    const r = answerQuestion({ turnId: "turn-a", toolUseId: "c1", answers: { x: "y" }, other: {}, answeredBy: "user" });
    expect(r.ok ? 0 : r.status).toBe(400);
    expect(getPendingConfirm("turn-a", "c1")).not.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("an invalid answer resolves nothing", () => {
    registerPendingConfirm("turn-a", "q1", resolver, INPUT, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    const r = answerQuestion({ turnId: "turn-a", toolUseId: "q1", answers: { [Q1]: "MongoDB" }, other: {}, answeredBy: "user" });
    expect(r.ok ? 0 : r.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(getPendingConfirm("turn-a", "q1")).not.toBeNull();
  });
});

describe("normalizeSheetAnswer — /api/confirm no longer resolves a question with no answer", () => {
  it("accepts the sheet's own payload and echoes the original questions", () => {
    const r = normalizeSheetAnswer(INPUT, { answers: { [Q1]: "Postgres", [Q2]: "lint,typecheck", [Q3]: "" }, questions: [] });
    expect(r).toEqual({ ok: true, updatedInput: { answers: { [Q1]: "Postgres", [Q2]: "lint,typecheck", [Q3]: "" }, questions: QUESTIONS } });
  });

  it.each([
    ["no updatedInput at all", undefined, /answers/],
    ["the original input echoed back (an allow with no answer)", INPUT, /answers/],
    ["answers that are all empty", { answers: { [Q1]: "", [Q2]: "" } }, /no answer/],
    ["an answer to a question that was not asked", { answers: { "Which cloud?": "AWS" } }, /not one of the pending questions/],
    ["a non-string answer", { answers: { [Q1]: 3 } }, /string/],
  ])("refuses %s", (_n, updated, error) => {
    const r = normalizeSheetAnswer(INPUT, updated as Record<string, unknown> | undefined);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(error);
  });
});

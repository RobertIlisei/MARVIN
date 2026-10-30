import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerQuestion } from "../src/confirm-answer";
import { clearTurnConfirms, registerPendingConfirm } from "../src/confirm-registry";
import { loadSession } from "../src/session";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { buildResumeRecord } from "../src/session-recovery";
import { isTurnTouched, isUserOnlyConfirm, markTurnTouched, resetTouchesForTests, touchedTurnFor } from "../src/supervisor-touch";
import { endLiveTurn, type LiveTurn, registerLiveTurn } from "../src/turn-registry";

// ADR-0127 §5 — a turn the supervisor started, or answered a question in, is
// "supervisor-touched"; from then on a §4 act inside it is the user's alone.

let dataDir: string;
let turn: LiveTurn | null = null;
const prev = process.env.MARVIN_DATA_DIR;
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "full" as const, thinkingMode: "high", mode: "agent" as const };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-touch-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetTouchesForTests();
  upsertSessionMeta("proj", "tab-t", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
  turn = registerLiveTurn({ turnId: "turn-t", marvinSessionId: "tab-t", projectId: "proj" });
});
afterEach(() => {
  clearTurnConfirms("turn-t");
  if (turn) endLiveTurn(turn, { event: "turn.completed", data: {} });
  turn = null;
  resetTouchesForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("markTurnTouched — recorded where a restart and a reader can find it", () => {
  it("marks only that turn, and writes the transcript line and the session meta", () => {
    expect(isTurnTouched("turn-t")).toBe(false);
    const t = markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "message" });
    expect(isTurnTouched("turn-t")).toBe(true);
    expect(isTurnTouched("turn-other")).toBe(false);
    expect(touchedTurnFor("proj", "tab-t")).toEqual(t);
    expect(readSessionMeta("proj", "tab-t")?.supervisorTouched).toEqual({ turnId: "turn-t", at: t.at, by: "message" });
    expect(loadSession("proj", "tab-t")?.turns.find((x) => x.type === "turn.supervisor-touched")).toMatchObject({ turnId: "turn-t", by: "message" });
  });

  it("is idempotent: the first touch of a turn is the one recorded", () => {
    const first = markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "message" });
    const again = markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "answer" });
    expect(again).toEqual(first);
    expect(loadSession("proj", "tab-t")?.turns.filter((x) => x.type === "turn.supervisor-touched")).toHaveLength(1);
  });

  it("survives a restart through the meta: the watch reads it with no memory", () => {
    const t = markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "answer" });
    resetTouchesForTests();
    expect(touchedTurnFor("proj", "tab-t")).toEqual(t);
  });
});

describe("a resume after a restart inherits the touch (it must not launder it)", () => {
  it("the record carries the touch when the interrupted turn was touched", () => {
    markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "message" });
    upsertSessionMeta("proj", "tab-t", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE }, { lastTurn: { turnId: "turn-t", startedAt: "2026-10-30T10:00:00Z", outcome: "interrupted" } });
    expect(buildResumeRecord(readSessionMeta("proj", "tab-t")!).supervisorTouched).toBe("message");
  });

  it("and not when a later, untouched turn was the one cut off", () => {
    markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "message" });
    upsertSessionMeta("proj", "tab-t", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE }, { lastTurn: { turnId: "turn-later", startedAt: "2026-10-30T11:00:00Z", outcome: "interrupted" } });
    expect(buildResumeRecord(readSessionMeta("proj", "tab-t")!).supervisorTouched).toBeUndefined();
  });
});

describe("isUserOnlyConfirm — decided when it is asked, from the raising rule and the touch", () => {
  const raise = (toolUseId: string, raisedBy: Parameters<typeof registerPendingConfirm>[5] extends infer M ? M extends { raisedBy?: infer R } ? R : never : never) =>
    registerPendingConfirm("turn-t", toolUseId, () => {}, { command: "x" }, 0, { toolName: "Bash", raisedBy });

  it("a containment or money confirm in an untouched turn is anyone's (the supervisor's verbs still gate it by delegation)", () => {
    raise("c1", "shared-tree");
    expect(isUserOnlyConfirm("turn-t", "c1")).toBe(false);
  });

  it("becomes the user's once the turn is touched — even if it was raised before the touch", () => {
    raise("c1", "shared-tree");
    raise("c2", "metered-ci");
    raise("c3", "gated");
    markTurnTouched({ projectId: "proj", marvinSessionId: "tab-t", turnId: "turn-t", by: "answer" });
    expect(isUserOnlyConfirm("turn-t", "c1")).toBe(true);
    expect(isUserOnlyConfirm("turn-t", "c2")).toBe(true);
    expect(isUserOnlyConfirm("turn-t", "c3")).toBe(false); // an ordinary gated card, not a §4 act by its rule
  });

  it("the touched-turn rule's own card is always the user's", () => {
    raise("c4", "supervisor-touched");
    expect(isUserOnlyConfirm("turn-t", "c4")).toBe(true);
  });
});

describe("answerQuestion by the supervisor touches the turn and records its grounds", () => {
  const QUESTION = { questions: [{ question: "Which store?", header: "Store", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };

  it("marks the turn touched (by answer) and puts grounds and the ledger id on confirm.decision", () => {
    registerPendingConfirm("turn-t", "q1", () => {}, QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    const r = answerQuestion({
      turnId: "turn-t",
      toolUseId: "q1",
      answers: { "Which store?": "Postgres" },
      other: {},
      answeredBy: "supervisor",
      grounds: [{ kind: "charter", ref: "Postgres", provenance: "strong" }],
      ledgerId: "L-1",
    });
    expect(r.ok).toBe(true);
    expect(isTurnTouched("turn-t")).toBe(true);
    expect(touchedTurnFor("proj", "tab-t")?.by).toBe("answer");
    expect(loadSession("proj", "tab-t")?.turns.find((x) => x.type === "confirm.decision")).toMatchObject({
      answeredBy: "supervisor",
      grounds: [{ kind: "charter", ref: "Postgres", provenance: "strong" }],
      ledgerId: "L-1",
    });
  });

  it("a user's answer touches nothing", () => {
    registerPendingConfirm("turn-t", "q1", () => {}, QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    answerQuestion({ turnId: "turn-t", toolUseId: "q1", answers: { "Which store?": "SQLite" }, other: {}, answeredBy: "user" });
    expect(isTurnTouched("turn-t")).toBe(false);
  });
});

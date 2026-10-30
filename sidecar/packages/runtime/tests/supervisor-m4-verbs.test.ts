import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerQuestion } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { marvinPaths } from "../src/paths";
import { upsertSessionMeta } from "../src/session-meta";
import type { SessionWatchRow } from "../src/session-watch";
import { readLedger } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext, type VerbPerform } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  noteSupervisorTabSpend,
  resetSupervisorStateForTests,
} from "../src/supervisor-state";
import { isTurnTouched, resetTouchesForTests } from "../src/supervisor-touch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";

// ADR-0127 milestone 4 — the first time the supervisor performs anything.
// Each category acts only once the user switches it to autonomous; in shadow
// the same call is a proposal and nothing happens. An act names its ledger
// line before it is performed, and that id reaches the transcript.

let dataDir: string;
let mainRoot: string;
const prev = process.env.MARVIN_DATA_DIR;
const resolver = vi.fn();
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());

const POSTURE = { model: "claude-opus-5-5", advisorModel: null, thinkingMode: "high", permissionStrategy: "auto" as const, mode: "agent" as const, personality: "marvin" as const };

const QUESTION = {
  questions: [
    {
      question: "Which database should the billing tables use?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "the charter names it" },
        { label: "SQLite", description: "simpler locally" },
      ],
    },
  ],
};
const RISKY = {
  questions: [{ question: "Should I push the branch now?", header: "Push", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }],
};

function row(id: string, overrides: Partial<SessionWatchRow> = {}): SessionWatchRow {
  return {
    marvinSessionId: id,
    projectId: "proj",
    state: "awaiting-you",
    worktree: null,
    turn: { turnId: `turn-${id}`, kind: "human", startedAt: new Date().toISOString(), mutated: false },
    activity: null,
    pending: [],
    tree: { mode: "shared", cwd: mainRoot, currentBranch: "main", present: true },
    diff: null,
    plan: { done: 1, total: 4, open: 3, lastTodoAt: null, seeded: true },
    graphUsage: null,
    lastTurn: null,
    cost: { turns: 1, costUsd: 0 },
    title: `title ${id}`,
    updatedAt: new Date().toISOString(),
    posture: POSTURE,
    postureRevision: null,
    ...overrides,
  } as SessionWatchRow;
}

let rows: SessionWatchRow[];
let scopeMet: Record<string, boolean>;
let perform: { [K in keyof VerbPerform]: ReturnType<typeof vi.fn> } & VerbPerform;
let ctx: VerbContext;
const charterGround = [{ kind: "charter" as const, ref: "Postgres, not SQLite" }];
const verbs = () => createSupervisorVerbs(ctx);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4v-data-"));
  mainRoot = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4v-main-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  resolver.mockReset();
  act({ action: "start", charter: "Billing page. Postgres, not SQLite.", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
  upsertSessionMeta("proj", "tab-1", { workDir: mainRoot, tree: { mode: "shared" }, posture: POSTURE });
  registerPendingConfirm("turn-tab-1", "tu-1", resolver, QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
  rows = [row("tab-1")];
  scopeMet = {};
  perform = {
    // The real service, so the transcript and the touch are the production path.
    answer: vi.fn((a: Parameters<VerbPerform["answer"]>[0]) => answerQuestion({ ...a, answeredBy: "supervisor" })),
    send: vi.fn(async () => ({ ok: true as const, queued: false })),
    cancel: vi.fn(() => true),
    setPosture: vi.fn(async () => ({ ok: true as const })),
  } as never;
  ctx = {
    projectId: "proj",
    workDir: mainRoot,
    wakeId: "wake-1",
    wake: { acts: 0 },
    limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
    deps: {
      listRows: async () => rows,
      getPending: getPendingConfirm,
      readTranscriptTail: () => "",
      readBrief: () => "Build the billing page.",
      tabStartedAt: () => null,
      readPlanText: () => "",
      sendRefusal: () => null,
      scopeMet: (tab: string) => scopeMet[tab] ?? false,
      modelLookup: async () => (id: string) => ({ "claude-opus-5-5": { tier: "opus" }, "claude-sonnet-5-5": { tier: "sonnet" } })[id] ?? null,
      perform,
    },
  };
});
afterEach(() => {
  clearTurnConfirms("turn-tab-1");
  resetTouchesForTests();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

const ANSWER = { marvinSessionId: "tab-1", toolUseId: "tu-1", answers: { "Which database should the billing tables use?": "Postgres" }, grounds: charterGround };

function transcriptLines(): Array<Record<string, unknown>> {
  const f = marvinPaths.sessionFile("proj", "tab-1");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("questions", () => {
  it("autonomous: a grounded question is answered through answerQuestion, marked the supervisor's, and the turn is touched", async () => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    const live = registerLiveTurn({ turnId: "turn-tab-1", marvinSessionId: "tab-1", projectId: "proj" });
    const reply = await verbs().answer(ANSWER);
    expect(reply).toMatch(/answered/i);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(getPendingConfirm("turn-tab-1", "tu-1")).toBeNull();

    const line = readLedger("proj").find((e) => e.verb === "answer");
    expect(line?.decision).toBe("act");
    expect(line?.mode).toBe("autonomous");
    expect(line?.id).toBeTruthy();
    expect(line?.toolUseId).toBe("tu-1");
    expect(line?.answer).toEqual(["Postgres"]);

    // The transcript reads the supervisor, with its grounds and the ledger line.
    const decision = transcriptLines().find((t) => t.type === "confirm.decision");
    expect(decision?.answeredBy).toBe("supervisor");
    expect(decision?.ledgerId).toBe(line?.id);
    expect(decision?.grounds).toEqual([{ kind: "charter", ref: "Postgres, not SQLite", provenance: "strong" }]);

    // The tab's model reads the answer as the supervisor's, never as the user's.
    const result = resolver.mock.calls[0]?.[0] as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(result.behavior).toBe("allow");
    const value = result.updatedInput.answers["Which database should the billing tables use?"] as string;
    expect(value.startsWith("Postgres")).toBe(true);
    expect(value).toMatch(/supervisor/i);
    expect(value).toMatch(/not (by )?the user/i);
    expect(value).not.toMatch(/on the user's behalf/i);
    expect(value).toMatch(/authorises nothing/i);

    expect(isTurnTouched("turn-tab-1")).toBe(true);
    endLiveTurn(live, { event: "turn.completed", data: {} });
  });

  it("shadow: the same call is a proposal; nothing is answered, and the line keeps the target and the labels for pairing", async () => {
    await verbs().answer(ANSWER);
    expect(perform.answer).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "answer");
    expect(line?.decision).toBe("propose");
    expect(line?.turnId).toBe("turn-tab-1");
    expect(line?.toolUseId).toBe("tu-1");
    expect(line?.answer).toEqual(["Postgres"]);
  });

  it.each([
    ["heuristic-flagged", RISKY, { "Should I push the branch now?": "Yes" }, charterGround],
    ["ungrounded", QUESTION, { "Which database should the billing tables use?": "Postgres" }, []],
    ["weak-only", QUESTION, { "Which database should the billing tables use?": "Postgres" }, [{ kind: "plan" as const, ref: "2" }]],
  ])("autonomous: a %s question is never answered — it stays pending for the user", async (_name, q, answers, grounds) => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    rows = [row("tab-1", { plan: { done: 1, total: 4, open: 3, lastTodoAt: null, seeded: false } as SessionWatchRow["plan"] })];
    clearTurnConfirms("turn-tab-1");
    registerPendingConfirm("turn-tab-1", "tu-1", resolver, q, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    await verbs().answer({ marvinSessionId: "tab-1", toolUseId: "tu-1", answers, grounds });
    expect(perform.answer).not.toHaveBeenCalled();
    expect(getPendingConfirm("turn-tab-1", "tu-1")).not.toBeNull();
    const line = readLedger("proj").find((e) => e.verb === "answer");
    expect(["escalate", "refuse"]).toContain(line?.decision);
    if (_name !== "ungrounded") expect(line?.decision).toBe("escalate");
  });

  it("the questions switch does not make nudges act", async () => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    rows = [row("tab-1", { turn: null, state: "idle" })];
    await verbs().send({ marvinSessionId: "tab-1", message: "Carry on with step 2.", kind: "nudge", grounds: charterGround });
    expect(perform.send).not.toHaveBeenCalled();
    expect(readLedger("proj").find((e) => e.verb === "send")?.decision).toBe("propose");
  });
});

describe("nudges", () => {
  beforeEach(() => {
    rows = [row("tab-1", { turn: null, state: "idle" })];
  });

  it("autonomous: a nudge to an idle tab with an unfinished plan sends exactly once, naming its ledger line", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    await verbs().send({ marvinSessionId: "tab-1", message: "Carry on with step 2.", kind: "nudge", grounds: charterGround });
    expect(perform.send).toHaveBeenCalledTimes(1);
    const line = readLedger("proj").find((e) => e.verb === "send");
    expect(line?.decision).toBe("act");
    const msg = perform.send.mock.calls[0]?.[0] as { kind: string; text: string; ledgerId: string; grounds: unknown[] };
    expect(msg.kind).toBe("nudge");
    expect(msg.text).toBe("Carry on with step 2.");
    expect(msg.ledgerId).toBe(line?.id);
    expect(msg.grounds).toHaveLength(1);
  });

  it("a send the tab refuses at perform time is ledgered as a refusal, not an act", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    perform.send.mockResolvedValueOnce({ ok: false, code: "stopped", reason: "the user stopped this tab" });
    await verbs().send({ marvinSessionId: "tab-1", message: "Carry on.", kind: "nudge", grounds: charterGround });
    const line = readLedger("proj").find((e) => e.verb === "send");
    expect(line?.decision).toBe("refuse");
    expect(line?.reasonCode).toBe("stopped");
  });

  it.each(["shadow", "autonomous"] as const)("%s: a nudge to a scope-met tab is refused with reasonCode scope-met", async (value) => {
    if (value === "autonomous") act({ action: "autonomy", category: "nudges", value: "autonomous" });
    scopeMet["tab-1"] = true;
    await verbs().send({ marvinSessionId: "tab-1", message: "Carry on.", kind: "nudge", grounds: charterGround });
    expect(perform.send).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "send");
    expect(line?.decision).toBe("refuse");
    expect(line?.reasonCode).toBe("scope-met");
  });

  it("autonomous: cancel stops a machine turn that has not started writing", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    rows = [row("tab-1", { turn: { turnId: "turn-tab-1", kind: "machine", startedAt: new Date().toISOString(), mutated: false } })];
    await verbs().cancel({ marvinSessionId: "tab-1", reason: "looping on the same failing test", grounds: charterGround });
    expect(perform.cancel).toHaveBeenCalledWith("tab-1");
    expect(readLedger("proj").find((e) => e.verb === "cancel")?.decision).toBe("act");
  });
});

describe("cancel never talks over the user", () => {
  beforeEach(() => act({ action: "autonomy", category: "nudges", value: "autonomous" }));
  it.each([
    ["a turn the user started", { kind: "human" as const, mutated: false }, "human-turn"],
    ["a turn that has begun writing", { kind: "machine" as const, mutated: true }, "mid-write"],
  ])("%s escalates and is not cancelled", async (_n, t, code) => {
    rows = [row("tab-1", { turn: { turnId: "turn-tab-1", startedAt: new Date().toISOString(), ...t } })];
    await verbs().cancel({ marvinSessionId: "tab-1", reason: "looping", grounds: charterGround });
    expect(perform.cancel).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "cancel");
    expect(line?.decision).toBe("escalate");
    expect(line?.reasonCode).toBe(code);
  });
});

describe("a pause or the cap reached mid-wake stops acts not yet performed", () => {
  it.each([
    ["paused", () => act({ action: "pause" })],
    ["budget", () => (act({ action: "cap", capUsd: 1 }), noteSupervisorTabSpend("proj", 2))],
  ])("%s: an autonomous answer is refused, not performed", async (code, trip) => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    trip();
    await verbs().answer(ANSWER);
    expect(perform.answer).not.toHaveBeenCalled();
    expect(getPendingConfirm("turn-tab-1", "tu-1")).not.toBeNull();
    const line = readLedger("proj").find((e) => e.verb === "answer");
    expect(line?.decision).toBe("refuse");
    expect(line?.reasonCode).toBe(code);
  });

  it("paused: an autonomous nudge is refused, not sent", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    rows = [row("tab-1", { turn: null, state: "idle" })];
    act({ action: "pause" });
    await verbs().send({ marvinSessionId: "tab-1", message: "Carry on with step 2.", kind: "nudge", grounds: charterGround });
    expect(perform.send).not.toHaveBeenCalled();
    expect(readLedger("proj").find((e) => e.verb === "send")?.reasonCode).toBe("paused");
  });
});

describe("the heuristic reads the supervisor's own words too", () => {
  it("a nudge naming a human-only act escalates", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    rows = [row("tab-1", { turn: null, state: "idle" })];
    await verbs().send({ marvinSessionId: "tab-1", message: "Finish step 2, then push the branch.", kind: "nudge", grounds: charterGround });
    expect(perform.send).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "send");
    expect(line?.decision).toBe("escalate");
    expect(line?.heuristic).toBe("push");
  });

  it("an \"Other\" answer naming a human-only act escalates", async () => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    await verbs().answer({ marvinSessionId: "tab-1", toolUseId: "tu-1", other: { "Which database should the billing tables use?": "Postgres, then deploy it" }, grounds: charterGround });
    expect(perform.answer).not.toHaveBeenCalled();
    expect(readLedger("proj").find((e) => e.verb === "answer")?.decision).toBe("escalate");
  });
});

describe("posture", () => {
  it("autonomous: a grounded narrowing changes posture through the posture service", async () => {
    act({ action: "autonomy", category: "posture", value: "autonomous" });
    await verbs().set_posture({ marvinSessionId: "tab-1", posture: { permissionStrategy: "gated" }, grounds: charterGround });
    expect(perform.setPosture).toHaveBeenCalledTimes(1);
    expect(perform.setPosture.mock.calls[0]?.[0]).toMatchObject({ marvinSessionId: "tab-1", patch: { permissionStrategy: "gated" } });
    expect(readLedger("proj").filter((e) => e.verb === "set_posture").map((e) => e.decision)).toEqual(["act"]);
  });

  it("shadow: nothing changes", async () => {
    await verbs().set_posture({ marvinSessionId: "tab-1", posture: { permissionStrategy: "gated" }, grounds: charterGround });
    expect(perform.setPosture).not.toHaveBeenCalled();
  });

  it("autonomous: a widening still escalates and performs nothing", async () => {
    act({ action: "autonomy", category: "posture", value: "autonomous" });
    await verbs().set_posture({ marvinSessionId: "tab-1", posture: { permissionStrategy: "full" }, grounds: charterGround });
    expect(perform.setPosture).not.toHaveBeenCalled();
    expect(readLedger("proj").find((e) => e.verb === "set_posture")?.decision).toBe("escalate");
  });
});

// Security audit, milestone 4: a strong ground is now what lets the supervisor
// ACT, so a quote must be a quote. A fragment like "e" is a substring of every
// charter and used to resolve as strong.
describe("a charter or brief quote must be a real quote", () => {
  it.each([["charter", "e"], ["charter", "SQL"], ["dod", "the"]])("%s ref %j does not resolve, and nothing is answered", async (kind, ref) => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    await verbs().answer({ ...ANSWER, grounds: [{ kind: kind as "charter" | "dod", ref }] });
    expect(perform.answer).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "answer");
    expect(line?.decision).toBe("refuse");
    expect(line?.grounds?.[0]?.provenance).toBe("unresolved");
  });
});

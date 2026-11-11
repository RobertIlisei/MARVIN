import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPendingConfirm } from "../src/confirm-registry";
import { type SessionAttention, upsertSessionMeta } from "../src/session-meta";
import { buildResumeRecord } from "../src/session-recovery";
import type { SessionWatchRow } from "../src/session-watch";
import { readLedger } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext, type VerbPerform } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0130 / milestone 2.5 — the supervisor answers an attention item with the
// existing `send` verb and its existing policy; a chain-cap restart is bounded.

let dataDir: string;
let mainRoot: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, thinkingMode: "high", permissionStrategy: "auto" as const, mode: "agent" as const, personality: "marvin" as const };
const GROUND = [{ kind: "charter" as const, ref: "Postgres, not SQLite" }];

let rows: SessionWatchRow[];
let userTurnAt: string | null;
let perform: { [K in keyof VerbPerform]: ReturnType<typeof vi.fn> } & VerbPerform;
let ctx: VerbContext;

function row(attention: Pick<SessionAttention, "kind" | "excerpt"> & { since?: string } | null): SessionWatchRow {
  return {
    marvinSessionId: "tab-1",
    projectId: "proj",
    state: attention ? "awaiting-you" : "idle",
    worktree: null,
    turn: null,
    activity: null,
    pending: [],
    tree: { mode: "shared", cwd: mainRoot, currentBranch: "main", present: true },
    diff: null,
    plan: { done: 1, total: 4, open: 3, lastTodoAt: null, seeded: true },
    graphUsage: null,
    lastTurn: null,
    waitingOn: null,
    attention: attention ? { since: "2026-11-11T10:00:00Z", ...attention } : null,
    cost: { turns: 1, costUsd: 0 },
    title: "t",
    updatedAt: new Date().toISOString(),
    posture: POSTURE,
    postureRevision: null,
  } as unknown as SessionWatchRow;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-att-v-data-"));
  mainRoot = mkdtempSync(path.join(tmpdir(), "marvin-sup-att-v-main-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({ action: "start", charter: "Billing page. Postgres, not SQLite.", delegations: [{ sessionId: "tab-1", level: "answer-confirms" }] });
  act({ action: "autonomy", category: "nudges", value: "autonomous" });
  rows = [];
  userTurnAt = null;
  perform = {
    answer: vi.fn(),
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
      scopeMet: () => false,
      lastUserTurnAt: () => userTurnAt,
      modelLookup: async () => () => null,
      perform,
    },
  };
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

const send = (message: string) => createSupervisorVerbs(ctx).send({ marvinSessionId: "tab-1", message, kind: "instruction", grounds: GROUND });
const lastSend = () => readLedger("proj").filter((e) => e.verb === "send").at(-1);

describe("a prose-question item", () => {
  it("is answered by an ordinary send", async () => {
    rows = [row({ kind: "prose-question", excerpt: "Shall I go ahead with step 1?" })];
    await send("Yes, step 1 as the brief says.");
    expect(perform.send).toHaveBeenCalledTimes(1);
    expect(lastSend()?.decision).toBe("act");
  });

  it("escalates when the tab's question names a human-only act, whatever the reply says", async () => {
    rows = [row({ kind: "prose-question", excerpt: "Tests pass. Shall I merge it to main?" })];
    await send("Carry on with step 2.");
    expect(perform.send).not.toHaveBeenCalled();
    const line = lastSend();
    expect(line?.decision).toBe("escalate");
    expect(line?.heuristic).toBe("merge");
  });

  it("escalates a question naming a push", async () => {
    rows = [row({ kind: "prose-question", excerpt: "Should I push the branch?" })];
    await send("Go on.");
    expect(perform.send).not.toHaveBeenCalled();
    expect(lastSend()?.heuristic).toBe("push");
  });
});

describe("a chain-cap item", () => {
  const cap = () => row({ kind: "chain-cap", excerpt: "Refused a background job by the chain cap: pnpm test:full" });

  it("at answer-questions escalates: a restart needs answer-confirms", async () => {
    act({ action: "delegate", marvinSessionId: "tab-1", level: "answer-questions" });
    rows = [cap()];
    await send("Start the gate again.");
    expect(perform.send).not.toHaveBeenCalled();
    expect(lastSend()).toMatchObject({ decision: "escalate", reasonCode: "chain-cap-delegation" });
  });

  it("at answer-confirms is allowed once per item; the second restart escalates", async () => {
    rows = [cap()];
    await send("Start the gate again.");
    expect(perform.send).toHaveBeenCalledTimes(1);
    expect(lastSend()).toMatchObject({ decision: "act", planSignature: "chain-cap@2026-11-11T10:00:00Z" });
    await send("Start the gate once more.");
    expect(perform.send).toHaveBeenCalledTimes(1);
    expect(lastSend()).toMatchObject({ decision: "escalate", reasonCode: "chain-cap-repeat" });
  });

  it("a second cap on the same session before any user turn escalates; after a user turn it may restart once again", async () => {
    rows = [cap()];
    await send("Start the gate again.");
    // The restart's chain capped again: a NEW item (new `since`), no user turn between.
    rows = [row({ kind: "chain-cap", excerpt: "Refused a background job by the chain cap: pnpm test:full", since: "2026-11-11T12:00:00Z" })];
    await send("Start it a third time.");
    expect(lastSend()).toMatchObject({ decision: "escalate", reasonCode: "chain-cap-repeat" });
    expect(perform.send).toHaveBeenCalledTimes(1);
    // The user spoke to the tab since: the bound counts from there.
    userTurnAt = new Date(Date.now() + 60_000).toISOString();
    await send("Start it once more, as the user asked.");
    expect(lastSend()?.decision).toBe("act");
    expect(perform.send).toHaveBeenCalledTimes(2);
  });
});

describe("a supervisor-sent turn runs at chain depth 0", () => {
  it("buildResumeRecord — the record `sendAsSupervisor` fires — carries depth 0, which `runDetachedTurn` passes as wakeupDepth and sdk-runner reads as `input.wakeupDepth ?? 0`", () => {
    upsertSessionMeta("proj", "tab-d", { workDir: mainRoot, tree: { mode: "shared" }, posture: POSTURE });
    const meta = { version: 1, marvinSessionId: "tab-d", projectId: "proj", workDir: mainRoot, tree: { mode: "shared" }, posture: POSTURE, createdAt: "x", updatedAt: "x" } as Parameters<typeof buildResumeRecord>[0];
    expect(buildResumeRecord(meta, { prompt: "go" }).depth).toBe(0);
  });
});

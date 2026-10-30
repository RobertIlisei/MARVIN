import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import type { SessionWatchRow } from "../src/session-watch";
import { runSupervisorWake } from "../src/supervisor-dispatch";
import { readLedger } from "../src/supervisor-ledger";
import { type LoopDeps, SupervisorLoop } from "../src/supervisor-loop";
import { createSupervisorVerbs, type VerbDeps } from "../src/supervisor-mcp";
import type { WakeItem } from "../src/supervisor-prompt";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  resetSupervisorStateForTests,
  updateSupervisorRuntime,
} from "../src/supervisor-state";
import type { ProjectEvent } from "../src/turn-registry";

// ADR-0127 §2 — the supervisor is woken by code, never by itself. Milestone 1
// wakes on a pending question in a delegated tab: debounced, coalesced, one
// wake at a time, events arriving mid-wake carried to the next, nothing while
// paused or over budget, and kill aborts the wake in flight.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
let listeners: Array<(e: ProjectEvent) => void>;
const resolver = vi.fn();

const QUESTION = {
  questions: [
    {
      question: "Which database should the billing tables use?",
      header: "Database",
      multiSelect: false,
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};

function row(id: string): SessionWatchRow {
  return {
    marvinSessionId: id,
    projectId: "proj",
    state: "awaiting-you",
    worktree: null,
    turn: { turnId: `turn-${id}`, kind: "human", startedAt: new Date().toISOString(), mutated: false },
    activity: null,
    pending: [],
    tree: { mode: "shared", cwd: workDir, currentBranch: "main", present: true },
    diff: null,
    plan: { done: 0, total: 3, open: 3, lastTodoAt: null, seeded: true },
    graphUsage: null,
    lastTurn: null,
    cost: { turns: 1, costUsd: 0 },
    title: id,
    updatedAt: new Date().toISOString(),
    posture: null,
    postureRevision: null,
    postureSource: null,
  } as SessionWatchRow;
}

const verbDeps = (): VerbDeps => ({
  listRows: async () => [row("tab-1"), row("tab-2")],
  getPending: getPendingConfirm,
  readTranscriptTail: () => "",
  readBrief: () => "Build billing.",
  tabStartedAt: () => null,
  readPlanText: () => "",
  modelLookup: async () => () => null,
});

function pending(tab: string, toolUseId: string, toolName = "AskUserQuestion") {
  registerPendingConfirm(`turn-${tab}`, toolUseId, resolver, toolName === "AskUserQuestion" ? QUESTION : { command: "ls" }, 0, {
    toolName,
    raisedBy: toolName === "AskUserQuestion" ? "ask-user-question" : "gated",
  });
  const e: ProjectEvent = { event: "confirm.pending", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}`, toolUseId, toolName } };
  for (const l of listeners) l(e);
}

function resolved(tab: string, toolUseId: string) {
  clearTurnConfirms(`turn-${tab}`);
  const e: ProjectEvent = { event: "confirm.resolved", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}`, toolUseId, decision: "allow" } };
  for (const l of listeners) l(e);
}

let wakes: Array<{ items: WakeItem[]; signal: AbortSignal }>;
let release: Array<() => void>;
let holdWakes = false;

function deps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    subscribe: (l) => {
      listeners.push(l);
      return () => {
        listeners = listeners.filter((x) => x !== l);
      };
    },
    workDirOf: () => workDir,
    verbDeps,
    buildItems: async (_p, _w, refs) =>
      refs.map((r) => ({
        marvinSessionId: r.marvinSessionId,
        title: r.marvinSessionId,
        delegation: "answer-questions",
        turnId: r.turnId,
        toolUseId: r.toolUseId,
        question: QUESTION,
        brief: null,
        plan: null,
        transcriptTail: "",
        ledgerTail: [],
      })),
    runWake: async (a) => {
      wakes.push({ items: a.items, signal: a.abortController.signal });
      if (holdWakes) await new Promise<void>((r) => release.push(r));
      return { ok: true, costUsd: 0 };
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-loop-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-loop-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  const t = currentSupervisorToken() as string;
  applySupervisorAction({ projectId: "proj", action: "start" }, t);
  applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "answer-questions" }, t);
  applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-2", level: "answer-questions" }, t);
  applySupervisorAction({ projectId: "proj", action: "charter", text: "Postgres, not SQLite." }, t);
  listeners = [];
  wakes = [];
  release = [];
  holdWakes = false;
  resolver.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  for (const tab of ["tab-1", "tab-2", "tab-off"]) clearTurnConfirms(`turn-${tab}`);
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const debounce = () => getSupervisorState("proj").caps.debounceMs;
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("SupervisorLoop — woken by code, not by itself", () => {
  it("one pending question in a delegated tab → exactly one wake after the debounce", async () => {
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    await tick(debounce() - 1);
    expect(wakes).toHaveLength(0);
    await tick(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.items.map((i) => i.toolUseId)).toEqual(["q1"]);
    loop.stop();
  });

  it("ignores confirms that are not questions, undelegated tabs and the supervisor's own session", async () => {
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "c1", "Bash");
    pending("tab-off", "q-off");
    pending(getSupervisorState("proj").supervisorSessionId as string, "q-own");
    await tick(debounce() * 2);
    expect(wakes).toHaveLength(0);
    loop.stop();
  });

  it("coalesces questions from two tabs into one wake", async () => {
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    await tick(1000);
    pending("tab-2", "q2");
    await tick(debounce());
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.items.map((i) => i.toolUseId).sort()).toEqual(["q1", "q2"]);
    loop.stop();
  });

  it("drops a question the user answered before the wake", async () => {
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    resolved("tab-1", "q1");
    await tick(debounce() * 2);
    expect(wakes).toHaveLength(0);
    loop.stop();
  });

  it("events that arrive during a wake reach the next wake — one wake at a time, nothing dropped", async () => {
    holdWakes = true;
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    await tick(debounce());
    expect(wakes).toHaveLength(1);
    pending("tab-2", "q2");
    await tick(debounce() * 2);
    expect(wakes).toHaveLength(1);
    release.shift()?.();
    await tick(debounce());
    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.items.map((i) => i.toolUseId)).toEqual(["q2"]);
    release.shift()?.();
    loop.stop();
  });

  it("pause stops wakes; resume picks the queue back up", async () => {
    const loop = new SupervisorLoop(deps());
    loop.start();
    const t = currentSupervisorToken() as string;
    applySupervisorAction({ projectId: "proj", action: "pause" }, t);
    pending("tab-1", "q1");
    await tick(debounce() * 2);
    expect(wakes).toHaveLength(0);
    applySupervisorAction({ projectId: "proj", action: "resume" }, t);
    await tick(debounce());
    expect(wakes).toHaveLength(1);
    loop.stop();
  });

  it("kill aborts the wake in flight and no further wake starts", async () => {
    holdWakes = true;
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    await tick(debounce());
    expect(wakes[0]?.signal.aborted).toBe(false);
    applySupervisorAction({ projectId: "proj", action: "kill" }, currentSupervisorToken() as string);
    expect(wakes[0]?.signal.aborted).toBe(true);
    release.shift()?.();
    pending("tab-2", "q2");
    await tick(debounce() * 2);
    expect(wakes).toHaveLength(1);
    loop.stop();
  });

  it("over the daily budget: no wake, and the skip is ledgered once", async () => {
    updateSupervisorRuntime("proj", { addSpendUsd: getSupervisorState("proj").caps.dailyBudgetUsd });
    const loop = new SupervisorLoop(deps());
    loop.start();
    pending("tab-1", "q1");
    await tick(debounce());
    pending("tab-2", "q2");
    await tick(debounce());
    expect(wakes).toHaveLength(0);
    expect(readLedger("proj").filter((e) => e.kind === "wake" && e.verb === "skip")).toHaveLength(1);
    loop.stop();
  });
});

describe("the shadow spine, end to end", () => {
  it("confirm.pending → one wake → one supervisor turn (stubbed model) → one `propose` line; the question is still pending", async () => {
    // The stub model answers through the real verb, inside the real dispatch.
    const loop = new SupervisorLoop(
      deps({
        runWake: (a) =>
          runSupervisorWake(a, {
            resolveModel: async () => undefined,
            query: (() =>
              (async function* () {
                yield { type: "system", subtype: "init", session_id: "sdk-e2e" };
                await createSupervisorVerbs(a.verbCtx).answer({
                  marvinSessionId: "tab-1",
                  toolUseId: "q1",
                  answers: { "Which database should the billing tables use?": "Postgres" },
                  grounds: [{ kind: "charter", ref: "Postgres, not SQLite." }],
                });
                yield { type: "result", subtype: "success", session_id: "sdk-e2e", total_cost_usd: 0.01, usage: { input_tokens: 500 } };
              })()) as never,
          }),
      }),
    );
    loop.start();
    pending("tab-1", "q1");
    await tick(debounce());
    await vi.waitFor(() => expect(readLedger("proj").some((e) => e.kind === "wake" && e.verb === "end")).toBe(true));
    const ledger = readLedger("proj");
    expect(ledger.filter((e) => e.kind === "wake" && e.verb === "start")).toHaveLength(1);
    const verbs = ledger.filter((e) => e.kind === "verb");
    expect(verbs).toHaveLength(1);
    expect(verbs[0]).toMatchObject({ verb: "answer", decision: "propose", tab: "tab-1" });
    expect(verbs[0]?.grounds?.[0]?.provenance).toBe("strong");
    expect(getPendingConfirm("turn-tab-1", "q1")).not.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
    loop.stop();
  });
});

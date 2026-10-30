import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { appendLedgerEntry, readLedger } from "../src/supervisor-ledger";
import { type LoopDeps, type PendingRef, SupervisorLoop, type TabFacts } from "../src/supervisor-loop";
import type { VerbDeps } from "../src/supervisor-mcp";
import type { WakeItem } from "../src/supervisor-prompt";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  resetSupervisorStateForTests,
  setSupervisorCapsForTests,
} from "../src/supervisor-state";
import type { ProjectEvent } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0127 milestone 4 — the new wake triggers, with the rules a day of real
// supervision taught: idle tabs that finished kept starting turns on their own
// (advisor reconciliations, scope-met checkbacks, stale job completions), each
// costing $12–57. The supervisor wakes for a turn a person or it started, never
// for a machine turn it did not author; for an idle tab with an unfinished plan
// once per plan signature; and never for a tab whose scope is met.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
let listeners: Array<(e: ProjectEvent) => void>;
let wakes: Array<{ items: WakeItem[] }>;
let facts: Record<string, TabFacts>;
let pendingQs: PendingRef[];
let holdWakes: boolean;
let release: Array<() => void>;
const resolver = vi.fn();
const token = () => currentSupervisorToken() as string;
const IDLE_MS = 60_000;
const DEBOUNCE = 5_000;

const baseFacts = (o: Partial<TabFacts> = {}): TabFacts => ({
  live: false,
  pending: 0,
  planSignature: "1/4@2026-10-30T10:00:00Z",
  planOpen: 3,
  scopeMet: false,
  stopped: false,
  waitingOnOwn: false,
  ...o,
});

const verbDeps = (): VerbDeps => ({
  listRows: async () => [],
  getPending: getPendingConfirm,
  sendRefusal: () => null,
  scopeMet: () => false,
  perform: SHADOW_PERFORM,
  readTranscriptTail: () => "",
  readBrief: () => null,
  tabStartedAt: () => null,
  readPlanText: () => "",
  modelLookup: async () => () => null,
});

function deps(): LoopDeps {
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
        trigger: r.trigger ?? "question",
        marvinSessionId: r.marvinSessionId,
        title: null,
        delegation: "answer-questions",
        turnId: r.turnId,
        toolUseId: r.toolUseId,
        question: null,
        brief: null,
        plan: null,
        transcriptTail: "",
        ledgerTail: [],
      })),
    runWake: async (a) => {
      wakes.push({ items: a.items });
      if (holdWakes) await new Promise<void>((r) => release.push(r));
      return { ok: true, costUsd: 0 };
    },
    tabFacts: async (_p, id) => facts[id] ?? null,
    pendingQuestions: () => pendingQs,
  };
}

const emit = (e: ProjectEvent) => {
  for (const l of listeners) l(e);
};
const ended = (tab: string, o: { kind?: "human" | "machine"; author?: "supervisor"; cancelled?: boolean; turnId?: string } = {}) =>
  emit({
    event: "turn.ended",
    data: { marvinSessionId: tab, projectId: "proj", turnId: o.turnId ?? `turn-${tab}`, outcome: "completed", kind: o.kind ?? "human", ...(o.author ? { author: o.author } : {}), ...(o.cancelled ? { cancelled: true } : {}) },
  });
const registered = (tab: string) => emit({ event: "turn.registered", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}-2`, startedAt: Date.now() } });

let loop: SupervisorLoop;
beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4l-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4l-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  listeners = [];
  wakes = [];
  facts = { "tab-1": baseFacts() };
  pendingQs = [];
  holdWakes = false;
  release = [];
  applySupervisorAction({ projectId: "proj", action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
  setSupervisorCapsForTests("proj", { idleMs: IDLE_MS, debounceMs: DEBOUNCE });
  loop = new SupervisorLoop(deps());
  loop.start();
});
afterEach(() => {
  loop.stop();
  vi.useRealTimers();
  clearTurnConfirms("turn-tab-1");
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("turn ended", () => {
  it("a user turn ending in a delegated tab wakes the supervisor once", async () => {
    ended("tab-1", { kind: "human" });
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.items.map((i) => i.trigger)).toEqual(["turn-ended"]);
  });

  it("a supervisor-authored turn ending wakes it too", async () => {
    ended("tab-1", { kind: "machine", author: "supervisor" });
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
  });

  it("a job completion (a machine turn it did not author) produces zero wakes", async () => {
    ended("tab-1", { kind: "machine" });
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });

  it("an observe tab is never woken for a turn ending or for idling — nothing it could do until the inbox", async () => {
    applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "observe" }, token());
    ended("tab-1", { kind: "human" });
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });

  it("a stopped turn, a scope-met tab and an undelegated tab produce zero wakes", async () => {
    ended("tab-1", { cancelled: true });
    await settle(DEBOUNCE + 10);
    facts["tab-1"] = baseFacts({ scopeMet: true });
    ended("tab-1");
    ended("tab-off");
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });
});

describe("idle with an open plan", () => {
  it("wakes once per plan signature, never again for an unchanged idle tab", async () => {
    ended("tab-1", { kind: "machine" }); // arms the idle timer; no turn-ended wake
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => i.trigger))).toEqual([["idle"]]);
    // A stale job completion lands: same plan, still idle — nothing new.
    ended("tab-1", { kind: "machine" });
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
    // The plan moved: a new signature may wake it again.
    facts["tab-1"] = baseFacts({ planSignature: "2/4@2026-10-30T11:00:00Z", planOpen: 2 });
    ended("tab-1", { kind: "machine" });
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(2);
  });

  it("a scope-met tab is never woken for, however long it idles", async () => {
    facts["tab-1"] = baseFacts({ scopeMet: true });
    ended("tab-1", { kind: "machine" });
    await settle(3 * IDLE_MS);
    expect(wakes).toHaveLength(0);
  });

  it.each([
    ["no open plan", { planOpen: 0 }],
    ["no plan", { planSignature: null, planOpen: 0 }],
    ["stopped by the user", { stopped: true }],
    ["waiting on its own job", { waitingOnOwn: true }],
    ["a question pending", { pending: 1 }],
  ])("%s: no idle wake", async (_n, o) => {
    facts["tab-1"] = baseFacts(o as Partial<TabFacts>);
    ended("tab-1", { kind: "machine" });
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });

  it("a new turn starting clears the idle timer", async () => {
    ended("tab-1", { kind: "machine" });
    await settle(IDLE_MS / 2);
    registered("tab-1");
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });
});

describe("pairing and heuristic misses from the feed", () => {
  it("confirm.resolved with answeredBy pairs the open proposal", () => {
    const p = appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "propose", reason: "ok", turnId: "turn-tab-1", toolUseId: "tu-1", answer: ["Postgres"] });
    emit({ event: "confirm.resolved", data: { marvinSessionId: "tab-1", projectId: "proj", turnId: "turn-tab-1", toolUseId: "tu-1", decision: "allow", answeredBy: "user", answerValues: ["Postgres"] } });
    const pairing = readLedger("proj").find((e) => e.kind === "pairing");
    expect(pairing?.proposalId).toBe(p.id);
    expect(pairing?.pairing?.agreement).toBe("agree");
  });

  it("a human-only confirm after an answered question in the same turn records a heuristic miss", () => {
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "propose", reason: "ok", turnId: "turn-tab-1", toolUseId: "tu-1", answer: ["Yes"] });
    registerPendingConfirm("turn-tab-1", "tu-ci", resolver, { command: "glab ci run" }, 0, { toolName: "Bash", raisedBy: "metered-ci" });
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-1", projectId: "proj", turnId: "turn-tab-1", toolUseId: "tu-ci", toolName: "Bash" } });
    expect(readLedger("proj").filter((e) => e.kind === "heuristic-miss")).toHaveLength(1);
  });
});

describe("wake bookkeeping and wakeNow", () => {
  it("snapshot shows the wake in flight; the last wake is recorded when it ends", async () => {
    holdWakes = true;
    ended("tab-1");
    await settle(DEBOUNCE + 10);
    const snap = loop.snapshot("proj");
    expect(snap.currentWake?.itemCount).toBe(1);
    expect(getSupervisorState("proj").lastWake).toBeNull();
    for (const r of release) r();
    await settle(1);
    expect(loop.snapshot("proj").currentWake).toBeNull();
    expect(getSupervisorState("proj").lastWake?.outcome).toBe("ok");
  });

  it("queued events are counted with their age", () => {
    registerPendingConfirm("turn-tab-1", "tu-1", resolver, { questions: [] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-1", projectId: "proj", turnId: "turn-tab-1", toolUseId: "tu-1", toolName: "AskUserQuestion" } });
    const snap = loop.snapshot("proj");
    expect(snap.queuedEvents).toBe(1);
    expect(typeof snap.oldestQueuedAt).toBe("number");
  });

  it("wakeNow re-scans pending questions and wakes without waiting for the debounce", async () => {
    registerPendingConfirm("turn-tab-1", "tu-1", resolver, { questions: [] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    pendingQs = [{ trigger: "question", marvinSessionId: "tab-1", turnId: "turn-tab-1", toolUseId: "tu-1" }];
    applySupervisorAction({ projectId: "proj", action: "wakeNow" }, token());
    await settle(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.items[0]?.toolUseId).toBe("tu-1");
  });
});

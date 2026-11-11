import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPendingConfirm } from "../src/confirm-registry";
import { type LoopDeps, SupervisorLoop, type TabFacts } from "../src/supervisor-loop";
import type { VerbDeps } from "../src/supervisor-mcp";
import type { WakeItem } from "../src/supervisor-prompt";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests, setSupervisorCapsForTests } from "../src/supervisor-state";
import type { ProjectEvent } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0130 §2, §3 / milestone 2.5 — an attention item wakes the supervisor once.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
let listeners: Array<(e: ProjectEvent) => void>;
let wakes: Array<{ items: WakeItem[] }>;
let facts: Record<string, TabFacts>;
const token = () => currentSupervisorToken() as string;
const IDLE_MS = 60_000;
const DEBOUNCE = 5_000;

const att = (since = "2026-11-11T10:00:00Z", kind: "prose-question" | "chain-cap" = "prose-question") => ({ kind, excerpt: "Shall I go ahead with step 1?", since });
const baseFacts = (o: Partial<TabFacts> = {}): TabFacts => ({
  live: false,
  pending: 0,
  planSignature: "1/4@2026-10-30T10:00:00Z",
  planOpen: 3,
  scopeMet: false,
  stopped: false,
  waitingOnOwn: false,
  attention: null,
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
      return { ok: true, costUsd: 0 };
    },
    tabFacts: async (_p, id) => facts[id] ?? null,
    pendingQuestions: () => [],
  };
}

const emit = (e: ProjectEvent) => {
  for (const l of listeners) l(e);
};
const ended = (tab: string, o: { kind?: "human" | "machine"; author?: "supervisor" } = {}) =>
  emit({ event: "turn.ended", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}`, outcome: "completed", kind: o.kind ?? "human", ...(o.author ? { author: o.author } : {}) } });
const registered = (tab: string) => emit({ event: "turn.registered", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}-2`, startedAt: Date.now() } });

let loop: SupervisorLoop;
beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-att-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-att-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  listeners = [];
  wakes = [];
  facts = { "tab-1": baseFacts({ attention: att() }) };
  applySupervisorAction({ projectId: "proj", action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
  setSupervisorCapsForTests("proj", { idleMs: IDLE_MS, debounceMs: DEBOUNCE });
  loop = new SupervisorLoop(deps());
  loop.start();
});
afterEach(() => {
  loop.stop();
  vi.useRealTimers();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("the attention wake", () => {
  it("an attention item wakes the supervisor once, and not again for the same item", async () => {
    ended("tab-1");
    await settle(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => i.trigger))).toEqual([["attention"]]);
    ended("tab-1");
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
    // A new item (a later `since`) is a new wake.
    facts["tab-1"] = baseFacts({ attention: att("2026-11-11T11:00:00Z") });
    ended("tab-1");
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(2);
  });

  it("wakes for a machine turn's attention (a chain-cap refusal ends a job-completion turn)", async () => {
    facts["tab-1"] = baseFacts({ attention: att("2026-11-11T10:00:00Z", "chain-cap") });
    ended("tab-1", { kind: "machine" });
    await settle(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => i.trigger))).toEqual([["attention"]]);
  });

  it("does not wake for a tab it may not act on (observe, undelegated)", async () => {
    applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "observe" }, token());
    ended("tab-1");
    ended("tab-off");
    facts["tab-off"] = baseFacts({ attention: att() });
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });

  it("an item dismissed or cleared before the wake runs is dropped", async () => {
    ended("tab-1");
    facts["tab-1"] = baseFacts({ attention: null });
    await settle(DEBOUNCE + 10);
    expect(wakes).toHaveLength(0);
  });

  it("a turn starting clears a queued attention wake", async () => {
    ended("tab-1");
    await settle(10); // the item is queued, the debounce has not elapsed
    registered("tab-1");
    await settle(DEBOUNCE + 10);
    expect(wakes.length).toBe(0);
  });

  it("the idle trigger does not separately fire for a tab with an open attention item", async () => {
    ended("tab-1", { kind: "machine" });
    await settle(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => i.trigger))).toEqual([["attention"]]);
    await settle(IDLE_MS + DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
  });
});

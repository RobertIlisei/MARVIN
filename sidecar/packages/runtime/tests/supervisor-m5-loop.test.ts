import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { addInboxItem, buildRawAct, getInboxItem, listInbox } from "../src/supervisor-inbox";
import { readLedger } from "../src/supervisor-ledger";
import { type LoopDeps, proposeCloseKeep, SupervisorLoop, type TabFacts } from "../src/supervisor-loop";
import type { VerbDeps } from "../src/supervisor-mcp";
import type { WakeItem } from "../src/supervisor-prompt";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests, setSupervisorCapsForTests } from "../src/supervisor-state";
import type { ProjectEvent } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0127 milestone 5 — the loop's new duties. A tab that claims its scope
// met wakes the supervisor once to read the claim (§2 trigger 4). A finished
// tab left idle gets ONE inbox item proposing to close it with its branch kept
// — deterministic, no wake, no model. A user or supervisor turn opens new
// scope and supersedes the item. An ordinary confirm wakes it for an
// `answer-confirms` tab. An item about a confirm resolves when it is answered.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
let listeners: Array<(e: ProjectEvent) => void>;
let wakes: Array<{ items: WakeItem[] }>;
let facts: Record<string, TabFacts>;
const token = () => currentSupervisorToken() as string;
const IDLE_MS = 60_000;
const DEBOUNCE = 5_000;
const SCOPE_AT = "2026-10-30T10:00:00.000Z";

const baseFacts = (o: Partial<TabFacts> = {}): TabFacts => ({ live: false, pending: 0, planSignature: "4/4@x", planOpen: 0, scopeMet: false, stopped: false, waitingOnOwn: false, scopeMetAt: null, ...o });

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
    workDirOf: () => "/tmp",
    verbDeps,
    buildItems: async (_p, _w, refs) =>
      refs.map((r) => ({ trigger: r.trigger ?? "question", marvinSessionId: r.marvinSessionId, title: null, delegation: "", turnId: r.turnId, toolUseId: r.toolUseId, question: null, brief: null, plan: null, transcriptTail: "", ledgerTail: [] })),
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
const ended = (tab: string, kind: "human" | "machine" = "human") =>
  emit({ event: "turn.ended", data: { marvinSessionId: tab, projectId: "proj", turnId: `turn-${tab}`, outcome: "completed", kind } });

let loop: SupervisorLoop;
beforeEach(() => {
  vi.useFakeTimers();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5l-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  listeners = [];
  wakes = [];
  facts = {};
  applySupervisorAction(
    {
      projectId: "proj",
      action: "start",
      delegations: [
        { sessionId: "tab-1", level: "answer-questions" },
        { sessionId: "tab-2", level: "observe" },
        { sessionId: "tab-3", level: "answer-confirms" },
      ],
    },
    token(),
  );
  setSupervisorCapsForTests("proj", { idleMs: IDLE_MS, debounceMs: DEBOUNCE });
  loop = new SupervisorLoop(deps());
  loop.start();
});
afterEach(() => {
  loop.stop();
  clearTurnConfirms("turn-tab-3");
  vi.useRealTimers();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the scope-met handoff wakes the supervisor once to read the claim", () => {
  it("a user turn ending scope-met wakes with trigger scope-met; the same close never again", async () => {
    facts["tab-1"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT });
    ended("tab-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => i.trigger))).toEqual([["scope-met"]]);
    ended("tab-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
  });

  it("a machine turn ending scope-met does not (the M4 rule holds)", async () => {
    facts["tab-1"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT });
    ended("tab-1", "machine");
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes).toEqual([]);
  });
});

describe("a finished idle tab is offered for closing — one item, no wake", () => {
  it("past the idle threshold: exactly one close-with-keep item with a single consent action", async () => {
    facts["tab-2"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT });
    ended("tab-2"); // an observe tab: no wake, but the close is still offered
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    const items = listInbox("proj", { state: "open" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: "tab-2", kind: "scope", act: { type: "close", sessionId: "tab-2", worktree: "keep" } });
    expect(wakes).toEqual([]);
    expect(readLedger("proj").find((e) => e.verb === "propose-close")).toMatchObject({ decision: "escalate", inboxItemId: items[0]?.id });
  });

  it("a second pass over the same scope-met close adds no item", async () => {
    facts["tab-2"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT });
    ended("tab-2");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    ended("tab-2");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    proposeCloseKeep("proj", "tab-2", SCOPE_AT);
    expect(listInbox("proj")).toHaveLength(1);
    expect(readLedger("proj").filter((e) => e.verb === "propose-close")).toHaveLength(1);
  });

  it("not while a turn runs, something is pending, or the tab waits on its own job", async () => {
    for (const o of [{ live: true }, { pending: 1 }, { waitingOnOwn: true }]) {
      facts["tab-2"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT, ...o });
      ended("tab-2");
      await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    }
    expect(listInbox("proj")).toEqual([]);
  });

  it("a user message to the tab supersedes the item; a machine turn does not", async () => {
    facts["tab-2"] = baseFacts({ scopeMet: true, scopeMetAt: SCOPE_AT });
    ended("tab-2");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    const [item] = listInbox("proj");
    emit({ event: "turn.registered", data: { marvinSessionId: "tab-2", projectId: "proj", turnId: "t-machine", startedAt: Date.now(), kind: "machine" } });
    expect(getInboxItem("proj", item?.id as string)?.state).toBe("open");
    emit({ event: "turn.registered", data: { marvinSessionId: "tab-2", projectId: "proj", turnId: "t-user", startedAt: Date.now(), kind: "human" } });
    expect(getInboxItem("proj", item?.id as string)).toMatchObject({ state: "superseded" });
  });
});

describe("confirms and items", () => {
  it("an ordinary confirm wakes it for an answer-confirms tab; a containment confirm does not", async () => {
    registerPendingConfirm("turn-tab-3", "tu-edit", vi.fn(), { file_path: "a.ts" }, 0, { toolName: "Edit", raisedBy: "gated" });
    registerPendingConfirm("turn-tab-3", "tu-head", vi.fn(), { command: "git checkout main" }, 0, { toolName: "Bash", raisedBy: "shared-tree" });
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-3", projectId: "proj", turnId: "turn-tab-3", toolUseId: "tu-head", toolName: "Bash" } });
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-3", projectId: "proj", turnId: "turn-tab-3", toolUseId: "tu-edit", toolName: "Edit" } });
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => `${i.trigger}:${i.toolUseId}`))).toEqual([["confirm:tu-edit"]]);
  });

  it("an ordinary confirm does not wake it for an answer-questions tab", async () => {
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-1", projectId: "proj", turnId: "turn-tab-1", toolUseId: "tu-edit", toolName: "Edit" } });
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes).toEqual([]);
  });

  it("an item whose confirm the user answered in the tab resolves on its own", () => {
    const item = addInboxItem("proj", {
      sessionId: "tab-3",
      kind: "integration",
      escalatedBecause: { code: "human-only", label: "push" },
      rawAct: buildRawAct("Bash", { command: "git push" }),
      linkedConfirm: { sessionId: "tab-3", turnId: "turn-tab-3", toolUseId: "tu-push", raisingRule: "gated" },
      act: { type: "confirm", turnId: "turn-tab-3", toolUseId: "tu-push" },
      modeAtCreation: "shadow",
    });
    emit({ event: "confirm.resolved", data: { marvinSessionId: "tab-3", projectId: "proj", turnId: "turn-tab-3", toolUseId: "tu-push", decision: "allow", answeredBy: "user" } });
    expect(getInboxItem("proj", item.id)).toMatchObject({ state: "resolved", resolvedBy: "tab" });
  });

  it("a user message wakes it with the message, and nothing else moves", async () => {
    const item = addInboxItem("proj", { sessionId: null, kind: "integration", escalatedBecause: { code: "human-only", label: "merge" }, act: { type: "worktrees", op: "merge", slugs: ["x"] }, modeAtCreation: "shadow" });
    loop.noteUserMessage("proj", "msg-1");
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes.map((w) => w.items.map((i) => `${i.trigger}:${i.toolUseId}`))).toEqual([["message:msg-1"]]);
    expect(getInboxItem("proj", item.id)?.state).toBe("open");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import type { SessionWatchRow } from "../src/session-watch";
import { listInbox } from "../src/supervisor-inbox";
import { appendLedgerEntry, readLedger } from "../src/supervisor-ledger";
import { defaultVerbDeps, type LoopDeps, SupervisorLoop } from "../src/supervisor-loop";
import { createSupervisorVerbs, type VerbContext, type VerbDeps, type VerbPerform } from "../src/supervisor-mcp";
import { addSupervisorReply, addUserMessage, listMessages, unansweredUserMessages } from "../src/supervisor-messages";
import { ActionLimiter, resolveGround } from "../src/supervisor-policy";
import type { WakeItem } from "../src/supervisor-prompt";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests, setSupervisorCapsForTests } from "../src/supervisor-state";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0128 / plan milestone [7.1] — the channel. A user message wakes the
// supervisor at once and alone; a message that arrives mid-wake holds that
// wake's acts and is carried by the next wake; no user message is ever
// dropped (Kill, pause, a restart); every ledger line of a message wake names
// the message; `reply` exists only in a message wake; a `message:` ground is
// strong only in its own wake.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const DEBOUNCE = 5_000;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m7-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({ action: "start", charter: "Billing page. Postgres, not SQLite.", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
  setSupervisorCapsForTests("proj", { debounceMs: DEBOUNCE });
});
afterEach(() => {
  clearTurnConfirms("turn-tab-1");
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

// ── The loop ────────────────────────────────────────────────────────────────

describe("the message wake", () => {
  let listeners: Array<(e: ProjectEvent) => void>;
  let wakes: Array<{ items: WakeItem[]; verbCtx: VerbContext }>;
  let gate: { release: () => void } | null;
  let conversations: Array<{ wakeId: string; messageIds: string[] } | null>;
  let loop: SupervisorLoop;

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
      verbDeps: (_p, _w, conversation) => {
        conversations.push(conversation ?? null);
        return verbDeps();
      },
      buildItems: async (_p, _w, refs) =>
        refs.map((r) => ({ trigger: r.trigger ?? "question", marvinSessionId: r.marvinSessionId, title: null, delegation: "", turnId: r.turnId, toolUseId: r.toolUseId, question: null, brief: null, plan: null, transcriptTail: "", ledgerTail: [] })),
      runWake: async (a) => {
        wakes.push({ items: a.items, verbCtx: a.verbCtx });
        // A line the dispatch would write: the runtime stamps the wake's origin on it.
        appendLedgerEntry("proj", { kind: "wake", verb: "start", tab: null, wakeId: a.verbCtx.wakeId, reason: "1 item(s)" });
        if (gate) await new Promise<void>((done) => (gate = { release: done }));
        return { ok: true, costUsd: 0 };
      },
      tabFacts: async () => null,
      pendingQuestions: () => [],
    };
  }

  const emit = (e: ProjectEvent) => {
    for (const l of listeners) l(e);
  };
  const question = () => {
    registerPendingConfirm("turn-tab-1", "tu-q", vi.fn(), { questions: [] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    emit({ event: "confirm.pending", data: { marvinSessionId: "tab-1", projectId: "proj", turnId: "turn-tab-1", toolUseId: "tu-q", toolName: "AskUserQuestion" } });
  };
  const message = (text = "What is tab-1 doing?") => {
    const m = addUserMessage("proj", text);
    loop.noteUserMessage("proj", m.id);
    return m;
  };
  const triggers = () => wakes.map((w) => w.items.map((i) => `${i.trigger}:${i.toolUseId}`));

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    wakes = [];
    gate = null;
    conversations = [];
    loop = new SupervisorLoop(deps());
    loop.start();
  });
  afterEach(() => {
    loop.stop();
    vi.useRealTimers();
  });

  it("wakes at once, with no debounce, and carries no tab items", async () => {
    question();
    const m = message();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers()).toEqual([[`message:${m.id}`]]);
    expect(conversations[0]).toMatchObject({ messageIds: [m.id] });
    // The question stays queued for its own, debounced wake.
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(triggers()).toEqual([[`message:${m.id}`], ["question:tu-q"]]);
    expect(conversations[1]).toBeNull();
  });

  it("every ledger line of a message wake names the message; a tab wake's lines name none", async () => {
    const m = message();
    await vi.advanceTimersByTimeAsync(0);
    question();
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    const [first, second] = wakes;
    const lines = readLedger("proj").filter((e) => e.wakeId);
    expect(lines.filter((e) => e.wakeId === first?.verbCtx.wakeId).every((e) => JSON.stringify(e.origin) === JSON.stringify({ kind: "message", messageIds: [m.id] }))).toBe(true);
    expect(lines.filter((e) => e.wakeId === second?.verbCtx.wakeId).every((e) => e.origin === undefined)).toBe(true);
  });

  it("a message arriving mid-wake holds that wake's acts and is carried, at once, by the next wake", async () => {
    gate = { release: () => {} };
    const first = message("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(wakes).toHaveLength(1);
    const second = message("second");
    const third = message("third");
    await vi.advanceTimersByTimeAsync(0);
    expect(wakes[0]?.verbCtx.wake.messageHold).toBe(true);
    expect(wakes).toHaveLength(1);
    gate.release();
    gate = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers()).toEqual([[`message:${first.id}`], [`message:${second.id}`, `message:${third.id}`]]);
  });

  it("a message queued when Kill is pressed is answered after resume", async () => {
    gate = { release: () => {} };
    message("first");
    await vi.advanceTimersByTimeAsync(0);
    const queued = message("queued while it was waking");
    act({ action: "kill" });
    gate.release();
    gate = null;
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes).toHaveLength(1);
    act({ action: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.items.map((i) => i.toolUseId)).toContain(queued.id);
  });

  it("a message sent while paused waits, and is answered on resume", async () => {
    act({ action: "pause" });
    const m = message();
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(wakes).toEqual([]);
    act({ action: "resume" });
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers()).toEqual([[`message:${m.id}`]]);
  });

  it("a message with no reply at shutdown is answered after boot; an answered one is not", async () => {
    loop.stop();
    const answered = addUserMessage("proj", "already answered");
    addSupervisorReply("proj", "Done.", { wakeId: "w-old", origin: { kind: "message", messageIds: [answered.id] } });
    const waiting = addUserMessage("proj", "nobody answered this");
    // A restart: the state reloads from disk and a new loop starts.
    bootSupervisor();
    loop = new SupervisorLoop(deps());
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers()).toEqual([[`message:${waiting.id}`]]);
  });
});

// ── The conversation record ─────────────────────────────────────────────────

describe("messages.jsonl", () => {
  it("a reply round-trips its wakeId and origin, and announces supervisor.message with ids only", () => {
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => seen.push(e));
    const m = addUserMessage("proj", "hello there");
    const r = addSupervisorReply("proj", "Hello.", { wakeId: "w-1", origin: { kind: "message", messageIds: [m.id] } });
    off();
    expect(listMessages("proj")).toEqual([m, r]);
    expect(listMessages("proj")[1]).toMatchObject({ from: "supervisor", wakeId: "w-1", origin: { kind: "message", messageIds: [m.id] } });
    const events = seen.filter((e) => e.event === "supervisor.message").map((e) => e.data);
    expect(events).toEqual([
      { projectId: "proj", id: m.id, from: "user" },
      { projectId: "proj", id: r.id, from: "supervisor" },
    ]);
  });

  it("unanswered: user messages no reply's origin names, and none before a reply without one", () => {
    const old = addUserMessage("proj", "before the legacy reply");
    addSupervisorReply("proj", "a reply from before milestone 7");
    const a = addUserMessage("proj", "a");
    const b = addUserMessage("proj", "b");
    addSupervisorReply("proj", "for a", { wakeId: "w", origin: { kind: "message", messageIds: [a.id] } });
    expect(unansweredUserMessages("proj").map((m) => m.id)).toEqual([b.id]);
    expect(unansweredUserMessages("proj").map((m) => m.id)).not.toContain(old.id);
  });
});

// ── reply ────────────────────────────────────────────────────────────────────

const ctxFor = (deps: VerbDeps, conversation: { messageIds: string[] } | null = null, perform?: VerbPerform): VerbContext => ({
  projectId: "proj",
  workDir: "/tmp",
  wakeId: "wake-1",
  wake: { acts: 0 },
  limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
  deps: perform ? { ...deps, perform } : deps,
  ...(conversation ? { conversation } : {}),
});

describe("reply is the conversation's only", () => {
  it("is refused in a wake a tab started, and nothing reaches messages.jsonl", async () => {
    const out = await createSupervisorVerbs(ctxFor(defaultVerbDeps("proj", "/tmp", null))).reply({ text: "Hi from a tab wake." });
    expect(out).toMatch(/^Refused/);
    expect(listMessages("proj")).toEqual([]);
    expect(readLedger("proj").find((e) => e.verb === "reply")).toMatchObject({ decision: "refuse", reasonCode: "no-conversation" });
  });

  it("in a message wake, posts the reply with the wake and the messages it answers, and ledgers it", async () => {
    const m = addUserMessage("proj", "status please");
    const out = await createSupervisorVerbs(ctxFor(defaultVerbDeps("proj", "/tmp", { wakeId: "wake-1", messageIds: [m.id] }), { messageIds: [m.id] })).reply({ text: "All quiet." });
    expect(out).toBe("Sent to the user.");
    const reply = listMessages("proj").find((x) => x.from === "supervisor");
    expect(reply).toMatchObject({ text: "All quiet.", wakeId: "wake-1", origin: { kind: "message", messageIds: [m.id] } });
    expect(readLedger("proj").find((e) => e.verb === "reply")).toMatchObject({ kind: "message", argSummary: `message ${reply?.id}` });
  });
});

// ── The message ground ──────────────────────────────────────────────────────

describe("message:<id>#<quote>", () => {
  const base = { mainRoot: "/tmp", tabRoot: null, charter: "", brief: null, planStepCount: 0, planSeeded: false, tabStartedAt: null };
  const ground = (id: string, quote: string, wakeMessageIds: string[]) =>
    resolveGround({ kind: "message", ref: `${id}#${quote}` }, { ...base, messages: { lookup: (x) => (x === m.id ? m : null), wakeMessageIds } });
  let m: ReturnType<typeof addUserMessage>;
  beforeEach(() => {
    m = addUserMessage("proj", "Please send tab-1 a nudge to finish the migration step.");
  });

  it("is strong in its own wake and weak in any other", () => {
    expect(ground(m.id, "finish the migration step", [m.id]).provenance).toBe("strong");
    expect(ground(m.id, "finish the migration step", ["another"])).toMatchObject({ provenance: "weak" });
  });

  it("does not resolve a quote that is not in the message, a short quote, or an unknown id", () => {
    expect(ground(m.id, "push to production now", [m.id]).provenance).toBe("unresolved");
    expect(ground(m.id, "nudge", [m.id]).provenance).toBe("unresolved");
    expect(ground("nope", "finish the migration step", ["nope"]).provenance).toBe("unresolved");
    expect(resolveGround({ kind: "message", ref: "no-hash-here" }, { ...base, messages: { lookup: () => m, wakeMessageIds: [m.id] } }).provenance).toBe("unresolved");
  });

  it("does not resolve without a conversation to resolve against", () => {
    expect(resolveGround({ kind: "message", ref: `${m.id}#finish the migration step` }, base).provenance).toBe("unresolved");
  });

  it("a supervisor reply is never a ground", () => {
    const r = addSupervisorReply("proj", "I will finish the migration step for you.");
    const lookup = defaultVerbDeps("proj", "/tmp", null).userRequest;
    expect(lookup?.(r.id)).toBeNull();
  });
});

// ── The mid-wake hold, at the verb ──────────────────────────────────────────

describe("a message arriving mid-wake", () => {
  const row = (): SessionWatchRow =>
    ({
      marvinSessionId: "tab-1",
      projectId: "proj",
      state: "idle",
      worktree: null,
      turn: null,
      activity: null,
      pending: [],
      tree: { mode: "shared", cwd: "/tmp", currentBranch: "main", present: true },
      diff: null,
      plan: { done: 1, total: 4, open: 3, lastTodoAt: null, seeded: true },
      graphUsage: null,
      lastTurn: null,
      cost: { turns: 1, costUsd: 0 },
      title: "Billing",
      updatedAt: new Date().toISOString(),
      posture: null,
      postureRevision: null,
    }) as unknown as SessionWatchRow;

  it("turns an autonomous act into an escalation the user decides", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    const send = vi.fn(async () => ({ ok: true as const, queued: false }));
    const deps: VerbDeps = {
      listRows: async () => [row()],
      getPending: getPendingConfirm,
      readTranscriptTail: () => "",
      readBrief: () => null,
      tabStartedAt: () => null,
      readPlanText: () => "",
      sendRefusal: () => null,
      scopeMet: () => false,
      modelLookup: async () => () => null,
      perform: { ...SHADOW_PERFORM, send },
    };
    const ctx = ctxFor(deps);
    ctx.wake.messageHold = true;
    await createSupervisorVerbs(ctx).send({ marvinSessionId: "tab-1", message: "Carry on with step 2.", kind: "nudge", grounds: [{ kind: "charter", ref: "Postgres, not SQLite" }] });
    expect(send).not.toHaveBeenCalled();
    const line = readLedger("proj").find((e) => e.verb === "send");
    expect(line).toMatchObject({ decision: "escalate", reasonCode: "message-hold" });
    expect(listInbox("proj").find((i) => i.id === line?.inboxItemId)?.state).toBe("open");
  });
});

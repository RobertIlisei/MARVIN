import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import type { SessionWatchRow } from "../src/session-watch";
import { buildSupervisorAuditPacket, supervisorAuditCandidates } from "../src/supervisor-audit";
import { actionsFor, addInboxItem, getInboxItem, listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { appendLedgerEntry, type LedgerEntry, readLedger, setWakeOrigin } from "../src/supervisor-ledger";
import { type LoopDeps, SupervisorLoop } from "../src/supervisor-loop";
import { createSupervisorVerbs, type VerbContext, type VerbDeps } from "../src/supervisor-mcp";
import { addSupervisorReply, addUserMessage, listMessages } from "../src/supervisor-messages";
import { ActionLimiter } from "../src/supervisor-policy";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests, setSupervisorCapsForTests } from "../src/supervisor-state";
import { computeSupervisorStats } from "../src/supervisor-status";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0128 / plan milestone [7.2] — in-chat cards are inbox items. An item a
// message wake raises carries that wake's origin; a reply lists only those
// items; a request the supervisor may not perform becomes a card in a message
// wake and stays a refusal elsewhere; no text consents; a send card can be
// edited, and the edit is checked again and recorded; chat-origin lines leave
// the agreement stats; the auditor gains a `consent` lead. Plus the carried
// [7.1] review fix: an unanswered message wake is retried, then shown as failed.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m72-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({
    action: "start",
    delegations: [
      { sessionId: "tab-1", level: "answer-questions" },
      { sessionId: "tab-obs", level: "observe" },
      { sessionId: "tab-conf", level: "answer-confirms" },
    ],
  });
});
afterEach(() => {
  clearTurnConfirms("turn-tab-conf");
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const row = (id: string, extra: Partial<SessionWatchRow> = {}): SessionWatchRow =>
  ({
    marvinSessionId: id,
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
    title: `title of ${id}`,
    updatedAt: new Date().toISOString(),
    posture: null,
    postureRevision: null,
    ...extra,
  }) as unknown as SessionWatchRow;

const performSpy = () => ({
  send: vi.fn(async () => ({ ok: true as const, queued: false })),
  confirm: vi.fn(() => ({ ok: true as const })),
  answer: vi.fn(() => ({ ok: true as const })),
});

function depsWith(spy: ReturnType<typeof performSpy>, extra: Partial<VerbDeps> = {}): VerbDeps {
  return {
    listRows: async () => [row("tab-1"), row("tab-obs"), row("tab-conf", { turn: { turnId: "turn-tab-conf", kind: "human", mutated: false } as never })],
    listTabs: () => [
      { id: "tab-1", title: "title of tab-1" },
      { id: "tab-obs", title: "title of tab-obs" },
      { id: "tab-conf", title: "title of tab-conf" },
      { id: "tab-off", title: "fix-flags" },
    ],
    getPending: getPendingConfirm,
    readTranscriptTail: () => "",
    readBrief: () => null,
    tabStartedAt: () => null,
    readPlanText: () => "",
    sendRefusal: () => null,
    scopeMet: () => false,
    modelLookup: async () => () => null,
    userRequest: (id) => {
      const m = listMessages("proj").find((x) => x.id === id && x.from === "user");
      return m ? { id: m.id, at: m.at, text: m.text } : null;
    },
    postReply: (text, items) => addSupervisorReply("proj", text, { wakeId: "wake-1", origin: { kind: "message", messageIds: [current.id] }, items }),
    worktrees: {
      list: async () => [{ slug: "fix-flags", state: "ready" } as never],
      preview: async () => ({ kind: "merge-tree", verdict: "clean", added: 120, removed: 8, conflictFiles: [] }),
      sweep: async () => [],
    },
    perform: { ...SHADOW_PERFORM, ...spy },
    ...extra,
  };
}

let current: ReturnType<typeof addUserMessage>;

/** A message wake for `text`: the runtime names its origin before any line is written. */
function messageWake(text: string, deps: VerbDeps, wakeId = "wake-1", images: Parameters<typeof addUserMessage>[2] = []): VerbContext {
  current = addUserMessage("proj", text, images);
  setWakeOrigin(wakeId, { kind: "message", messageIds: [current.id] });
  return { projectId: "proj", workDir: "/tmp", wakeId, wake: { acts: 0 }, limiter: new ActionLimiter(() => getSupervisorState("proj").caps), deps, conversation: { messageIds: [current.id] } };
}

function tabWake(deps: VerbDeps): VerbContext {
  return { projectId: "proj", workDir: "/tmp", wakeId: "wake-tab", wake: { acts: 0 }, limiter: new ActionLimiter(() => getSupervisorState("proj").caps), deps, conversation: null };
}

const ground = (quote: string) => [{ kind: "message" as const, ref: `${current.id}#${quote}` }];

const fullPerform = (worktrees: InboxPerform["worktrees"], send: InboxPerform["send"] = async () => ({ ok: true })): InboxPerform => ({
  answer: () => ({ ok: true }),
  confirm: () => ({ ok: true }),
  posture: async () => ({ ok: true }),
  send,
  cancel: () => ({ ok: true }),
  worktrees,
  close: async () => ({ ok: true }),
  openTab: async () => ({ ok: true, marvinSessionId: "new" }),
  supervisor: () => ({ ok: true }) as never,
  modelLookup: async () => () => null,
});

afterEach(() => {
  setWakeOrigin("wake-1", null);
  setWakeOrigin("wake-2", null);
});

// ── "Merge tab X" is a card, and only a card ───────────────────────────────

describe("a human-only request in the conversation", () => {
  it("is exactly one integration item with its preview, origin the message, and nothing performed", async () => {
    const spy = performSpy();
    const ctx = messageWake("Merge tab fix-flags into development please", depsWith(spy));
    const out = await createSupervisorVerbs(ctx).worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground("Merge tab fix-flags") });
    expect(out).toMatch(/^Escalated/);
    const items = listInbox("proj");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "integration", state: "open", preview: { verdict: "clean", added: 120 }, origin: { kind: "message", messageIds: [current.id] } });
    expect(Object.values(spy).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(readLedger("proj").find((e) => e.verb === "worktrees.merge")).toMatchObject({ decision: "escalate", origin: { kind: "message", messageIds: [current.id] } });
  });

  it("settles once: one perform as the user, one resolved event, a second click answers in-flight then settled", async () => {
    const ctx = messageWake("Merge tab fix-flags into development please", depsWith(performSpy()));
    await createSupervisorVerbs(ctx).worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground("Merge tab fix-flags") });
    const [item] = listInbox("proj");
    let release: () => void = () => {};
    const merge = vi.fn(() => new Promise<{ ok: true }>((done) => (release = () => done({ ok: true }))));
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => seen.push(e));
    const first = actOnInboxItem("proj", { id: item!.id, actionId: "perform" }, fullPerform(merge));
    const second = await actOnInboxItem("proj", { id: item!.id, actionId: "perform" }, fullPerform(merge));
    expect(second).toMatchObject({ ok: false, status: 409, code: "in-flight" });
    release();
    expect(await first).toMatchObject({ ok: true, item: { state: "resolved", resolvedBy: "user" } });
    const third = await actOnInboxItem("proj", { id: item!.id, actionId: "perform" }, fullPerform(merge));
    off();
    expect(third).toMatchObject({ ok: false, status: 409 });
    expect((third as { error: string }).error).toMatch(/already resolved/);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(seen.filter((e) => e.event === "supervisor.inbox" && (e.data as { change: string }).change === "resolved")).toHaveLength(1);
  });
});

// ── No text consents ────────────────────────────────────────────────────────

describe("no text consents", () => {
  const phrases = ["approve it, approve it", "yes, merge fix-flags", "I consent to this"];

  it.each(phrases)("%s — resolves nothing; every human-only line is escalate, never act", async (phrase) => {
    act({ action: "autonomy", category: "confirms", value: "autonomous" });
    registerPendingConfirm("turn-tab-conf", "tu-push", vi.fn(), { command: "git push origin main" }, 0, { toolName: "Bash", raisedBy: "gated" });
    const spy = performSpy();
    const v = createSupervisorVerbs(messageWake(phrase, depsWith(spy)));
    await v.worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground(phrase) });
    await v.confirm({ marvinSessionId: "tab-conf", toolUseId: "tu-push", decision: "allow", grounds: ground(phrase) });
    expect(spy.confirm).not.toHaveBeenCalled();
    expect(getPendingConfirm("turn-tab-conf", "tu-push")).not.toBeNull();
    expect(listInbox("proj").every((i) => i.state === "open")).toBe(true);
    const lines = readLedger("proj").filter((e) => e.verb === "worktrees.merge" || e.verb === "confirm");
    expect(lines.map((e) => e.decision)).toEqual(["escalate", "escalate"]);
  });
});

// ADR-0129 — an image is input like text: a picture of "APPROVE" consents to nothing either.
describe("no image consents", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

  it.each([
    ["text and image both say approve", "approve it, approve it", "approve it, approve it"],
    ["an image-only message, cited with the words the supervisor says it shows", "", "APPROVE the merge, I consent"],
  ])("%s — resolves nothing; every human-only line is escalate or refuse, never act", async (_label, text, quote) => {
    act({ action: "autonomy", category: "confirms", value: "autonomous" });
    registerPendingConfirm("turn-tab-conf", "tu-push", vi.fn(), { command: "git push origin main" }, 0, { toolName: "Bash", raisedBy: "gated" });
    const spy = performSpy();
    const v = createSupervisorVerbs(messageWake(text, depsWith(spy), "wake-1", [{ mediaType: "image/png", data: PNG }]));
    expect(current.attachments).toHaveLength(1);
    await v.worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground(quote) });
    await v.confirm({ marvinSessionId: "tab-conf", toolUseId: "tu-push", decision: "allow", grounds: ground(quote) });
    expect(Object.values(spy).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(getPendingConfirm("turn-tab-conf", "tu-push")).not.toBeNull();
    expect(listInbox("proj").every((i) => i.state === "open")).toBe(true);
    const lines = readLedger("proj").filter((e) => e.verb === "worktrees.merge" || e.verb === "confirm");
    expect(lines).toHaveLength(2);
    expect(lines.every((e) => e.decision === "escalate" || e.decision === "refuse")).toBe(true);
  });
});

// ── Cards, not refusals — in a message wake only ───────────────────────────

describe("a request the supervisor may not perform", () => {
  const send = (v: ReturnType<typeof createSupervisorVerbs>, tab: string) =>
    v.send({ marvinSessionId: tab, message: "Please carry on with step 2 of the plan.", kind: "instruction", grounds: ground("carry on with step 2") });

  it("a shadow-category send is one card in a message wake, a proposal in a tab wake", async () => {
    const spy = performSpy();
    await send(createSupervisorVerbs(messageWake("Ask tab-1 to carry on with step 2", depsWith(spy))), "tab-1");
    const items = listInbox("proj");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "scope", sessionId: "tab-1", escalatedBecause: { code: "shadow" }, act: { type: "send" } });
    expect(spy.send).not.toHaveBeenCalled();
    await createSupervisorVerbs(tabWake(depsWith(spy))).send({ marvinSessionId: "tab-1", message: "Carry on with step 2.", kind: "instruction", grounds: [{ kind: "plan", ref: "[2]" }] });
    expect(listInbox("proj")).toHaveLength(1);
  });

  it("a send to an observe tab is one card (delegation-observe) in a message wake, a refusal in a tab wake", async () => {
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    const spy = performSpy();
    await send(createSupervisorVerbs(messageWake("Ask tab-obs to carry on with step 2", depsWith(spy))), "tab-obs");
    const items = listInbox("proj");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: "tab-obs", escalatedBecause: { code: "delegation-observe" } });
    expect(spy.send).not.toHaveBeenCalled();
    const out = await createSupervisorVerbs(tabWake(depsWith(spy))).send({ marvinSessionId: "tab-obs", message: "Carry on with step 2.", kind: "instruction", grounds: [{ kind: "plan", ref: "[2]" }] });
    expect(out).toMatch(/^Refused/);
    expect(listInbox("proj")).toHaveLength(1);
  });

  it("an off tab gets no card; `sessions` lists it by title and level only", async () => {
    const spy = performSpy();
    const v = createSupervisorVerbs(messageWake("Ask fix-flags to carry on with step 2", depsWith(spy)));
    expect(await send(v, "tab-off")).toMatch(/^Refused/);
    expect(listInbox("proj")).toEqual([]);
    const listed = JSON.parse(await v.sessions()) as Array<Record<string, unknown>>;
    expect(listed.find((r) => r.marvinSessionId === "tab-off")).toEqual({ marvinSessionId: "tab-off", title: "fix-flags", delegation: "off" });
    expect(listed.filter((r) => r.delegation !== "off").map((r) => r.marvinSessionId).sort()).toEqual(["tab-1", "tab-conf", "tab-obs"]);
  });

  it("an observe tab's ordinary confirm is a card in a message wake, refused in a tab wake", async () => {
    act({ action: "autonomy", category: "confirms", value: "autonomous" });
    registerPendingConfirm("turn-tab-obs", "tu-edit", vi.fn(), { file_path: "/tmp/a.ts" }, 0, { toolName: "Edit", raisedBy: "gated" });
    const deps = (spy: ReturnType<typeof performSpy>) => depsWith(spy, { listRows: async () => [row("tab-obs", { turn: { turnId: "turn-tab-obs", kind: "human", mutated: false } as never })] });
    const spy = performSpy();
    await createSupervisorVerbs(messageWake("Allow the edit in tab-obs", deps(spy))).confirm({ marvinSessionId: "tab-obs", toolUseId: "tu-edit", decision: "allow", grounds: ground("Allow the edit in") });
    expect(listInbox("proj")).toHaveLength(1);
    expect(listInbox("proj")[0]?.escalatedBecause.code).toBe("delegation-observe");
    expect(await createSupervisorVerbs(tabWake(deps(spy))).confirm({ marvinSessionId: "tab-obs", toolUseId: "tu-edit", decision: "allow", grounds: [{ kind: "plan", ref: "[2]" }] })).toMatch(/^Refused/);
    expect(spy.confirm).not.toHaveBeenCalled();
    clearTurnConfirms("turn-tab-obs");
  });
});

// ── The reply's items ───────────────────────────────────────────────────────

describe("a reply lists only its own wake's items", () => {
  it("drops another wake's item, a tab escalation and a made-up id; keeps its own; round-trips", async () => {
    // Another wake's item, for another message.
    const other = messageWake("Merge tab fix-flags into development please", depsWith(performSpy()), "wake-2");
    await createSupervisorVerbs(other).worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground("Merge tab fix-flags") });
    const foreign = listInbox("proj")[0]!;
    // A tab's escalation, no origin.
    const tabItem = addInboxItem("proj", { sessionId: "tab-1", kind: "question", escalatedBecause: { code: "heuristic", label: "x" }, modeAtCreation: "shadow" });
    // This wake's own.
    const ctx = messageWake("Merge tab fix-flags into development please", depsWith(performSpy()));
    const v = createSupervisorVerbs(ctx);
    await v.worktrees({ op: "merge", slugs: ["fix-flags"], grounds: ground("Merge tab fix-flags") });
    const own = listInbox("proj").find((i) => i.origin?.kind === "message" && i.origin.messageIds[0] === current.id)!;
    expect(await v.reply({ text: "Here is the merge you asked for.", items: [own.id, foreign.id, tabItem.id, "made-up", own.id] })).toBe("Sent to the user.");
    const reply = listMessages("proj").find((m) => m.from === "supervisor");
    expect(reply?.items).toEqual([own.id]);
    expect(listMessages("proj").find((m) => m.id === reply?.id)).toEqual(reply);
  });
});

// ── The send card's edit ────────────────────────────────────────────────────

describe("an editable send card", () => {
  async function sendCard() {
    await createSupervisorVerbs(messageWake("Ask tab-1 to carry on with step 2", depsWith(performSpy()))).send({
      marvinSessionId: "tab-1",
      message: "Please carry on with step 2 of the plan.",
      kind: "instruction",
      grounds: ground("carry on with step 2"),
    });
    return listInbox("proj")[0]!;
  }

  it("offers an edit beside the send", async () => {
    const item = await sendCard();
    expect(actionsFor(item).map((a) => [a.id, a.role, a.requiresExpanded])).toEqual([
      ["perform", "consent", false],
      ["edit", "edit", false],
      ["dismiss", "dismiss", false],
    ]);
  });

  it("delivers the edited text, marked editedByUser, and ledgers it so", async () => {
    const item = await sendCard();
    const send = vi.fn(async () => ({ ok: true as const }));
    const r = await actOnInboxItem("proj", { id: item.id, actionId: "edit", edits: { text: "Carry on with step 2, and run the tests first." } }, fullPerform(async () => ({ ok: true }), send));
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "tab-1", text: "Carry on with step 2, and run the tests first.", kind: "instruction", editedByUser: true }));
    expect(readLedger("proj").find((e) => e.kind === "inbox")).toMatchObject({ inboxItemId: item.id, editedByUser: true });
  });

  it("refuses an edit carrying a secret, or empty, and leaves the item open", async () => {
    const item = await sendCard();
    const send = vi.fn(async () => ({ ok: true as const }));
    const secret = await actOnInboxItem("proj", { id: item.id, actionId: "edit", edits: { text: "use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }, fullPerform(async () => ({ ok: true }), send));
    expect(secret).toMatchObject({ ok: false, status: 400, code: "secret" });
    expect(await actOnInboxItem("proj", { id: item.id, actionId: "edit", edits: { text: "  " } }, fullPerform(async () => ({ ok: true }), send))).toMatchObject({ ok: false, status: 400 });
    expect(send).not.toHaveBeenCalled();
    expect(getInboxItem("proj", item.id)?.state).toBe("open");
  });

  it("an unedited send carries editedByUser false", async () => {
    const item = await sendCard();
    const send = vi.fn(async () => ({ ok: true as const }));
    await actOnInboxItem("proj", { id: item.id, actionId: "perform" }, fullPerform(async () => ({ ok: true }), send));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "Please carry on with step 2 of the plan.", editedByUser: false }));
  });
});

// ── Stats and audit ─────────────────────────────────────────────────────────

describe("chat-origin lines", () => {
  const line = (e: Partial<LedgerEntry>): LedgerEntry => ({ at: new Date().toISOString(), projectId: "proj", kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w", reason: "", ...e }) as LedgerEntry;
  const chat = { kind: "message" as const, messageIds: ["m1"] };

  it("leave the agreement stats and still count as human-only proposed as act", () => {
    const stats = computeSupervisorStats([
      line({ id: "p1", decision: "propose", toolUseId: "a" }),
      line({ kind: "pairing", proposalId: "p1", pairing: { actualAnswer: ["x"], answeredBy: "user", agreement: "agree", proposalSeenBeforeAnswer: false } }),
      line({ id: "p2", decision: "propose", toolUseId: "b", origin: chat }),
      line({ kind: "pairing", proposalId: "p2", pairing: { actualAnswer: ["x"], answeredBy: "user", agreement: "disagree", proposalSeenBeforeAnswer: false } }),
      line({ verb: "confirm", decision: "escalate", reasonCode: "human-only", origin: chat }),
    ]);
    expect(stats.questions).toMatchObject({ proposals: 1, agreed: 1, agreementRate: 1 });
    expect(stats.confirms.humanOnlyProposedAsAct).toBe(1);
  });

  it("a chat-origin §4 act with no settled card behind it is a consent lead; one with its card settled by the user is not", async () => {
    appendLedgerEntry("proj", { kind: "verb", verb: "worktrees.merge", tab: null, wakeId: "w1", decision: "act", reason: "merged", origin: chat });
    const settled = addInboxItem("proj", { sessionId: "tab-1", kind: "scope", escalatedBecause: { code: "human-only", label: "x" }, modeAtCreation: "shadow", act: { type: "close", sessionId: "tab-1", worktree: "keep" } });
    expect(await actOnInboxItem("proj", { id: settled.id, actionId: "perform" }, fullPerform(async () => ({ ok: true })))).toMatchObject({ ok: true });
    appendLedgerEntry("proj", { kind: "verb", verb: "close_session", tab: "tab-1", wakeId: "w2", decision: "act", reason: "x", origin: chat, inboxItemId: settled.id });
    // The same act from a tab wake is not a conversation's, so not this lead.
    appendLedgerEntry("proj", { kind: "verb", verb: "worktrees.drop", tab: null, wakeId: "w3", decision: "act", reason: "dropped" });
    const leads = supervisorAuditCandidates(buildSupervisorAuditPacket("proj", {})).filter((c) => c.class === "consent");
    expect(leads).toHaveLength(1);
    expect(leads[0]?.why).toMatch(/worktrees\.merge/);
  });
});

// ── [7.1] review fix — an unanswered message wake is retried ───────────────

describe("a message wake that fails or ends without a reply", () => {
  let listeners: Array<(e: ProjectEvent) => void>;
  let outcomes: Array<"fail" | "silent" | "reply">;
  let wakes: number;
  let loop: SupervisorLoop;

  function deps(): LoopDeps {
    return {
      subscribe: (l) => {
        listeners.push(l);
        return () => {};
      },
      workDirOf: () => "/tmp",
      verbDeps: () => depsWith(performSpy()),
      buildItems: async (_p, _w, refs) => refs.map((r) => ({ trigger: r.trigger ?? "question", marvinSessionId: "", title: null, delegation: "", turnId: "", toolUseId: r.toolUseId, question: null, brief: null, plan: null, transcriptTail: "", ledgerTail: [] })),
      runWake: async (a) => {
        wakes += 1;
        const o = outcomes.shift() ?? "silent";
        if (o === "fail") return { ok: false, error: "model overloaded", costUsd: 0 };
        if (o === "reply") addSupervisorReply("proj", "Answered.", { wakeId: a.verbCtx.wakeId as string, origin: { kind: "message", messageIds: a.verbCtx.conversation?.messageIds ?? [] } });
        return { ok: true, costUsd: 0 };
      },
      tabFacts: async () => null,
      pendingQuestions: () => [],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    wakes = 0;
    setSupervisorCapsForTests("proj", { debounceMs: 5_000 });
    loop = new SupervisorLoop(deps());
    loop.start();
  });
  afterEach(() => {
    loop.stop();
    vi.useRealTimers();
  });

  it("is retried with backoff until it is answered", async () => {
    outcomes = ["fail", "silent", "reply"];
    const m = addUserMessage("proj", "status?");
    loop.noteUserMessage("proj", m.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(wakes).toBe(1);
    expect(loop.snapshot("proj").messageRetry).toMatchObject({ state: "retrying", messageIds: [m.id], attempts: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wakes).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wakes).toBe(3);
    expect(loop.snapshot("proj").messageRetry).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(wakes).toBe(3);
  });

  it("stops at the cap and shows the message as failed; Restart retries it", async () => {
    outcomes = ["fail", "fail", "fail", "fail"];
    const m = addUserMessage("proj", "status?");
    loop.noteUserMessage("proj", m.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(wakes).toBe(4); // one wake and three retries
    expect(loop.snapshot("proj").messageRetry).toMatchObject({ state: "failed", messageIds: [m.id], nextRetryAt: null });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(wakes).toBe(4);
    outcomes = ["reply"];
    act({ action: "wakeNow" });
    await vi.advanceTimersByTimeAsync(0);
    expect(wakes).toBe(5);
    expect(loop.snapshot("proj").messageRetry).toBeNull();
  });

  it("a killed wake is not retried on its own", async () => {
    outcomes = ["fail"];
    const m = addUserMessage("proj", "status?");
    loop.noteUserMessage("proj", m.id);
    await vi.advanceTimersByTimeAsync(0);
    act({ action: "kill" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(wakes).toBe(1);
  });
});

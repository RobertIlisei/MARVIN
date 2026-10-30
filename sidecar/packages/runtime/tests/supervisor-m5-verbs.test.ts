import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfirm } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import type { SessionWatchRow } from "../src/session-watch";
import { listInbox } from "../src/supervisor-inbox";
import { readLedger } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext, type VerbDeps, type VerbPerform } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";
import { isTurnTouched, resetTouchesForTests } from "../src/supervisor-touch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0127 milestone 5 — the remaining verbs, and every escalation as an inbox
// item. Nothing on the §4 list is performed by a verb: it becomes an item that
// shows the raw act, with the supervisor's recommendation beside it.

let dataDir: string;
let mainRoot: string;
const prev = process.env.MARVIN_DATA_DIR;
const P = "proj";
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: P, ...body }, token());
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "agent" as const, personality: "marvin" as const };
const CHARTER = [{ kind: "charter" as const, ref: "Postgres, not SQLite" }];

function row(id: string, overrides: Partial<SessionWatchRow> = {}): SessionWatchRow {
  return {
    marvinSessionId: id,
    projectId: P,
    state: "awaiting-you",
    worktree: null,
    turn: { turnId: `turn-${id}`, kind: "human", startedAt: new Date().toISOString(), mutated: false },
    activity: null,
    pending: [],
    tree: { mode: "worktree", cwd: mainRoot, path: mainRoot, currentBranch: "marvin/tab/x", present: true },
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
let scopeMetAt: Record<string, string | null>;
let requests: Record<string, { id: string; at: string; text: string }>;
let perform: VerbPerform & { confirm: ReturnType<typeof vi.fn> };
let sweep: ReturnType<typeof vi.fn>;
let ctx: VerbContext;
const verbs = () => createSupervisorVerbs(ctx);

function deps(): VerbDeps {
  return {
    listRows: async () => rows,
    getPending: getPendingConfirm,
    readTranscriptTail: () => "",
    readBrief: () => "Build the billing page.",
    tabStartedAt: () => null,
    readPlanText: () => "",
    sendRefusal: () => null,
    scopeMet: (tab: string) => !!scopeMetAt[tab],
    scopeMetAt: (tab: string) => scopeMetAt[tab] ?? null,
    modelLookup: async () => (id: string) => ({ "claude-opus-5-5": { tier: "opus" }, "claude-sonnet-5-5": { tier: "sonnet" }, "claude-haiku-4-5": { tier: "haiku" } })[id] ?? null,
    modelLabel: async (id: string) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : id),
    worktrees: {
      list: async () => [
        { slug: "tab-ready", branch: "marvin/tab/ready", state: "ready", commits: 2, dirty: false },
        { slug: "tab-open", branch: "marvin/tab/open", state: "session", sessionId: "tab-1", commits: 1, dirty: true },
      ],
      preview: async () => ({ kind: "merge-tree", verdict: "behind", behind: 2, added: 12, removed: 4, conflictFiles: [] }),
      sweep: sweep as never,
    },
    userRequest: (id: string) => requests[id] ?? null,
    newTabBase: async () => ({ posture: POSTURE, baseRef: "main", baseSha: "abc1234" }),
    perform,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5v-data-"));
  mainRoot = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5v-main-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({
    action: "start",
    charter: "Billing page. Postgres, not SQLite.",
    delegations: [
      { sessionId: "tab-1", level: "answer-confirms" },
      { sessionId: "tab-2", level: "answer-questions" },
      { sessionId: "tab-3", level: "observe" },
    ],
  });
  for (const id of ["tab-1", "tab-2", "tab-3"]) upsertSessionMeta(P, id, { workDir: mainRoot, tree: { mode: "shared" }, posture: POSTURE });
  rows = [row("tab-1"), row("tab-2"), row("tab-3")];
  scopeMetAt = {};
  requests = {};
  sweep = vi.fn(async () => [{ slug: "tab-old", branch: "marvin/tab/old", state: "merged", deletedBranch: true, removedCheckout: true, reason: "merged" }]);
  perform = {
    ...SHADOW_PERFORM,
    confirm: vi.fn((a: Parameters<VerbPerform["confirm"]>[0]) => resolveConfirm({ ...a, answeredBy: "supervisor" })),
  } as never;
  ctx = { projectId: P, workDir: mainRoot, wakeId: "wake-1", wake: { acts: 0 }, limiter: new ActionLimiter(() => getSupervisorState(P).caps), deps: deps() };
});
afterEach(() => {
  for (const id of ["tab-1", "tab-2", "tab-3"]) clearTurnConfirms(`turn-${id}`);
  resetTouchesForTests();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

function pendingEdit(tab: string, toolUseId: string, input: Record<string, unknown>, raisedBy: "gated" | "shared-tree" | "metered-ci" | "session-worktree", toolName = "Edit") {
  const resolver = vi.fn();
  registerPendingConfirm(`turn-${tab}`, toolUseId, resolver, input, 0, { toolName, raisedBy });
  return resolver;
}

describe("escalations become inbox items showing the raw act", () => {
  it("a §4 confirm the supervisor recommends: an item with the raw act, the recommendation separate, linked to the confirm", async () => {
    pendingEdit("tab-1", "tu-push", { command: "git push origin marvin/tab/x" }, "gated", "Bash");
    const reply = await verbs().confirm({ marvinSessionId: "tab-1", toolUseId: "tu-push", decision: "allow", message: "the plan ends with a push", grounds: CHARTER });
    expect(reply).toMatch(/Escalated/);
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({
      kind: "integration",
      sessionId: "tab-1",
      escalatedBecause: { code: "human-only" },
      rawAct: { toolName: "Bash", summary: "git push origin marvin/tab/x", outward: true },
      linkedConfirm: { sessionId: "tab-1", toolUseId: "tu-push", raisingRule: "gated" },
      recommendation: { actionId: "allow", text: "the plan ends with a push" },
    });
    const line = readLedger(P).find((e) => e.verb === "confirm");
    expect(line).toMatchObject({ decision: "escalate", inboxItemId: item?.id });
    expect(item?.ledgerId).toBe(line?.id);
    expect(perform.confirm).not.toHaveBeenCalled();
  });

  it("a heuristic-flagged question becomes a question item carrying the question and the proposed answer", async () => {
    registerPendingConfirm("turn-tab-2", "tu-q", vi.fn(), { questions: [{ question: "Push now?", header: "Push", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    await verbs().answer({ marvinSessionId: "tab-2", toolUseId: "tu-q", answers: { "Push now?": "Yes" }, grounds: CHARTER });
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({ kind: "question", heuristic: { matched: "push" }, escalatedBecause: { code: "heuristic" }, recommendation: { answer: { "Push now?": "Yes" } } });
    expect((item?.question as { questions: unknown[] }).questions).toHaveLength(1);
  });

  it("a widening becomes a posture-widen item with from, to and the widened dimensions", async () => {
    await verbs().set_posture({ marvinSessionId: "tab-2", posture: { permissionStrategy: "full" }, grounds: CHARTER });
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({ kind: "posture-widen", postureChange: { from: { permissionStrategy: "gated" }, to: { permissionStrategy: "full" }, widenedDimensions: ["permissionStrategy"] } });
  });

  it("a refusal is the supervisor's mistake, not the user's decision: no item", async () => {
    await verbs().send({ marvinSessionId: "tab-2", message: "carry on", kind: "nudge", grounds: [] });
    expect(listInbox(P)).toEqual([]);
  });
});

describe("confirms autonomy respects the level", () => {
  beforeEach(() => {
    expect(act({ action: "autonomy", category: "confirms", value: "autonomous" }).ok).toBe(true);
  });

  it("an ordinary Edit confirm in a gated answer-confirms tab is answered by the supervisor, and the turn is touched", async () => {
    const live = registerLiveTurn({ turnId: "turn-tab-1", marvinSessionId: "tab-1", projectId: P, kind: "human" });
    const resolver = pendingEdit("tab-1", "tu-edit", { file_path: "src/billing.ts", old_string: "a", new_string: "b" }, "gated");
    try {
      const reply = await verbs().confirm({ marvinSessionId: "tab-1", toolUseId: "tu-edit", decision: "allow", grounds: CHARTER });
      expect(reply).toMatch(/Allowed/);
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
      expect(readLedger(P).find((e) => e.verb === "confirm")).toMatchObject({ decision: "act", mode: "autonomous" });
      expect(isTurnTouched("turn-tab-1")).toBe(true);
      expect(readSessionMeta(P, "tab-1")?.supervisorTouched).toMatchObject({ turnId: "turn-tab-1", by: "confirm" });
    } finally {
      endLiveTurn(live, { event: "turn.completed", data: {} });
    }
  });

  it("the service is a second lock: a gated card carrying a §4 act is refused to the supervisor", () => {
    const resolver = pendingEdit("tab-1", "tu-push", { command: "git push origin HEAD" }, "gated", "Bash");
    expect(resolveConfirm({ turnId: "turn-tab-1", toolUseId: "tu-push", decision: "allow", answeredBy: "supervisor" })).toMatchObject({ ok: false, status: 409 });
    expect(resolver).not.toHaveBeenCalled();
    expect(resolveConfirm({ turnId: "turn-tab-1", toolUseId: "tu-push", decision: "allow", answeredBy: "user" })).toMatchObject({ ok: true });
  });

  it("the same confirm in an answer-questions tab is not answered", async () => {
    const resolver = pendingEdit("tab-2", "tu-edit", { file_path: "src/billing.ts", old_string: "a", new_string: "b" }, "gated");
    await verbs().confirm({ marvinSessionId: "tab-2", toolUseId: "tu-edit", decision: "allow", grounds: CHARTER });
    expect(resolver).not.toHaveBeenCalled();
    expect(readLedger(P).find((e) => e.verb === "confirm")).toMatchObject({ decision: "refuse", reasonCode: "delegation" });
  });

  it.each([
    ["shared-tree", "Bash", { command: "git checkout main" }],
    ["session-worktree", "Edit", { file_path: "/elsewhere/x.ts", old_string: "a", new_string: "b" }],
    ["metered-ci", "Bash", { command: "glab ci run" }],
  ] as const)("a %s confirm is never answered, at any level — it escalates", async (rule, toolName, input) => {
    const resolver = pendingEdit("tab-1", "tu-c", input, rule, toolName);
    await verbs().confirm({ marvinSessionId: "tab-1", toolUseId: "tu-c", decision: "allow", grounds: CHARTER });
    expect(resolver).not.toHaveBeenCalled();
    expect(perform.confirm).not.toHaveBeenCalled();
    expect(readLedger(P).find((e) => e.verb === "confirm")?.decision).toBe("escalate");
    expect(listInbox(P, { state: "open" })[0]?.kind).toBe(rule === "metered-ci" ? "integration" : "containment");
  });

  it("in shadow it proposes and answers nothing", async () => {
    act({ action: "autonomy", category: "confirms", value: "shadow" });
    const resolver = pendingEdit("tab-1", "tu-edit", { file_path: "src/billing.ts", old_string: "a", new_string: "b" }, "gated");
    await verbs().confirm({ marvinSessionId: "tab-1", toolUseId: "tu-edit", decision: "allow", grounds: CHARTER });
    expect(resolver).not.toHaveBeenCalled();
    expect(readLedger(P).find((e) => e.verb === "confirm")?.decision).toBe("propose");
  });
});

describe("the worktrees verb — sweep performed, everything else escalated with a preview", () => {
  it("lists and previews live", async () => {
    expect(await verbs().worktrees({ op: "list" })).toContain("tab-ready");
    expect(await verbs().worktrees({ op: "preview", slugs: ["tab-ready"] })).toContain("behind");
  });

  it("sweep reclaims what the safe sweep reclaims, and is ledgered as an act", async () => {
    const reply = await verbs().worktrees({ op: "sweep" });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(reply).toContain("tab-old");
    expect(readLedger(P).find((e) => e.verb === "worktrees.sweep")).toMatchObject({ decision: "act", reasonCode: "safe-sweep" });
  });

  it.each(["merge", "merge-all", "prepare-mr", "drop"] as const)("%s always escalates, never performs", async (op) => {
    await verbs().worktrees({ op, slugs: ["tab-ready"], recommendation: "clean and two behind", grounds: CHARTER });
    const [item] = listInbox(P, { state: "open" });
    expect(item?.kind).toBe(op === "drop" ? "discard" : "integration");
    expect(item?.rawAct?.toolName).toBe(`worktrees.${op}`);
    if (op !== "drop") expect(item?.preview).toMatchObject({ kind: "merge-tree", verdict: "behind", behind: 2 });
    expect(readLedger(P).find((e) => e.verb === `worktrees.${op}`)?.decision).toBe("escalate");
    expect(sweep).not.toHaveBeenCalled();
  });

  it("an open tab's own tree is not the supervisor's to merge or drop", async () => {
    expect(await verbs().worktrees({ op: "drop", slugs: ["tab-open"], grounds: CHARTER })).toMatch(/Refused/);
    expect(listInbox(P)).toEqual([]);
  });
});

describe("close_session and the scope review", () => {
  it("close_session refuses a tab with a turn running", async () => {
    expect(await verbs().close_session({ marvinSessionId: "tab-2", worktree: "keep", grounds: CHARTER })).toMatch(/Refused/);
    expect(listInbox(P)).toEqual([]);
  });

  it("close_session always escalates; a keep of a scope-met tab is one consent chip", async () => {
    rows = [row("tab-1"), row("tab-2", { turn: null }), row("tab-3")];
    scopeMetAt["tab-2"] = "2026-10-30T10:00:00.000Z";
    await verbs().close_session({ marvinSessionId: "tab-2", worktree: "keep", recommendation: "done and idle", grounds: CHARTER });
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({ kind: "scope", act: { type: "close", sessionId: "tab-2", worktree: "keep" }, dedupeKey: "close:tab-2:2026-10-30T10:00:00.000Z" });
    expect(readLedger(P).find((e) => e.verb === "close_session")?.decision).toBe("escalate");
  });

  it("review_scope: ready proposes the close; missing proposes sending what is missing; both need a scope-met tab", async () => {
    expect(await verbs().review_scope({ marvinSessionId: "tab-2", verdict: "ready", text: "all bullets met", grounds: CHARTER })).toMatch(/Refused/);
    scopeMetAt["tab-2"] = "2026-10-30T10:00:00.000Z";
    await verbs().review_scope({ marvinSessionId: "tab-2", verdict: "missing", text: "The DoD asks for a test of the invoice total.", grounds: CHARTER });
    await verbs().review_scope({ marvinSessionId: "tab-2", verdict: "ready", text: "otherwise met", grounds: CHARTER });
    const items = listInbox(P, { state: "open" });
    expect(items.map((i) => i.act?.type)).toEqual(["send", "close"]);
    expect(items[0]).toMatchObject({ kind: "scope", escalatedBecause: { code: "human-only", rule: "§4.6 scope" } });
  });
});

describe("new_session — only on the user's word, always an item, never performed by the verb", () => {
  it("without a request from the user it is refused", async () => {
    expect(await verbs().new_session({ requestId: "made-up", firstMessage: "Fix the flags page.", grounds: CHARTER })).toMatch(/Refused/);
    expect(listInbox(P)).toEqual([]);
    expect(readLedger(P).find((e) => e.verb === "new_session")).toMatchObject({ decision: "refuse", reasonCode: "no-request" });
  });

  it("with the user's request it becomes one new-tab item: first message, a fresh worktree, the posture, what is wider", async () => {
    requests["msg-1"] = { id: "msg-1", at: "2026-10-30T10:00:00.000Z", text: "Open a tab to fix the flags page." };
    await verbs().new_session({ requestId: "msg-1", firstMessage: "Fix the flags page.", posture: { permissionStrategy: "auto" }, grounds: CHARTER });
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({
      sessionId: null,
      kind: "new-tab",
      newTab: {
        firstMessage: "Fix the flags page.",
        tree: { baseRef: "main", baseSha: "abc1234", mode: "worktree" },
        posture: { model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", effort: "medium", strategy: "auto", mode: "agent" },
        wider: ["permissionStrategy"],
        requestedBy: { kind: "user-message", ref: "msg-1" },
      },
    });
  });

  it("one request, one tab: a second proposal for the same request is refused", async () => {
    requests["msg-1"] = { id: "msg-1", at: new Date().toISOString(), text: "Open a tab." };
    await verbs().new_session({ requestId: "msg-1", firstMessage: "First.", grounds: CHARTER });
    expect(await verbs().new_session({ requestId: "msg-1", firstMessage: "Second.", grounds: CHARTER })).toMatch(/Refused/);
    expect(listInbox(P)).toHaveLength(1);
  });

  it.each([["shared"], ["tab-open"], ["../elsewhere"]])("a proposal naming the tree %s is refused", async (tree) => {
    requests["msg-1"] = { id: "msg-1", at: new Date().toISOString(), text: "Open a tab." };
    expect(await verbs().new_session({ requestId: "msg-1", firstMessage: "Go.", tree, grounds: CHARTER })).toMatch(/Refused/);
    expect(listInbox(P)).toEqual([]);
  });

  it("a first message carrying a secret is refused", async () => {
    requests["msg-1"] = { id: "msg-1", at: new Date().toISOString(), text: "Open a tab." };
    expect(await verbs().new_session({ requestId: "msg-1", firstMessage: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", grounds: CHARTER })).toMatch(/Refused/);
  });
});

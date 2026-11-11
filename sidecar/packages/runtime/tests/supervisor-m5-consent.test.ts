import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerQuestion, resolveConfirm } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "../src/confirm-registry";
import { marvinPaths } from "../src/paths";
import { addInboxItem, buildRawAct, getInboxItem, type InboxDraft, listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { readLedger } from "../src/supervisor-ledger";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  pauseSupervisorForFault,
  resetSupervisorStateForTests,
} from "../src/supervisor-state";
import { isTurnTouched, resetTouchesForTests } from "../src/supervisor-touch";
import { endLiveTurn, type LiveTurn, type ProjectEvent, registerLiveTurn, subscribeProjectEvents } from "../src/turn-registry";

// ADR-0127 §5, plan milestone 5 — consent is given where the act is. Acting on
// an inbox item performs the RAW act with the user's authority and resolves
// the item; nothing the supervisor said is what the user consents to.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const P = "proj";
const token = () => currentSupervisorToken() as string;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };
const lookup = async () => (id: string) => ({ "claude-opus-5-5": { tier: "opus" }, "claude-sonnet-5-5": { tier: "sonnet" } })[id] ?? null;
let live: LiveTurn;

function performWith(over: Partial<InboxPerform> = {}): InboxPerform {
  const never = (what: string) => () => {
    throw new Error(`${what} must not be performed here`);
  };
  return {
    answer: (a) => answerQuestion({ ...a, answeredBy: "user" }),
    confirm: (a) => resolveConfirm({ ...a, answeredBy: "user" }),
    posture: never("posture") as never,
    send: never("send") as never,
    cancel: never("cancel") as never,
    notice: never("notice") as never,
    queue: never("queue") as never,
    worktrees: never("worktrees") as never,
    close: never("close") as never,
    openTab: never("openTab") as never,
    supervisor: (a) => applySupervisorAction({ projectId: P, ...a }, token()),
    modelLookup: lookup,
    ...over,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5c-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: P, action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
  live = registerLiveTurn({ turnId: "turn-1", marvinSessionId: "tab-1", projectId: P, kind: "human" });
});
afterEach(() => {
  clearTurnConfirms("turn-1");
  endLiveTurn(live, { event: "turn.completed", data: {} });
  resetTouchesForTests();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const base = { modeAtCreation: "shadow" as const, grounds: [] };
const QUESTION = { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };

function questionItem() {
  registerPendingConfirm("turn-1", "tu-q", vi.fn(), QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
  return addInboxItem(P, {
    ...base,
    sessionId: "tab-1",
    kind: "question",
    escalatedBecause: { code: "heuristic", label: "names an act" },
    question: QUESTION,
    linkedConfirm: { sessionId: "tab-1", turnId: "turn-1", toolUseId: "tu-q", raisingRule: "ask-user-question" },
    recommendation: { actionId: "answer", answer: { "Which database?": "Postgres" }, text: "the charter says Postgres" },
    act: { type: "answer", turnId: "turn-1", toolUseId: "tu-q", answers: { "Which database?": "Postgres" }, other: {} },
  });
}

function transcript(): Array<Record<string, unknown>> {
  const f = marvinPaths.sessionFile(P, "tab-1");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

describe("consent performs the raw act as the user, and resolves the item", () => {
  it("a question answered as recommended: the transcript reads answeredBy user, the turn is NOT touched", async () => {
    const item = questionItem();
    const r = await actOnInboxItem(P, { id: item.id, actionId: "answer" }, performWith());
    expect(r.ok).toBe(true);
    expect(getPendingConfirm("turn-1", "tu-q")).toBeNull();
    expect(transcript().find((t) => t.type === "confirm.decision")).toMatchObject({ answeredBy: "user", decision: "allow" });
    expect(isTurnTouched("turn-1")).toBe(false);
    expect(getInboxItem(P, item.id)).toMatchObject({ state: "resolved", resolvedBy: "user" });
    expect(readLedger(P).find((e) => e.kind === "inbox")).toMatchObject({ verb: "inbox.consent", tab: "tab-1", inboxItemId: item.id });
  });

  it("the user's own answer (edit) replaces the recommendation", async () => {
    const item = questionItem();
    expect((await actOnInboxItem(P, { id: item.id, actionId: "answer-edit" }, performWith())).ok).toBe(false);
    const r = await actOnInboxItem(P, { id: item.id, actionId: "answer-edit", edits: { answers: { "Which database?": "SQLite" } } }, performWith());
    expect(r.ok).toBe(true);
  });

  it("an integration confirm: Allow resolves it allowed, Deny resolves it denied — both the user's", async () => {
    const resolver = vi.fn();
    registerPendingConfirm("turn-1", "tu-c", resolver, { command: "git push" }, 0, { toolName: "Bash", raisedBy: "gated" });
    const item = addInboxItem(P, {
      ...base,
      sessionId: "tab-1",
      kind: "integration",
      escalatedBecause: { code: "human-only", label: "push" },
      rawAct: buildRawAct("Bash", { command: "git push" }),
      linkedConfirm: { sessionId: "tab-1", turnId: "turn-1", toolUseId: "tu-c", raisingRule: "gated" },
      recommendation: { actionId: "allow", text: "" },
      act: { type: "confirm", turnId: "turn-1", toolUseId: "tu-c" },
    });
    const r = await actOnInboxItem(P, { id: item.id, actionId: "deny" }, performWith());
    expect(r.ok).toBe(true);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
    expect(transcript().find((t) => t.type === "confirm.decision")).toMatchObject({ answeredBy: "user", decision: "deny" });
    expect(getInboxItem(P, item.id)).toMatchObject({ state: "resolved", resolvedBy: "user" });
  });

  it("dismiss settles the item and performs nothing", async () => {
    const item = questionItem();
    expect((await actOnInboxItem(P, { id: item.id, actionId: "dismiss" }, performWith())).ok).toBe(true);
    expect(getPendingConfirm("turn-1", "tu-q")).not.toBeNull();
    expect(getInboxItem(P, item.id)).toMatchObject({ state: "dismissed", resolvedBy: "user" });
  });

  it("an action the item does not offer is refused; a settled item is refused; a failed act leaves it open", async () => {
    const item = questionItem();
    expect(await actOnInboxItem(P, { id: item.id, actionId: "allow" }, performWith())).toMatchObject({ ok: false, status: 400 });
    expect(await actOnInboxItem(P, { id: "nope", actionId: "dismiss" }, performWith())).toMatchObject({ ok: false, status: 404 });
    clearTurnConfirms("turn-1"); // the question went away under the item
    const failed = await actOnInboxItem(P, { id: item.id, actionId: "answer" }, performWith());
    expect(failed).toMatchObject({ ok: false, status: 409 });
    expect(getInboxItem(P, item.id)?.state).toBe("open");
    await actOnInboxItem(P, { id: item.id, actionId: "dismiss" }, performWith());
    expect(await actOnInboxItem(P, { id: item.id, actionId: "dismiss" }, performWith())).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the new-tab item — opened only by the user, never wider than shown", () => {
  function newTab(requestId = "msg-1") {
    return addInboxItem(P, {
      ...base,
      sessionId: null,
      kind: "new-tab",
      escalatedBecause: { code: "human-only", label: "Opening a tab is the user's act", rule: "§4.7 topology" },
      rawAct: buildRawAct("new_session", { firstMessage: "Fix the flags page." }),
      newTab: {
        firstMessage: "Fix the flags page.",
        tree: { baseRef: "main", baseSha: "abc", mode: "worktree" },
        posture: { model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", effort: "medium", strategy: "gated", mode: "plan" },
        wider: [],
        requestedBy: { kind: "user-message", ref: requestId, at: new Date().toISOString() },
      },
      recommendation: { actionId: "open", text: "you asked" },
      act: { type: "new-tab", requestId, posture: POSTURE, grounds: [] },
    });
  }

  it("open passes the confirmed first message and posture, marked the supervisor's and unedited", async () => {
    const openTab = vi.fn(async () => ({ ok: true as const, marvinSessionId: "new-tab-id" }));
    const item = newTab();
    const r = await actOnInboxItem(P, { id: item.id, actionId: "open" }, performWith({ openTab }));
    expect(r).toMatchObject({ ok: true, outcome: { marvinSessionId: "new-tab-id" } });
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ firstMessage: "Fix the flags page.", posture: POSTURE, editedByUser: false, ledgerId: item.ledgerId }));
  });

  it("an edit may narrow the posture and rewrite the message; the message stays the supervisor's, marked edited", async () => {
    const openTab = vi.fn(async () => ({ ok: true as const, marvinSessionId: "t" }));
    const item = newTab();
    await actOnInboxItem(P, { id: item.id, actionId: "edit", edits: { firstMessage: "Fix the flags page, tests first.", posture: { mode: "ask" } } }, performWith({ openTab }));
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ firstMessage: "Fix the flags page, tests first.", posture: { ...POSTURE, mode: "ask" }, editedByUser: true }));
  });

  it.each([[{ permissionStrategy: "full" }], [{ mode: "agent" }], [{ model: "claude-opus-5-5" }]])("an edit that widens %j is refused and opens nothing", async (posture) => {
    const openTab = vi.fn();
    const item = newTab();
    const r = await actOnInboxItem(P, { id: item.id, actionId: "edit", edits: { posture } }, performWith({ openTab: openTab as never }));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(openTab).not.toHaveBeenCalled();
    expect(getInboxItem(P, item.id)?.state).toBe("open");
  });

  it("two clicks at once open one tab, not two", async () => {
    let release: () => void = () => {};
    const openTab = vi.fn(() => new Promise<{ ok: true; marvinSessionId: string }>((r) => (release = () => r({ ok: true, marvinSessionId: "t" }))));
    const item = newTab();
    const first = actOnInboxItem(P, { id: item.id, actionId: "open" }, performWith({ openTab }));
    const second = await actOnInboxItem(P, { id: item.id, actionId: "open" }, performWith({ openTab }));
    expect(second).toMatchObject({ ok: false, status: 409, code: "in-flight" });
    release();
    expect((await first).ok).toBe(true);
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("one request, one tab: a second item for an opened request cannot open another", async () => {
    const openTab = vi.fn(async () => ({ ok: true as const, marvinSessionId: "t" }));
    const first = newTab();
    await actOnInboxItem(P, { id: first.id, actionId: "open" }, performWith({ openTab }));
    const second = addInboxItem(P, { ...(getInboxItem(P, first.id) as unknown as InboxDraft), id: undefined, dedupeKey: undefined });
    expect(await actOnInboxItem(P, { id: second.id, actionId: "open" }, performWith({ openTab }))).toMatchObject({ ok: false, status: 409 });
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("a worktree that cannot be made answers the refusal, and the item stays open", async () => {
    const openTab = vi.fn(async () => ({ ok: false as const, status: 409, code: "worktree-failed", error: "not enough free disk" }));
    const item = newTab();
    expect(await actOnInboxItem(P, { id: item.id, actionId: "open" }, performWith({ openTab }))).toMatchObject({ ok: false, status: 409, code: "worktree-failed" });
    expect(getInboxItem(P, item.id)?.state).toBe("open");
  });
});

describe("guardrails — a pause is a tabless item, and resuming settles it", () => {
  it("a budget pause raises one guardrail item offering Raise cap and Resume; resume supersedes it", async () => {
    pauseSupervisorForFault(P, "daily cap reached: $10.00 of $10", "budget");
    const [item] = listInbox(P, { state: "open" });
    expect(item).toMatchObject({ sessionId: null, kind: "guardrail", escalatedBecause: { code: "budget" }, guardrail: { kind: "budget", verb: "raise-cap" } });
    const raised = await actOnInboxItem(P, { id: item?.id as string, actionId: "raise-cap", edits: { capUsd: 25 } }, performWith());
    expect(raised.ok).toBe(true);
    expect(getSupervisorState(P)).toMatchObject({ paused: false, caps: { dailyBudgetUsd: 25 } });
    expect(getInboxItem(P, item?.id as string)?.state).toBe("resolved");
  });

  it("every state change announces supervisor.state on the feed — revision and mode, never the charter", () => {
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => {
      if (e.event === "supervisor.state") seen.push(e);
    });
    try {
      applySupervisorAction({ projectId: P, action: "charter", text: "Secret plans for billing." }, token());
      applySupervisorAction({ projectId: P, action: "pause" }, token());
    } finally {
      off();
    }
    expect(seen.map((e) => e.data)).toEqual([
      { projectId: P, revision: getSupervisorState(P).revision - 1, mode: "shadow", paused: false },
      { projectId: P, revision: getSupervisorState(P).revision, mode: "shadow", paused: true },
    ]);
    expect(JSON.stringify(seen)).not.toContain("Secret plans");
  });

  it("the user resuming from the status strip supersedes an open guardrail item", () => {
    pauseSupervisorForFault(P, "3 refused calls in one wake", "refusals");
    expect(applySupervisorAction({ projectId: P, action: "resume" }, token()).ok).toBe(true);
    expect(listInbox(P, { state: "open" })).toEqual([]);
  });
});

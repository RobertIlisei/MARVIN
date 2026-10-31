import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPendingConfirm } from "../src/confirm-registry";
import { closeSession } from "../src/session-close";
import { upsertSessionMeta } from "../src/session-meta";
import type { SessionWatchRow } from "../src/session-watch";
import { endFollow, followsPath, listFollows, MAX_OPEN_FOLLOWS, openFollow, parseFollowLine } from "../src/supervisor-follows";
import { addInboxItem, listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { appendLedgerEntry, ensureSupervisorDir, readLedger } from "../src/supervisor-ledger";
import { followsForWake } from "../src/supervisor-loop";
import { createSupervisorVerbs, type VerbContext, type VerbDeps } from "../src/supervisor-mcp";
import { addSupervisorReply, addUserMessage, listMessages, messagesPath } from "../src/supervisor-messages";
import { ActionLimiter } from "../src/supervisor-policy";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0128 §5 / plan [7.3] — following and reporting. A follow is a validated,
// capped, event-sourced record; a report is admitted only in a wake a followed
// tab's existing trigger started; refs resolve or vanish; a new tab's
// delegation can only be lowered on its card.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const TABS = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6"];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m73-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction(
    { projectId: "proj", action: "start", delegations: [...TABS.map((sessionId) => ({ sessionId, level: "answer-questions" })), { sessionId: "tab-obs", level: "observe" }] },
    currentSupervisorToken() as string,
  );
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const row = (id: string): SessionWatchRow =>
  ({ marvinSessionId: id, projectId: "proj", state: "idle", pending: [], tree: { mode: "shared", cwd: "/tmp", currentBranch: "main", present: true }, plan: null, title: `title of ${id}` }) as unknown as SessionWatchRow;

function deps(extra: Partial<VerbDeps> = {}): VerbDeps {
  return {
    listRows: async () => [...TABS, "tab-obs"].map(row),
    listTabs: () => [...TABS, "tab-obs", "tab-off"].map((id) => ({ id, title: `title of ${id}` })),
    getPending: getPendingConfirm,
    readTranscriptTail: () => "",
    readBrief: () => null,
    tabStartedAt: () => null,
    readPlanText: () => "",
    sendRefusal: () => null,
    scopeMet: () => true,
    scopeMetAt: () => "2026-10-31T10:00:00.000Z",
    modelLookup: async () => () => null,
    userRequest: (id) => {
      const m = listMessages("proj").find((x) => x.id === id && x.from === "user");
      return m ? { id: m.id, at: m.at, text: m.text } : null;
    },
    postReply: (text, items, extra) =>
      addSupervisorReply("proj", text, { wakeId: "w", origin: extra?.followId ? { kind: "follow", followId: extra.followId } : { kind: "message", messageIds: [] }, items, refs: extra?.refs }),
    worktrees: { list: async () => [], preview: async () => null, sweep: async () => [] },
    perform: { answer: () => ({ ok: true }), send: async () => ({ ok: true, queued: false }), cancel: () => true, confirm: () => ({ ok: true }), setPosture: async () => ({ ok: true }) },
    ...extra,
  };
}

const ctx = (over: Partial<VerbContext> = {}): VerbContext => ({
  projectId: "proj",
  workDir: dataDir,
  wakeId: "w",
  wake: { acts: 0 },
  limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
  deps: deps(),
  ...over,
});

const ask = (text: string) => {
  const m = addUserMessage("proj", text);
  return { m, wake: ctx({ conversation: { messageIds: [m.id] } }), ground: (quote: string) => [{ kind: "message" as const, ref: `${m.id}#${quote}` }] };
};

describe("the follows store", () => {
  it("lives in the data dir at 0600, and the newest line per id is the follow", () => {
    const m = addUserMessage("proj", "tell me when tab one is done");
    const r = openFollow("proj", { sessionId: "tab-1", until: "scope-met", requestId: m.id });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.follow.id : "";
    expect(followsPath("proj").startsWith(dataDir)).toBe(true);
    expect(statSync(followsPath("proj")).mode & 0o777).toBe(0o600);
    endFollow("proj", id, "unfollow");
    expect(listFollows("proj")).toEqual([expect.objectContaining({ id, state: "ended", endedBy: "unfollow", revision: 2 })]);
    expect(endFollow("proj", id, "user")).toBeNull(); // ending is once
  });

  it("skips every line that is not what it writes", () => {
    const good = { id: "f1", revision: 1, createdAt: "2026-10-31T10:00:00.000Z", sessionId: "tab-1", until: "scope-met", requestId: "m1", state: "open", endedAt: null, endedBy: null };
    const lines = [
      good,
      { ...good, id: "f2", until: "forever" },
      { ...good, id: "f3", sessionId: "../../etc/passwd" },
      { ...good, id: "f4", state: "ended" }, // ended with no endedAt / endedBy
      { ...good, id: "f5", revision: 0 },
      { ...good, id: "f6", requestId: 42 },
      { ...good, id: "f7", endedBy: "user" }, // open with an end
    ].map((follow) => JSON.stringify({ follow }));
    ensureSupervisorDir("proj");
    appendFileSync(followsPath("proj"), `${lines.join("\n")}\n{torn\n${JSON.stringify({ follow: { ...good, id: "f8", sessionId: "x".repeat(5_000) } })}\n`);
    expect(listFollows("proj").map((f) => f.id)).toEqual(["f1"]);
    expect(parseFollowLine("[]")).toBeNull();
  });
});

describe("follow bounds", () => {
  it("a sixth follow is refused with the five open listed", async () => {
    const { wake, ground } = ask("Follow every tab for me and tell me when each is done");
    const v = createSupervisorVerbs(wake);
    for (const t of TABS.slice(0, MAX_OPEN_FOLLOWS)) expect(await v.follow({ marvinSessionId: t, until: "scope-met", grounds: ground("tell me when each is done") })).toMatch(/^Following/);
    const sixth = await v.follow({ marvinSessionId: "tab-6", until: "scope-met", grounds: ground("tell me when each is done") });
    expect(sixth).toMatch(/^Refused: 5 follows are open/);
    for (const f of listFollows("proj", { state: "open" })) expect(sixth).toContain(f.id);
    expect(listFollows("proj", { state: "open" })).toHaveLength(5);
    expect(readLedger("proj").at(-1)).toMatchObject({ verb: "follow", decision: "refuse", reasonCode: "follow-cap" });
  });

  it("a follow needs the user's request, a delegated tab, and a message from the last 24 hours", async () => {
    const { wake, ground } = ask("Please keep an eye on tab one for me");
    const v = createSupervisorVerbs(wake);
    expect(await v.follow({ marvinSessionId: "tab-1", until: "scope-met" })).toMatch(/only on the user's request/);
    expect(await v.follow({ marvinSessionId: "tab-1", until: "scope-met", grounds: ground("not their words at all") })).toMatch(/only on the user's request/);
    expect(await v.follow({ marvinSessionId: "tab-off", until: "scope-met", grounds: ground("keep an eye on tab") })).toMatch(/not delegated/);
    // A message older than the request window.
    const old = { id: "old-msg", at: new Date(Date.now() - 25 * 3_600_000).toISOString(), from: "user", text: "Please keep an eye on tab two for me" };
    appendFileSync(messagesPath("proj"), `${JSON.stringify(old)}\n`);
    expect(await v.follow({ marvinSessionId: "tab-2", until: "scope-met", grounds: [{ kind: "message", ref: "old-msg#keep an eye on tab two" }] })).toMatch(/last 24 hours/);
    expect(listFollows("proj")).toEqual([]);
    expect(await v.follow({ marvinSessionId: "tab-obs", until: "scope-met", grounds: ground("keep an eye on tab") })).toMatch(/^Following/);
  });

  it("only the tab's existing triggers carry its follow — idle does not, and unfollow stops reports", async () => {
    const m = addUserMessage("proj", "tell me when tab one is done");
    openFollow("proj", { sessionId: "tab-1", until: "scope-met", requestId: m.id });
    const ref = (trigger: "turn-ended" | "idle" | "scope-met") => ({ trigger, marvinSessionId: "tab-1", turnId: "t", toolUseId: "" });
    expect(followsForWake("proj", [ref("turn-ended")]).map((f) => f.sessionId)).toEqual(["tab-1"]);
    expect(followsForWake("proj", [ref("scope-met")])).toHaveLength(1);
    expect(followsForWake("proj", [ref("idle")])).toEqual([]);
    expect(await createSupervisorVerbs(ctx()).unfollow({ marvinSessionId: "tab-1" })).toMatch(/Stopped following/);
    expect(followsForWake("proj", [ref("turn-ended")])).toEqual([]);
    // A wake with no follow and no conversation has no one to report to.
    expect(await createSupervisorVerbs(ctx({ follows: [] })).reply({ text: "tab-1 finished", kind: "report" })).toMatch(/^Refused: no conversation/);
    expect(listMessages("proj").filter((x) => x.from === "supervisor")).toEqual([]);
  });
});

describe("a report", () => {
  it("is admitted for this wake's follows only, and its refs resolve or vanish", async () => {
    const m = addUserMessage("proj", "tell me when tab one is done");
    const f = openFollow("proj", { sessionId: "tab-1", until: "scope-met", requestId: m.id });
    if (!f.ok) throw new Error("follow");
    const wake = ctx({ follows: [{ id: f.follow.id, sessionId: "tab-1", until: "scope-met" }] });
    const v = createSupervisorVerbs(wake);
    expect(await v.reply({ text: "done?", followId: "someone-elses" })).toMatch(/^Refused: a report names the follow/);
    // The scope-met review raises the tab's close item with the follow's origin and ends the follow — and no merge card.
    await v.review_scope({ marvinSessionId: "tab-1", verdict: "ready", text: "Every step is done and verified." });
    const own = listInbox("proj").find((i) => i.sessionId === "tab-1");
    expect(own?.origin).toEqual({ kind: "follow", followId: f.follow.id });
    expect(listInbox("proj").filter((i) => i.kind === "integration")).toEqual([]);
    expect(listFollows("proj")[0]).toMatchObject({ state: "ended", endedBy: "scope-met" });
    const foreign = addInboxItem("proj", { sessionId: "tab-2", kind: "scope", escalatedBecause: { code: "human-only", label: "x" }, modeAtCreation: "shadow" });
    const line = appendLedgerEntry("proj", { kind: "verb", verb: "send", tab: "tab-1", wakeId: null, decision: "propose", reason: "r" });
    expect(
      await v.reply({
        text: "tab-1 met its scope.",
        items: [own?.id, foreign.id, "made-up"],
        refs: [
          { kind: "tab", id: "tab-1" },
          { kind: "tab", id: "no-such-tab" },
          { kind: "ledger", id: line.id },
          { kind: "item", id: own?.id },
          { kind: "item", id: "made-up" },
          { kind: "url", id: "https://evil.example" },
        ],
      }),
    ).toBe("Reported to the user.");
    const report = listMessages("proj").find((x) => x.from === "supervisor");
    expect(report).toMatchObject({ kind: "report", origin: { kind: "follow", followId: f.follow.id }, items: [own?.id] });
    expect(report?.refs).toEqual([
      { kind: "tab", id: "tab-1", label: "title of tab-1" },
      { kind: "ledger", id: line.id, label: "send → propose" },
      { kind: "item", id: own?.id, label: expect.stringContaining("Close tab tab-1") },
    ]);
    expect(readLedger("proj").at(-1)).toMatchObject({ kind: "message", verb: "report", tab: "tab-1", origin: { kind: "follow", followId: f.follow.id } });
    // A report answers no user message: it is still waiting for its reply.
    const { unansweredUserMessages } = await import("../src/supervisor-messages");
    expect(unansweredUserMessages("proj").map((x) => x.id)).toEqual([m.id]);
  });
});

describe("a new-tab card's delegation", () => {
  const POSTURE = { model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "medium", mode: "agent" as const };
  const item = (delegation: "answer-questions" | "observe", requestId = "m1") =>
    addInboxItem("proj", {
      sessionId: null,
      kind: "new-tab",
      escalatedBecause: { code: "human-only", label: "Opening a tab is the user's act" },
      newTab: { firstMessage: "Fix it", tree: { baseRef: "main", baseSha: null, mode: "worktree" }, posture: { model: "m", modelLabel: "m", effort: "", strategy: "", mode: "agent" }, wider: [], requestedBy: { kind: "user-message", ref: requestId, at: "" }, delegation, follow: { until: "merge-ready" } },
      act: { type: "new-tab", requestId, posture: POSTURE, grounds: [], delegation, follow: { until: "merge-ready" } },
      modeAtCreation: "shadow",
    });
  const perform = () => {
    const openTab = vi.fn(async () => ({ ok: true as const, marvinSessionId: "new-tab" }));
    return { openTab, p: { openTab, modelLookup: async () => () => null } as unknown as InboxPerform };
  };

  it("is lowered on the accept, and an off tab is not followed", async () => {
    const { openTab, p } = perform();
    expect((await actOnInboxItem("proj", { id: item("answer-questions").id, actionId: "edit", edits: { delegation: "off" } }, p)).ok).toBe(true);
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ delegation: "off", follow: null }));
    const second = perform();
    expect((await actOnInboxItem("proj", { id: item("answer-questions", "m2").id, actionId: "open" }, second.p)).ok).toBe(true);
    expect(second.openTab).toHaveBeenCalledWith(expect.objectContaining({ delegation: "answer-questions", follow: { until: "merge-ready", requestId: "m2" } }));
  });

  it("is never raised past what the card showed", async () => {
    const { openTab, p } = perform();
    const r = await actOnInboxItem("proj", { id: item("observe").id, actionId: "edit", edits: { delegation: "answer-questions" } }, p);
    expect(r).toMatchObject({ ok: false, status: 409, code: "widening" });
    expect(openTab).not.toHaveBeenCalled();
  });
});

describe("a follow ends at its tab's close", () => {
  it("closing the tab ends it", async () => {
    upsertSessionMeta("proj", "tab-1", { workDir: dataDir, tree: { mode: "shared" }, posture: { model: "m", advisorModel: null, personality: "marvin", permissionStrategy: "auto", thinkingMode: "medium", mode: "agent" } });
    openFollow("proj", { sessionId: "tab-1", until: "merge-ready", requestId: "m1" });
    const out = await closeSession({ projectId: "proj", workDir: dataDir, sessionId: "tab-1", action: "keep" });
    expect(out.status).toBe(200);
    expect(listFollows("proj")[0]).toMatchObject({ state: "ended", endedBy: "closed" });
  });
});

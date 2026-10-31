import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0128 §5 / plan [7.3] DoD "open, follow, report, merge", end to end on a
// real repository: the message route, the real loop, a stubbed model that
// calls the real verbs, the inbox route the user clicks, and the conversation
// the Supervisor tab renders. Nothing merges before the click.

type RunInput = Record<string, unknown>;
type Item = { trigger: string; marvinSessionId: string; message?: { id: string; text: string } | null; follow?: { id: string; until: string } | null };
let captured: RunInput[];
let dataDir: string;
let repo: string;
const prev = process.env.MARVIN_DATA_DIR;
const savedMin = process.env.MARVIN_WORKTREE_MIN_FREE_GB;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "medium", mode: "agent" as const };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const BASE = "http://localhost:3030";

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m7f-data-"));
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m7f-repo-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  process.env.MARVIN_WORKTREE_MIN_FREE_GB = "0";
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@x");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  captured = [];
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return {
      ...orig,
      runAgent: async (input: RunInput) => {
        captured.push(input);
        return { ok: true, costUsd: 0.01 };
      },
    };
  });
});
afterEach(async () => {
  const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: { stop(): void } };
  G.__marvinSupervisorLoop?.stop();
  delete G.__marvinSupervisorLoop;
  const { __resetSchedulerForTests } = await import("@marvin/runtime/wakeup-scheduler");
  __resetSchedulerForTests();
  const st = await import("@marvin/runtime/supervisor-state");
  st.resetSupervisorStateForTests();
  vi.doUnmock("@marvin/runtime/sdk-runner");
  vi.resetModules();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  if (savedMin === undefined) delete process.env.MARVIN_WORKTREE_MIN_FREE_GB;
  else process.env.MARVIN_WORKTREE_MIN_FREE_GB = savedMin;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** The stubbed model: one handler per wake, picked by what the wake carries. */
type Script = (items: Item[], verbs: ReturnType<typeof import("../packages/runtime/src/supervisor-mcp").createSupervisorVerbs>) => Promise<void>;

async function setup(script: Script) {
  const st = await import("@marvin/runtime/supervisor-state");
  st.resetSupervisorStateForTests();
  st.bootSupervisor();
  const token = st.currentSupervisorToken() as string;
  const projects = await import("@marvin/runtime/projects");
  const projectId = projects.addProject({ name: "repo", workDir: repo }).id;
  st.applySupervisorAction({ projectId, action: "start" }, token);
  st.setSupervisorCapsForTests(projectId, { debounceMs: 20 });
  const meta = await import("@marvin/runtime/session-meta");
  meta.upsertSessionMeta(projectId, "user-tab", { workDir: repo, tree: { mode: "shared" }, posture: POSTURE }, { title: "user tab" });
  await import("../src/lib/turn-orchestrator"); // wires the fire handler
  const { createSupervisorVerbs } = await import("../packages/runtime/src/supervisor-mcp");
  const verbsOf = (c: Parameters<typeof createSupervisorVerbs>[0]) => createSupervisorVerbs(c);
  const loopMod = await import("@marvin/runtime/supervisor-loop");
  const wakes: Item[][] = [];
  const loop = new loopMod.SupervisorLoop({
    ...loopMod.defaultLoopDeps(),
    runWake: async ({ items, verbCtx }) => {
      wakes.push(items as unknown as Item[]);
      await script(items as unknown as Item[], verbsOf(verbCtx));
      return { ok: true, costUsd: 0 };
    },
  });
  loop.start();
  (globalThis as typeof globalThis & { __marvinSupervisorLoop?: unknown }).__marvinSupervisorLoop = loop;
  const { NextRequest } = await import("next/server");
  const inboxRoute = await import("../src/app/api/supervisor/inbox/route");
  const messageRoute = await import("../src/app/api/supervisor/message/route");
  const headers = { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token };
  const consent = (body: Record<string, unknown>) =>
    inboxRoute.POST(new NextRequest(`${BASE}/api/supervisor/inbox`, { method: "POST", headers, body: JSON.stringify({ projectId, ...body }) }));
  const say = (text: string) => messageRoute.POST(new NextRequest(`${BASE}/api/supervisor/message`, { method: "POST", headers, body: JSON.stringify({ projectId, text }) }));
  const conversation = async () => {
    const r = await messageRoute.GET(new NextRequest(`${BASE}/api/supervisor/message?projectId=${projectId}`, { headers: { "x-marvin-supervisor-token": token } }));
    return ((await r.json()) as { messages: Array<Record<string, unknown>> }).messages;
  };
  return { st, meta, projectId, token, consent, say, conversation, wakes, loop, verbsOf };
}

describe("open, follow, report, merge", () => {
  it("one new-tab card → a followed tab at the confirmed delegation → a report at scope-met → one merge card; nothing merges before the click", async () => {
    const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
    let projectId = "";
    const { meta, consent, say, conversation, wakes, st, ...rest } = await setup(async (items, v) => {
      const m = items.find((i) => i.trigger === "message");
      if (m?.message) {
        await v.new_session({ requestId: m.message.id, firstMessage: "Fix the flags page. Start by reading flags.ts.", title: "flags", follow: "merge-ready" });
        const card = listInbox(projectId, { state: "open" }).find((i) => i.kind === "new-tab");
        await v.reply({ text: "Here is the tab you asked for.", items: card ? [card.id] : [] });
        return;
      }
      const scope = items.find((i) => i.trigger === "scope-met");
      if (scope) {
        await v.review_scope({ marvinSessionId: scope.marvinSessionId, verdict: "ready", text: "Every step of the plan is done and verified." });
        const raised = listInbox(projectId, { state: "open" }).filter((i) => i.sessionId === scope.marvinSessionId || i.kind === "integration");
        await v.reply({
          text: "flags met its scope. The merge is ready for your click.",
          kind: "report",
          items: raised.map((i) => i.id),
          refs: [{ kind: "tab", id: scope.marvinSessionId }, { kind: "item", id: "made-up" }],
        });
      }
    });
    projectId = rest.projectId;

    // 1. One new-tab card, in the chat, at the default delegation, followed until merge-ready.
    const posted = await say("Open a tab to fix the flags page, and merge it when it's done.");
    expect(posted.status).toBe(200);
    await vi.waitFor(async () => expect((await conversation()).some((m) => m.from === "supervisor")).toBe(true), { timeout: 3_000 });
    const cards = listInbox(projectId).filter((i) => i.kind === "new-tab");
    expect(cards).toHaveLength(1);
    const card = cards[0] as NonNullable<(typeof cards)[0]>;
    expect(card.newTab).toMatchObject({ delegation: "answer-questions", follow: { until: "merge-ready" } });
    expect((await conversation()).find((m) => m.from === "supervisor")?.items).toEqual([card.id]);
    expect(meta.listSessionMetas(projectId).map((m) => m.marvinSessionId)).toEqual(["user-tab"]);

    // 2. The user's accept opens one tab in a fresh worktree, delegated as confirmed and followed.
    const r = await consent({ id: card.id, actionId: "open" });
    expect(r.status).toBe(200);
    const { outcome } = (await r.json()) as { outcome: { marvinSessionId: string } };
    const tab = outcome.marvinSessionId;
    const opened = meta.readSessionMeta(projectId, tab);
    expect(opened?.tree.mode).toBe("worktree");
    expect(st.getSupervisorState(projectId).delegation[tab]).toBe("answer-questions");
    const { listFollows } = await import("@marvin/runtime/supervisor-follows");
    const follows = listFollows(projectId, { state: "open" });
    expect(follows).toHaveLength(1);
    const follow = follows[0] as NonNullable<(typeof follows)[0]>;
    expect(follow).toMatchObject({ sessionId: tab, until: "merge-ready", requestId: card.act?.type === "new-tab" ? card.act.requestId : "?" });

    // Its first turn (the supervisor's message) ends and wakes the supervisor once; the script does nothing there.
    await vi.waitFor(() => expect(wakes.some((w) => w.some((i) => i.trigger === "turn-ended" && i.marvinSessionId === tab))).toBe(true), { timeout: 3_000 });
    const tree = opened?.tree as { path: string; branch: string; slug: string };
    writeFileSync(path.join(tree.path, "flags.ts"), "export const fixed = true;\n");
    git(tree.path, "add", ".");
    git(tree.path, "commit", "-qm", "fix flags");

    // 3. The tab's scope-met handoff: a report in the chat.
    const { announceProjectEvent } = await import("@marvin/runtime/turn-registry");
    meta.updateSessionMeta(projectId, tab, { scopeMetAt: new Date().toISOString() });
    announceProjectEvent({ event: "turn.ended", data: { marvinSessionId: tab, projectId, turnId: "t-done", outcome: "completed", kind: "machine", author: "supervisor" } });
    await vi.waitFor(async () => expect((await conversation()).some((m) => m.kind === "report")).toBe(true), { timeout: 3_000 });
    const report = (await conversation()).find((m) => m.kind === "report") as Record<string, unknown>;
    expect(report).toMatchObject({ from: "supervisor", origin: { kind: "follow", followId: follow.id }, refs: [{ kind: "tab", id: tab }] });

    // 4. One integration card, in the chat, for exactly that branch — not performed.
    const merges = listInbox(projectId).filter((i) => i.kind === "integration");
    expect(merges).toHaveLength(1);
    const merge = merges[0] as NonNullable<(typeof merges)[0]>;
    expect(merge).toMatchObject({ state: "open", act: { type: "worktrees", op: "merge", slugs: [tree.slug] }, origin: { kind: "follow", followId: follow.id } });
    expect(merge.preview).toMatchObject({ kind: "merge-tree" });
    expect(report.items).toContain(merge.id);
    expect(git(repo, "branch", "--merged", "main")).not.toContain(tree.branch);

    // The click merges it, as the user, and ends the follow.
    const clicked = await consent({ id: merge.id, actionId: "perform" });
    expect(clicked.status).toBe(200);
    expect(git(repo, "branch", "--merged", "main")).toContain(tree.branch);
    expect(listFollows(projectId, { state: "open" })).toEqual([]);
    expect(listFollows(projectId)[0]).toMatchObject({ state: "ended", endedBy: "merge-settled" });
  });
});

describe("follow bounds", () => {
  it("a machine turn in a followed tab wakes nothing and reports nothing", async () => {
    let calls = 0;
    const { projectId, st, token, wakes, conversation } = await setup(async () => {
      calls += 1;
    });
    st.applySupervisorAction({ projectId, action: "delegate", marvinSessionId: "tab-f", level: "answer-questions" }, token);
    const meta = await import("@marvin/runtime/session-meta");
    meta.upsertSessionMeta(projectId, "tab-f", { workDir: repo, tree: { mode: "shared" }, posture: POSTURE }, { title: "followed" });
    const { addUserMessage } = await import("@marvin/runtime/supervisor-messages");
    const { openFollow } = await import("@marvin/runtime/supervisor-follows");
    const m = addUserMessage(projectId, "Tell me when the followed tab is done.");
    expect(openFollow(projectId, { sessionId: "tab-f", until: "scope-met", requestId: m.id }).ok).toBe(true);
    const { announceProjectEvent } = await import("@marvin/runtime/turn-registry");
    announceProjectEvent({ event: "turn.ended", data: { marvinSessionId: "tab-f", projectId, turnId: "t-machine", outcome: "completed", kind: "machine" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);
    expect(wakes).toEqual([]);
    expect((await conversation()).filter((x) => x.from === "supervisor")).toEqual([]);
  });
});

describe("GET / POST /api/supervisor/follows", () => {
  it("lists follows with the tab's title, and the user's Stop following ends one once", async () => {
    const { projectId, token, meta } = await setup(async () => {});
    meta.upsertSessionMeta(projectId, "tab-f", { workDir: repo, tree: { mode: "shared" }, posture: POSTURE }, { title: "flags" });
    const { addUserMessage } = await import("@marvin/runtime/supervisor-messages");
    const { openFollow, listFollows } = await import("@marvin/runtime/supervisor-follows");
    const f = openFollow(projectId, { sessionId: "tab-f", until: "scope-met", requestId: addUserMessage(projectId, "tell me when flags is done").id });
    if (!f.ok) throw new Error("follow");
    const { NextRequest } = await import("next/server");
    const route = await import("../src/app/api/supervisor/follows/route");
    const url = `${BASE}/api/supervisor/follows`;
    expect((await route.GET(new NextRequest(`${url}?projectId=${projectId}`))).status).toBe(403);
    const got = (await (await route.GET(new NextRequest(`${url}?projectId=${projectId}`, { headers: { "x-marvin-supervisor-token": token } }))).json()) as { follows: Array<Record<string, unknown>> };
    expect(got.follows).toEqual([expect.objectContaining({ id: f.follow.id, sessionId: "tab-f", until: "scope-met", state: "open", tabTitle: "flags" })]);
    const stop = () =>
      route.POST(
        new NextRequest(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token },
          body: JSON.stringify({ projectId, id: f.follow.id, action: "stop" }),
        }),
      );
    expect((await stop()).status).toBe(200);
    expect(listFollows(projectId)[0]).toMatchObject({ state: "ended", endedBy: "user" });
    expect((await stop()).status).toBe(409);
    const { readLedger } = await import("@marvin/runtime/supervisor-ledger");
    expect(readLedger(projectId).at(-1)).toMatchObject({ kind: "control", verb: "follow.stop", tab: "tab-f" });
  });
});

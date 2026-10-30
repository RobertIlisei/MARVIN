import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0127 §4 item 7, plan milestone 5, end to end on a real repository: a
// tab opens only from an item the user confirmed, in a FRESH worktree, at a
// posture no wider than the one confirmed, and its first turn is the
// supervisor's and touched. A worktree that cannot be made answers ADR-0122's
// refusal with nothing opened. A finished tab's close-with-keep item closes it
// as the user, keeping the branch.

type RunInput = Record<string, unknown>;
let captured: RunInput[];
let dataDir: string;
let repo: string;
const prev = process.env.MARVIN_DATA_DIR;
const savedMin = process.env.MARVIN_WORKTREE_MIN_FREE_GB;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "medium", mode: "agent" as const };
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5n-data-"));
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m5n-repo-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  process.env.MARVIN_WORKTREE_MIN_FREE_GB = "0";
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@x");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  captured = [];
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return {
      ...orig,
      runAgent: async (input: RunInput) => {
        captured.push(input);
        return { ok: true, costUsd: 0.1 };
      },
    };
  });
});
afterEach(async () => {
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

async function setup() {
  const st = await import("@marvin/runtime/supervisor-state");
  st.resetSupervisorStateForTests();
  st.bootSupervisor();
  const token = st.currentSupervisorToken() as string;
  const projects = await import("@marvin/runtime/projects");
  const projectId = projects.addProject({ name: "repo", workDir: repo }).id;
  st.applySupervisorAction({ projectId, action: "start" }, token);
  const meta = await import("@marvin/runtime/session-meta");
  // The user's tab the new one is measured against.
  meta.upsertSessionMeta(projectId, "user-tab", { workDir: repo, tree: { mode: "shared" }, posture: POSTURE }, { title: "user tab" });
  await import("../src/lib/turn-orchestrator"); // wires the fire handler
  const { NextRequest } = await import("next/server");
  const route = await import("../src/app/api/supervisor/inbox/route");
  const consent = (body: Record<string, unknown>) =>
    route.POST(
      new NextRequest("http://localhost:3030/api/supervisor/inbox", {
        method: "POST",
        headers: { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token },
        body: JSON.stringify({ projectId, ...body }),
      }),
    );
  return { st, meta, projectId, consent };
}

async function proposeTab(projectId: string, posture: Record<string, string>) {
  const { addUserMessage } = await import("@marvin/runtime/supervisor-messages");
  const { createSupervisorVerbs } = await import("../packages/runtime/src/supervisor-mcp");
  const { defaultVerbDeps } = await import("@marvin/runtime/supervisor-loop");
  const { ActionLimiter } = await import("../packages/runtime/src/supervisor-policy");
  const { getSupervisorState } = await import("@marvin/runtime/supervisor-state");
  const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
  const msg = addUserMessage(projectId, "Open a tab to fix the flags page, read-only first.");
  const verbs = createSupervisorVerbs({ projectId, workDir: repo, wakeId: "w1", wake: { acts: 0 }, limiter: new ActionLimiter(() => getSupervisorState(projectId).caps), deps: defaultVerbDeps(projectId, repo) });
  const reply = await verbs.new_session({ requestId: msg.id, firstMessage: "Fix the flags page. Start by reading flags.ts.", title: "flags", posture });
  expect(reply).toMatch(/Escalated/);
  const item = listInbox(projectId, { state: "open" }).find((i) => i.kind === "new-tab");
  expect(item?.newTab).toMatchObject({ tree: { baseRef: "main", baseSha: git("rev-parse", "HEAD"), mode: "worktree" }, requestedBy: { kind: "user-message", ref: msg.id } });
  return item as NonNullable<typeof item>;
}

describe("an accepted new-tab item opens exactly one tab", () => {
  it("in a fresh worktree, no wider than confirmed, first turn the supervisor's and touched", async () => {
    const { meta, projectId, consent } = await setup();
    const item = await proposeTab(projectId, { mode: "plan" });
    // The user narrows further while confirming.
    const r = await consent({ id: item.id, actionId: "edit", edits: { posture: { mode: "ask" } } });
    expect(r.status).toBe(200);
    const { outcome } = (await r.json()) as { outcome: { marvinSessionId: string } };
    const opened = meta.readSessionMeta(projectId, outcome.marvinSessionId);
    expect(opened?.tree.mode).toBe("worktree");
    const tree = opened?.tree as { mode: "worktree"; path: string; branch: string };
    expect(tree.path.startsWith(path.join(repo, ".marvin", "worktrees"))).toBe(true);
    expect(existsSync(tree.path)).toBe(true);
    expect(opened?.posture).toMatchObject({ mode: "ask", permissionStrategy: "auto", model: "claude-sonnet-5-5" });
    expect(meta.listSessionMetas(projectId).map((m) => m.marvinSessionId).sort()).toEqual([outcome.marvinSessionId, "user-tab"].sort());
    // The first turn ran once, in the new tree, as the supervisor's.
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.message)).toContain("Fix the flags page");
    expect(String(captured[0]?.message)).toMatch(/the supervisor's words, not the user's/);
    const { marvinPaths } = await import("@marvin/runtime/paths");
    const lines = readFileSync(marvinPaths.sessionFile(projectId, outcome.marvinSessionId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((t) => t.type === "turn.user")).toMatchObject({ author: "supervisor", supervisor: { kind: "first-message", ledgerId: item.ledgerId } });
    expect(meta.readSessionMeta(projectId, outcome.marvinSessionId)?.supervisorTouched).toMatchObject({ by: "message" });
    // One request, one tab: the same request cannot propose a second.
    const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
    expect(listInbox(projectId).find((i) => i.id === item.id)).toMatchObject({ state: "resolved", resolvedBy: "user" });
  });

  it("an edited first message stays the supervisor's, marked editedByUser", async () => {
    const { projectId, consent } = await setup();
    const item = await proposeTab(projectId, { mode: "plan" });
    const r = await consent({ id: item.id, actionId: "edit", edits: { firstMessage: "Fix the flags page. Tests first." } });
    expect(r.status).toBe(200);
    const { outcome } = (await r.json()) as { outcome: { marvinSessionId: string } };
    const { marvinPaths } = await import("@marvin/runtime/paths");
    const lines = readFileSync(marvinPaths.sessionFile(projectId, outcome.marvinSessionId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((t) => t.type === "turn.user")).toMatchObject({ author: "supervisor", supervisor: { kind: "first-message", editedByUser: true } });
    expect(String(captured[0]?.message)).toContain("Tests first.");
  });

  it("an edit that widens past the confirmed posture opens nothing", async () => {
    const { meta, projectId, consent } = await setup();
    const item = await proposeTab(projectId, { mode: "plan" });
    const r = await consent({ id: item.id, actionId: "edit", edits: { posture: { mode: "agent" } } });
    expect(r.status).toBe(409);
    expect(meta.listSessionMetas(projectId).map((m) => m.marvinSessionId)).toEqual(["user-tab"]);
    expect(captured).toEqual([]);
  });

  it("a worktree creation failure answers the ADR-0122 refusal, with nothing opened", async () => {
    const { meta, projectId, consent } = await setup();
    const item = await proposeTab(projectId, { mode: "plan" });
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "1000000";
    const r = await consent({ id: item.id, actionId: "open" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("worktree-failed");
    expect(meta.listSessionMetas(projectId).map((m) => m.marvinSessionId)).toEqual(["user-tab"]);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(captured).toEqual([]);
    const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
    expect(listInbox(projectId).find((i) => i.id === item.id)?.state).toBe("open");
  });
});

describe("a finished idle tab's close item", () => {
  it("accepting it closes the tab as the user and keeps the branch", async () => {
    const { meta, projectId, consent } = await setup();
    const { createPreparedSessionWorktree } = await import("@marvin/runtime/worktree-setup");
    const rec = createPreparedSessionWorktree(repo, { sessionId: "done-tab", title: "done" }).record;
    writeFileSync(path.join(rec.path, "work.txt"), "unfinished thought\n");
    meta.upsertSessionMeta(projectId, "done-tab", { workDir: repo, tree: { mode: "worktree", slug: rec.slug, path: rec.path, branch: rec.branch, base: rec.base }, posture: POSTURE }, { scopeMetAt: "2026-10-30T10:00:00.000Z" });
    const { proposeCloseKeep } = await import("@marvin/runtime/supervisor-loop");
    proposeCloseKeep(projectId, "done-tab", "2026-10-30T10:00:00.000Z");
    const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
    const item = listInbox(projectId, { state: "open" })[0];
    const r = await consent({ id: item?.id, actionId: "perform" });
    expect(r.status).toBe(200);
    expect(meta.readSessionMeta(projectId, "done-tab")?.closedAt).toBeTruthy();
    expect(git("branch", "--list", rec.branch)).toContain(rec.branch);
    // Keep committed the dirty tree first, so nothing kept can be lost to a sweep (ADR-0111).
    expect(git("log", "--format=%s", "-1", rec.branch)).not.toBe("init");
  });
});

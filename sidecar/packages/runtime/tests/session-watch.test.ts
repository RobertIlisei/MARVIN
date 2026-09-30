// ADR-0107 — the cold-start snapshot behind the multi-session watch UI.
// Pins the one derivation the UI trusts (deriveSessionState), and that a row
// is assembled from the registries, the meta, the plan state and the cost
// ledger without parsing a transcript — with a real git fixture for the
// `+N −M` badge measured against a worktree's base.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTurnConfirms, registerPendingConfirm } from "../src/confirm-registry";
import { recordTurnCost } from "../src/cost-tracker";
import { createTurnDesignContext, recordAllowedTool } from "../src/design-hooks";
import { __resetLiveGraphUsageForTests, foldTurnGraphUsage, registerLiveGraphUsage } from "../src/graph-usage";
import { writePlanState } from "../src/plan-state";
import { __resetActivityForTests, setActivity } from "../src/session-activity";
import { updateSessionMeta, upsertSessionMeta } from "../src/session-meta";
import {
  __resetSessionDiffMemoForTests,
  __resetSessionReconcileMemoForTests,
  buildSessionWatch,
  deriveSessionState,
  sessionDiff,
} from "../src/session-watch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { createSessionWorktree, createWorktree, markSessionWorktreeClosed } from "../src/worktrees";

describe("deriveSessionState", () => {
  it("needs-you beats working beats interrupted beats failed beats idle", () => {
    expect(deriveSessionState({ live: true, pending: 1 })).toBe("awaiting-you");
    expect(deriveSessionState({ live: true, pending: 0, lastOutcome: "error" })).toBe("working");
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "interrupted" })).toBe("interrupted");
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "error" })).toBe("failed");
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "completed" })).toBe("idle");
    expect(deriveSessionState({ live: false, pending: 0 })).toBe("idle");
    // A pending confirm on a turn that is no longer live cannot exist; idle.
    expect(deriveSessionState({ live: false, pending: 3 })).toBe("idle");
  });
});

describe("deriveSessionState", () => {
  it("an interrupted last turn older than the window reads as idle; a recent one as interrupted", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    const recent = new Date(now - 3600 * 1000).toISOString();
    const stale = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "interrupted", lastStartedAt: recent, now })).toBe("interrupted");
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "interrupted", lastStartedAt: stale, now })).toBe("idle");
    expect(deriveSessionState({ live: false, pending: 0, lastOutcome: "interrupted" })).toBe("interrupted");
    expect(deriveSessionState({ live: true, pending: 1, lastOutcome: "interrupted", lastStartedAt: stale, now })).toBe("awaiting-you");
  });
});

describe("buildSessionWatch", () => {
  let dataDir: string;
  let repo: string;
  let git: (...a: string[]) => string;
  const projectId = "watch-proj";
  const posture = {
    model: "m",
    advisorModel: null,
    personality: "ultron" as const,
    permissionStrategy: "auto" as const,
    thinkingMode: "high",
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-watch-data-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-watch-repo-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    __resetSessionDiffMemoForTests();
    __resetActivityForTests();
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  // ADR-0111 — the row carries the sidecar's derived worktree state, and a
  // closed tab whose branch holds work stays in the universe.
  it("a worktree row carries state, commits, dirty and behind; a closed ready tab is still listed", async () => {
    const wt = createSessionWorktree(repo, { sessionId: "ready-sess", title: "ready tab" });
    upsertSessionMeta(projectId, "ready-sess", {
      workDir: repo,
      tree: { mode: "worktree", slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base },
      posture,
    });
    writeFileSync(join(wt.path, "work.md"), "w\n");
    execFileSync("git", ["add", "work.md"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "tab work"], { cwd: wt.path, stdio: "pipe" });
    // The main checkout moves on by one commit: the tab is now behind by one.
    writeFileSync(join(repo, "main.md"), "m\n");
    git("add", "main.md");
    git("commit", "-qm", "main moved");
    __resetSessionReconcileMemoForTests();

    const open = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["ready-sess"] }))[0]!;
    expect(open.worktree).toMatchObject({ slug: wt.slug, branch: wt.branch, state: "session", commits: 1, dirty: false, behind: 1, closed: false, target: "main" });

    // Close the tab: the meta is closed (so the recent-metas universe drops
    // it) but the branch is `ready` — the reconcile puts it back.
    markSessionWorktreeClosed(repo, "ready-sess");
    updateSessionMeta(projectId, "ready-sess", { closedAt: new Date().toISOString() });
    __resetSessionReconcileMemoForTests();
    const rows = await buildSessionWatch({ projectId, workDir: repo });
    const row = rows.find((r) => r.marvinSessionId === "ready-sess");
    expect(row?.worktree).toMatchObject({ state: "ready", commits: 1, closed: true });
    expect((await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["shared-x"] })).find((r) => r.marvinSessionId === "shared-x")?.worktree).toBeNull();
  });

  // 2026-09-30 — git facts are served stale-while-revalidate, and the tab
  // close may DISCARD a tree it believes empty. `fresh` must see a commit the
  // cached reconcile has not.
  it("fresh derives a tab's worktree from git now, past a stale cached 'empty'", async () => {
    const wt = createSessionWorktree(repo, { sessionId: "fresh-sess" });
    upsertSessionMeta(projectId, "fresh-sess", {
      workDir: repo,
      tree: { mode: "worktree", slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base },
      posture,
    });
    __resetSessionReconcileMemoForTests();
    const before = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["fresh-sess"] }))[0]!;
    expect(before.worktree?.commits).toBe(0);
    writeFileSync(join(wt.path, "late.md"), "l\n");
    execFileSync("git", ["add", "late.md"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "late"], { cwd: wt.path, stdio: "pipe" });
    const cached = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["fresh-sess"] }))[0]!;
    expect(cached.worktree?.commits).toBe(0); // the memo still says empty
    const fresh = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["fresh-sess"], fresh: true }))[0]!;
    expect(fresh.worktree?.commits).toBe(1);
  });


  // ADR-0124 C — every row carries its own graph-vs-file ratio, Bash reads included.
  it("a row carries graphUsage — graph calls, Read and Bash source reads, live then folded", async () => {
    __resetLiveGraphUsageForTests();
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    upsertSessionMeta(projectId, "usage-sess", { workDir: repo, tree: { mode: "shared" }, posture });
    const ctx = createTurnDesignContext("t-usage", repo);
    registerLiveGraphUsage(projectId, "usage-sess", () => ({ graphCalls: ctx.graphCallCount, fileReads: ctx.fileReads, bashReads: ctx.bashReads }));
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "a" });
    recordAllowedTool(ctx, "Bash", { command: "sed -n 1,20p a.ts" });
    recordAllowedTool(ctx, "Bash", { command: `cat ${join(repo, "a.ts")} && grep -rn a .` });
    recordAllowedTool(ctx, "Bash", { command: "pnpm test | tail" });
    recordAllowedTool(ctx, "Read", { file_path: join(repo, "a.ts") });

    const liveRow = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["usage-sess"] }))[0]!;
    expect(liveRow.graphUsage).toEqual({ graphCalls: 1, fileReads: 1, bashReads: 2, ratio: 3 });

    foldTurnGraphUsage(projectId, "usage-sess", { graphCalls: ctx.graphCallCount, fileReads: ctx.fileReads, bashReads: ctx.bashReads });
    foldTurnGraphUsage(projectId, "usage-sess", { graphCalls: 1, fileReads: 0, bashReads: 0 });
    const folded = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["usage-sess"] }))[0]!;
    expect(folded.graphUsage).toEqual({ graphCalls: 2, fileReads: 1, bashReads: 2, ratio: 1.5 });
    expect((await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["never-used"] }))[0]!.graphUsage).toBeNull();
  });

  it("a row's plan carries open steps, the lastTodoAt watermark and whether MARVIN seeded it", async () => {
    upsertSessionMeta(projectId, "plan-sess", { workDir: repo, tree: { mode: "shared" }, posture });
    writePlanState(projectId, "plan-sess", {
      activePlanId: "p",
      lastTodoAt: "2026-09-30T08:00:00.000Z",
      plans: [{ id: "p", seeded: true, steps: [{ status: "completed" }, { status: "superseded" }, { status: "pending" }, { status: "in_progress" }] }],
    });
    const row = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["plan-sess"] }))[0]!;
    expect(row.plan).toEqual({ done: 1, total: 4, open: 2, lastTodoAt: "2026-09-30T08:00:00.000Z", seeded: true });
  });

  it("a worktree session's badge is measured against its base, a shared one against HEAD", async () => {
    const wt = createWorktree(repo, "watch tab");
    upsertSessionMeta(projectId, "wt-sess", {
      workDir: repo,
      tree: { mode: "worktree", slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base },
      posture,
    });
    upsertSessionMeta(projectId, "shared-sess", { workDir: repo, tree: { mode: "shared" }, posture });
    // Two committed lines + one uncommitted line in the worktree; one
    // uncommitted line in the main checkout.
    writeFileSync(join(wt.path, "README.md"), "hi\nline2\nline3\n");
    execFileSync("git", ["commit", "-qam", "wt work"], { cwd: wt.path, stdio: "pipe" });
    writeFileSync(join(wt.path, "README.md"), "hi\nline2\nline3\nline4\n");
    writeFileSync(join(repo, "README.md"), "hi\nmain\n");

    const rows = await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["wt-sess", "shared-sess"] });
    const byId = new Map(rows.map((r) => [r.marvinSessionId, r]));
    const w = byId.get("wt-sess")!;
    expect(w.tree.mode).toBe("worktree");
    expect(w.tree.cwd).toBe(wt.path);
    expect(w.tree.currentBranch).toBe(wt.branch);
    expect(w.diff).toMatchObject({ added: 3, removed: 0, files: 1, vs: "base" });
    const s = byId.get("shared-sess")!;
    expect(s.tree.mode).toBe("shared");
    expect(s.tree.cwd).toBe(repo);
    expect(s.diff).toMatchObject({ added: 1, removed: 0, files: 1, vs: "HEAD" });
    expect(s.state).toBe("idle");
  });

  it("live turn, pending confirm, plan progress and cost land on the row", async () => {
    upsertSessionMeta(projectId, "live-sess", { workDir: repo, tree: { mode: "shared" }, posture });
    const t = registerLiveTurn({ turnId: "watch-t1", marvinSessionId: "live-sess", projectId, kind: "human" });
    setActivity({ projectId, marvinSessionId: "live-sess", turnId: "watch-t1" }, "tool", "Bash");
    registerPendingConfirm("watch-t1", "u1", () => {}, {}, 0, { toolName: "Bash" });
    writePlanState(projectId, "live-sess", {
      activePlanId: "p1",
      plans: [{ id: "p1", steps: [{ status: "completed" }, { status: "completed" }, { status: "pending" }] }],
    });
    recordTurnCost({ projectId, marvinSessionId: "live-sess", costUsd: 0.5, tokenUsage: { input_tokens: 1 } });
    try {
      const row = (await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["live-sess"] }))[0]!;
      expect(row.activity).toMatchObject({ state: "tool", tool: "Bash", turnId: "watch-t1" });
      expect(row.state).toBe("awaiting-you");
      expect(row.turn).toMatchObject({ turnId: "watch-t1", kind: "human", mutated: false });
      expect(row.pending.map((p) => p.toolName)).toEqual(["Bash"]);
      expect(row.plan).toMatchObject({ done: 2, total: 3, open: 1 });
      expect(row.cost).toEqual({ turns: 1, costUsd: 0.5 });
    } finally {
      clearTurnConfirms("watch-t1");
      endLiveTurn(t, { event: "turn.completed", data: {} });
    }
  });

  it("a session with no meta (pre-0107) rows as shared on the project root; closed metas are not volunteered", async () => {
    upsertSessionMeta(projectId, "closed", { workDir: repo, tree: { mode: "shared" }, posture }, { closedAt: "2026-09-09T00:00:00.000Z" });
    upsertSessionMeta(projectId, "open", { workDir: repo, tree: { mode: "shared" }, posture });
    const rows = await buildSessionWatch({ projectId, workDir: repo, sessionIds: ["legacy"] });
    const ids = rows.map((r) => r.marvinSessionId);
    expect(ids).toContain("legacy");
    expect(ids).toContain("open");
    expect(ids).not.toContain("closed");
    const legacy = rows.find((r) => r.marvinSessionId === "legacy")!;
    expect(legacy.tree).toMatchObject({ mode: "shared", cwd: repo, present: true });
    expect(legacy.lastTurn).toBeNull();
  });

  // 2026-09-30 — stale-while-revalidate: a request never waits on git once a
  // value exists. Stale serves the old value AND starts one refresh.
  it("the diff is served from cache, and a stale one refreshes in the background", async () => {
    const first = await sessionDiff(repo, null, 1000);
    writeFileSync(join(repo, "README.md"), "hi\nchanged\n");
    expect(await sessionDiff(repo, null, 1500)).toBe(first); // fresh: same object
    expect(await sessionDiff(repo, null, 10_000)).toBe(first); // stale: still served at once
    await new Promise((r) => setTimeout(r, 300)); // the background refresh lands
    const next = await sessionDiff(repo, null, 10_001);
    expect(next).not.toBe(first);
    expect(next?.added).toBeGreaterThan(first?.added ?? 0);
  });
});

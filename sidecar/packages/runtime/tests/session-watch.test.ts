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

import { registerPendingConfirm, clearTurnConfirms } from "../src/confirm-registry";
import { recordTurnCost } from "../src/cost-tracker";
import { writePlanState } from "../src/plan-state";
import { upsertSessionMeta } from "../src/session-meta";
import {
  __resetSessionDiffMemoForTests,
  buildSessionWatch,
  deriveSessionState,
  sessionDiff,
} from "../src/session-watch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { createWorktree } from "../src/worktrees";

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
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("a worktree session's badge is measured against its base, a shared one against HEAD", () => {
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

    const rows = buildSessionWatch({ projectId, workDir: repo, sessionIds: ["wt-sess", "shared-sess"] });
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

  it("live turn, pending confirm, plan progress and cost land on the row", () => {
    upsertSessionMeta(projectId, "live-sess", { workDir: repo, tree: { mode: "shared" }, posture });
    const t = registerLiveTurn({ turnId: "watch-t1", marvinSessionId: "live-sess", projectId, kind: "human" });
    registerPendingConfirm("watch-t1", "u1", () => {}, {}, 0, { toolName: "Bash" });
    writePlanState(projectId, "live-sess", {
      activePlanId: "p1",
      plans: [{ id: "p1", steps: [{ status: "completed" }, { status: "completed" }, { status: "pending" }] }],
    });
    recordTurnCost({ projectId, marvinSessionId: "live-sess", costUsd: 0.5, tokenUsage: { input_tokens: 1 } });
    try {
      const row = buildSessionWatch({ projectId, workDir: repo, sessionIds: ["live-sess"] })[0]!;
      expect(row.state).toBe("awaiting-you");
      expect(row.turn).toMatchObject({ turnId: "watch-t1", kind: "human", mutated: false });
      expect(row.pending.map((p) => p.toolName)).toEqual(["Bash"]);
      expect(row.plan).toEqual({ done: 2, total: 3 });
      expect(row.cost).toEqual({ turns: 1, costUsd: 0.5 });
    } finally {
      clearTurnConfirms("watch-t1");
      endLiveTurn(t, { event: "turn.completed", data: {} });
    }
  });

  it("a session with no meta (pre-0107) rows as shared on the project root; closed metas are not volunteered", () => {
    upsertSessionMeta(projectId, "closed", { workDir: repo, tree: { mode: "shared" }, posture }, { closedAt: "2026-09-09T00:00:00.000Z" });
    upsertSessionMeta(projectId, "open", { workDir: repo, tree: { mode: "shared" }, posture });
    const rows = buildSessionWatch({ projectId, workDir: repo, sessionIds: ["legacy"] });
    const ids = rows.map((r) => r.marvinSessionId);
    expect(ids).toContain("legacy");
    expect(ids).toContain("open");
    expect(ids).not.toContain("closed");
    const legacy = rows.find((r) => r.marvinSessionId === "legacy")!;
    expect(legacy.tree).toMatchObject({ mode: "shared", cwd: repo, present: true });
    expect(legacy.lastTurn).toBeNull();
  });

  it("the diff is memoised briefly so a refreshing strip does not fan out git calls", () => {
    const first = sessionDiff(repo, null, 1000);
    writeFileSync(join(repo, "README.md"), "hi\nchanged\n");
    expect(sessionDiff(repo, null, 1500)).toBe(first); // within 2 s: same object
    expect(sessionDiff(repo, null, 4000)).not.toBe(first);
  });
});

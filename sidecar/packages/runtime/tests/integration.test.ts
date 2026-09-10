// ADR-0111 — integration preview and the Sync turn. Pins: a clean branch
// previews clean; two branches touching the same line preview as a conflict
// naming the file, before any merge runs and with the checkout untouched;
// `behind` counts the target's new commits; open tabs are listed with a
// reason, not hidden; the Sync prompt says what to do and what not to; and
// sync is refused for the cases that would make it wrong.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dryRunMerge, previewIntegration, syncPrompt, syncWithTarget } from "../src/integration";
import { addProject } from "../src/projects";
import { upsertSessionMeta } from "../src/session-meta";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { createSessionWorktree, markSessionWorktreeClosed } from "../src/worktrees";

describe("integration preview", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-integ-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "shared.ts"), "base\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const commitIn = (path: string, file: string, body: string) => {
    writeFileSync(join(path, file), body);
    execFileSync("git", ["add", file], { cwd: path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", `edit ${file}`], { cwd: path, stdio: "pipe" });
  };

  it("previews clean, conflict (naming the file) and behind — without touching the checkout", () => {
    const a = createSessionWorktree(repo, { sessionId: "sa", title: "adds a file" });
    const b = createSessionWorktree(repo, { sessionId: "sb", title: "edits shared" });
    commitIn(a.path, "new.ts", "a\n");
    commitIn(b.path, "shared.ts", "from b\n");
    // The target moves: it edits the same line as b, and gains one commit.
    commitIn(repo, "shared.ts", "from main\n");
    markSessionWorktreeClosed(repo, "sa");
    markSessionWorktreeClosed(repo, "sb");
    const headBefore = git("rev-parse", "HEAD");

    const p = previewIntegration(repo);
    expect(p.previewAvailable).toBe(true);
    expect(p.target).toBe("main");
    const ra = p.rows.find((r) => r.slug === a.slug)!;
    const rb = p.rows.find((r) => r.slug === b.slug)!;
    expect(ra).toMatchObject({ state: "ready", commits: 1, behind: 1, verdict: "clean", conflicts: [] });
    expect(rb).toMatchObject({ state: "ready", commits: 1, behind: 1, verdict: "conflict", conflicts: ["shared.ts"] });
    // Nothing moved.
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    // (`.marvin/` is the registry MARVIN itself writes — untracked by design.)
    expect(git("status", "--porcelain").split("\n").filter((l) => l && !l.includes(".marvin/"))).toEqual([]);
  });

  it("lists an open tab with its reason, and a branch with no commits as clean", () => {
    const open = createSessionWorktree(repo, { sessionId: "open", title: "still open" });
    commitIn(open.path, "x.ts", "x\n");
    const p = previewIntegration(repo, { includeOpen: true });
    const row = p.rows.find((r) => r.slug === open.slug)!;
    expect(row.state).toBe("session");
    expect(row.skipReason).toMatch(/open chat tab/);
    expect(row.verdict).toBe("clean");
    const empty = createSessionWorktree(repo, { sessionId: "empty", title: "nothing" });
    markSessionWorktreeClosed(repo, "empty");
    const p2 = previewIntegration(repo, { slugs: [empty.slug] });
    expect(p2.rows[0]).toMatchObject({ commits: 0, verdict: "clean", skipReason: "has no commits" });
  });

  it("dryRunMerge is unknown for a ref that does not exist, never a guess", () => {
    expect(dryRunMerge(repo, "main", "no-such-branch").verdict).toBe("unknown");
  });

  it("the Sync prompt names branch, target, the conflicting files, and forbids rebase/push", () => {
    const text = syncPrompt({ branch: "marvin/tab/x", target: "main", targetHead: "abcdef0123", conflicts: ["a.ts", "b.ts"] });
    expect(text).toContain("`marvin/tab/x`");
    expect(text).toContain("`main` (abcdef0)");
    expect(text).toContain("a.ts, b.ts");
    expect(text).toMatch(/Do not rebase, do not push/);
    expect(syncPrompt({ branch: "b", target: "main", targetHead: "x", conflicts: [] })).toMatch(/no conflicts, but the branch is behind/);
  });
});

describe("syncWithTarget refusals", () => {
  let dataDir: string;
  let repo: string;
  let projectId: string;
  const posture = { model: "m", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-sync-data-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-sync-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "pipe" });
    projectId = addProject({ workDir: repo }).id;
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("refuses a shared tab, a live tab, and a tab whose worktree is gone", async () => {
    upsertSessionMeta(projectId, "shared", { workDir: repo, tree: { mode: "shared" }, posture });
    expect((await syncWithTarget(projectId, "shared", repo))).toMatchObject({ ok: false, code: "not-isolated" });

    const wt = createSessionWorktree(repo, { sessionId: "wt" });
    upsertSessionMeta(projectId, "wt", { workDir: repo, tree: { mode: "worktree", slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base }, posture });
    const live = registerLiveTurn({ turnId: "t-sync", marvinSessionId: "wt", projectId });
    try {
      expect((await syncWithTarget(projectId, "wt", repo))).toMatchObject({ ok: false, code: "turn-live" });
    } finally {
      endLiveTurn(live, { event: "turn.completed", data: {} });
    }
    rmSync(wt.path, { recursive: true, force: true });
    expect((await syncWithTarget(projectId, "wt", repo))).toMatchObject({ ok: false, code: "worktree-missing" });
    expect((await syncWithTarget(projectId, "nobody", repo))).toMatchObject({ ok: false, code: "not-isolated" });
  });
});

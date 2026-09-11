import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { __resetIntegrationJobsForTests, getIntegrationJob, startIntegrationJob } from "../src/integration-job";
import { createSessionWorktree, createWorktree, detectMergeTarget, prepareMergeRequest, reconcileWorktrees } from "../src/worktrees";

// A day of chat tabs is one piece of work to a reviewer. These pin the shape
// of the integration branch: one commit, tab branches untouched, the user's
// own checkout never entered, every skip named.

describe("prepareMergeRequest", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "marvin-mr-"));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  const commitIn = (path: string, file: string, body = "x\n", message = `add ${file}`) => {
    writeFileSync(join(path, file), body);
    execFileSync("git", ["add", file], { cwd: path, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", message], { cwd: path, stdio: "pipe" });
  };

  it("squashes every chosen finished branch into ONE commit and leaves everything else alone", async () => {
    const a = createWorktree(repo, "first task");
    const b = createWorktree(repo, "second task");
    commitIn(a.path, "a.ts");
    commitIn(a.path, "a2.ts");
    commitIn(b.path, "b.ts");
    // The user's checkout is dirty with MARVIN's bookkeeping, as it always is.
    writeFileSync(join(repo, "README.md"), "edited\n");
    const headBefore = git("rev-parse", "HEAD");

    const out = await prepareMergeRequest(repo, { slugs: [a.slug, b.slug], name: "RLS hardening" });

    expect(out.ok).toBe(true);
    expect(out.branch).toMatch(/^mr\/\d{4}-\d{2}-\d{2}-rls-hardening$/);
    expect(out.merged.map((m) => m.branch)).toEqual([a.branch, b.branch]);
    // One commit on top of the base, not three.
    expect(git("rev-list", "--count", `${headBefore}..${out.branch}`)).toBe("1");
    expect(git("ls-tree", "--name-only", out.branch)).toContain("a2.ts");
    expect(git("ls-tree", "--name-only", out.branch)).toContain("b.ts");
    // The message names each folded branch and its task.
    expect(out.message).toMatch(/^chore: integrate 2 branches/);
    expect(git("log", "-1", "--format=%B", out.branch)).toContain("first task");
    // The user's checkout: same HEAD, same dirty file, no temp worktree left.
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    expect(git("status", "--porcelain")).toContain("README.md");
    expect(git("worktree", "list")).not.toContain("/mr-");
    // Tab branches keep their own history.
    expect(git("rev-list", "--count", `${headBefore}..${a.branch}`)).toBe("2");
    expect(out.summary).toMatch(/Not pushed/);
  }, 30_000);

  it("skips an open tab's branch with the way to include it, and stops at a conflict naming it", async () => {
    const a = createWorktree(repo, "clean");
    commitIn(a.path, "same.ts", "from a\n");
    const c = createWorktree(repo, "clashing");
    commitIn(c.path, "same.ts", "from c\n");
    const s = createSessionWorktree(repo, { sessionId: "s1", title: "open tab" });
    commitIn(s.path, "tab.ts");

    const out = await prepareMergeRequest(repo, { slugs: [a.slug, c.slug, s.slug, "nope"] });

    expect(out.ok).toBe(true);
    expect(out.merged.map((m) => m.slug)).toEqual([a.slug]);
    expect(out.stopped?.slug).toBe(c.slug);
    expect(out.skipped.find((k) => k.slug === s.slug)?.reason).toMatch(/open tab/);
    expect(out.skipped.find((k) => k.slug === "nope")?.reason).toMatch(/no such/);
    expect(git("ls-tree", "--name-only", out.branch)).toContain("same.ts");
    expect(git("show", `${out.branch}:same.ts`)).toBe("from a");
    expect(out.summary).toMatch(/Stopped at/);
  }, 30_000);

  it("strips a typed `mr/<date>-` prefix so the branch never doubles it, and lends the temporary tree its preparation", async () => {
    const a = createWorktree(repo, "billing replay");
    commitIn(a.path, "a.ts");
    const day = new Date().toISOString().slice(0, 10);
    const prepared: string[] = [];

    const out = await prepareMergeRequest(repo, {
      slugs: [a.slug],
      name: `mr/${day}-billing`,
      push: false,
      openMergeRequest: false,
      prepare: (path) => prepared.push(path),
    });

    expect(out.ok).toBe(true);
    expect(out.branch).toBe(`mr/${day}-billing`);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toContain(`mr-${day}-billing-`);
    // The temporary tree is gone once the commit exists.
    expect(existsSync(prepared[0]!)).toBe(false);
  });

  it("registers a run the panel can follow, and leaves its outcome readable afterwards", async () => {
    __resetIntegrationJobsForTests();
    const a = createWorktree(repo, "billing replay");
    commitIn(a.path, "a.ts");

    const out = await prepareMergeRequest(repo, { slugs: [a.slug], push: false, openMergeRequest: false });

    expect(out.ok).toBe(true);
    // The client may have stopped waiting long before this point; the record
    // is what it comes back to.
    const job = getIntegrationJob(repo);
    expect(job).toMatchObject({ kind: "prepare-mr", running: false, ok: true, branch: out.branch });
    expect(job?.summary).toBe(out.summary);
  });

  it("refuses to start while another integration is running on the same checkout", async () => {
    __resetIntegrationJobsForTests();
    const a = createWorktree(repo, "billing replay");
    commitIn(a.path, "a.ts");
    startIntegrationJob(repo, "merge-all", 1);

    const out = await prepareMergeRequest(repo, { slugs: [a.slug], push: false, openMergeRequest: false });

    expect(out.ok).toBe(false);
    expect(out.summary).toContain("already running");
    // Nothing was cut: the refusal happens before any git.
    expect(out.branch).toBe("");
    __resetIntegrationJobsForTests();
  });

  it("a run stopped by a conflict counts only what applied, and does not push a partial integration", async () => {
    // 2026-09-11, on a real project: six branches ticked, the second
    // conflicted, and MARVIN pushed a commit titled "integrate 6 branches"
    // carrying one branch's six files — then opened a merge request for it.
    const bare = mkdtempSync(join(tmpdir(), "marvin-mr-partial-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git("remote", "add", "gitlab", bare);
    git("push", "-q", "-u", "gitlab", "main");
    const a = createWorktree(repo, "first task");
    commitIn(a.path, "same.ts", "from a\n");
    const c = createWorktree(repo, "clashing task");
    commitIn(c.path, "same.ts", "from c\n");

    const out = await prepareMergeRequest(repo, {
      slugs: [a.slug, c.slug],
      push: true,
      openMergeRequest: true,
    });

    expect(out.merged.map((m) => m.slug)).toEqual([a.slug]);
    expect(out.stopped?.slug).toBe(c.slug);
    // The subject counts ONE, and names it — never the number asked for.
    expect(out.message.split("\n")[0]).toBe("chore: integrate first task");
    expect(git("log", "-1", "--format=%s", out.branch)).toBe("chore: integrate first task");
    // Nothing was pushed and no request was opened.
    expect(out.pushed).toBeUndefined();
    expect(execFileSync("git", ["branch", "--list", "mr/*"], { cwd: bare, encoding: "utf-8" })).toBe("");
    expect(out.summary).toContain("Not pushed");
    expect(out.summary).toContain(c.branch);
  }, 30_000);

  it("keeps the user's own commit message even when a branch is dropped", async () => {
    const a = createWorktree(repo, "first task");
    commitIn(a.path, "same.ts", "from a\n");
    const c = createWorktree(repo, "clashing task");
    commitIn(c.path, "same.ts", "from c\n");

    const out = await prepareMergeRequest(repo, {
      slugs: [a.slug, c.slug],
      message: "feat(billing): the wording I typed",
      push: false,
      openMergeRequest: false,
    });

    expect(out.message).toBe("feat(billing): the wording I typed");
    expect(git("log", "-1", "--format=%s", out.branch)).toBe("feat(billing): the wording I typed");
  }, 30_000);

  it("integrates nothing and leaves no branch when nothing was finished", async () => {
    const s = createSessionWorktree(repo, { sessionId: "s1", title: "open tab" });
    commitIn(s.path, "tab.ts");
    const out = await prepareMergeRequest(repo, { slugs: [s.slug] });
    expect(out.ok).toBe(false);
    expect(git("branch", "--list", "mr/*")).toBe("");
  });

  it("pushes to the tracked remote when asked, and reports an MR push option the remote refuses", async () => {
    const bare = mkdtempSync(join(tmpdir(), "marvin-mr-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git("remote", "add", "gitlab", bare);
    git("push", "-q", "-u", "gitlab", "main");
    expect(detectMergeTarget(repo)).toEqual({ remote: "gitlab", target: "main" });
    const a = createWorktree(repo, "ship it");
    commitIn(a.path, "a.ts");

    const pushed = await prepareMergeRequest(repo, { slugs: [a.slug], push: true });
    expect(pushed.ok).toBe(true);
    expect(pushed.pushed?.remote).toBe("gitlab");
    expect(execFileSync("git", ["branch", "--list", "mr/*"], { cwd: bare, encoding: "utf-8" })).toContain(pushed.branch);

    // A bare local remote advertises no push options; the failure is named,
    // and the branch is still on disk for a manual push.
    const b = createWorktree(repo, "ship it again");
    commitIn(b.path, "b.ts");
    const mr = await prepareMergeRequest(repo, { slugs: [b.slug], push: true, openMergeRequest: true });
    expect(mr.ok).toBe(false);
    expect(mr.summary).toMatch(/Push to gitlab failed/);
    expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(git("branch", "--list", mr.branch)).toContain(mr.branch);
  }, 30_000);

  it("reconcile reports a tip date and line counts for unmerged work", () => {
    const a = createWorktree(repo, "counted");
    commitIn(a.path, "a.ts", "one\ntwo\n");
    const row = reconcileWorktrees(repo, Date.now() + 48 * 3_600_000).find((w) => w.slug === a.slug);
    expect(row?.lastCommitAt).toMatch(/^\d{4}-/);
    expect(row?.added).toBe(2);
    expect(row?.removed).toBe(0);
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bindWorktreeTask,
  commitWorktreeWorkInProgress,
  createSessionWorktree,
  createWorktree,
  listWorktrees,
  markWorktreeFinished,
  mergeAllWorktrees,
  mergeWorktree,
  reconcileWorktrees,
  removeWorktree,
  sweepWorktrees,
  unstageSymlinkedDirs,
  worktreeHasWork,
} from "../src/worktrees";

// ADR-0103 — an implementer's branch is a deliverable with a lifecycle, and
// every state except "running" is DERIVED from git rather than recorded. The
// case that forces that design: the user merges in a terminal, in another
// session, or by hand, and MARVIN is not there to write it down. These pin
// the derivation, and the one rule that must never break — nothing holding
// unmerged commits is ever deleted.

/** Far enough ahead that the `running` grace period has lapsed. */
const LATER = Date.now() + 48 * 3_600_000;

describe("worktree lifecycle", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "marvin-wtl-"));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  /** Commit one file inside a worktree, the way an implementer would. */
  const commitIn = (path: string, file: string, body = "x\n", message = `add ${file}`) => {
    writeFileSync(join(path, file), body);
    execFileSync("git", ["add", file], { cwd: path, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", message], { cwd: path, stdio: "pipe" });
  };

  /**
   * Install the Conventional-Commits `commit-msg` hook that made every real
   * merge fail on 2026-09-01 — four `worktree_merge` calls, four rejections.
   * The fixture had no hooks, which is exactly why the suite was green while
   * the tool was unusable in production.
   *
   * Copied in shape from the hook that did the rejecting, including its merge
   * exemption: that exemption is what the fix relies on.
   */
  const installConventionalCommitHook = () => {
    const dir = join(repo, ".githooks");
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, "commit-msg");
    writeFileSync(
      hook,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SUBJECT=$(head -1 "$1")',
        `if echo "$SUBJECT" | grep -qE '^(Merge |fixup! |squash! |Revert ")'; then exit 0; fi`,
        `if ! echo "$SUBJECT" | grep -qE '^(feat|fix|chore|docs|refactor|test)([(][A-Za-z][A-Za-z0-9-]*[)])?: .+'; then`,
        '  echo "  commit message format violation" >&2',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    // Track it before arming it: an untracked file makes the main tree dirty,
    // and `mergeWorktree` refuses a dirty tree before it ever reaches git.
    git("add", ".githooks/commit-msg");
    git("commit", "-qm", "chore(hooks): add commit-msg");
    git("config", "core.hooksPath", ".githooks");
  };


  // ── Batch integration (ADR-0109) ─────────────────────────────────────────
  //
  // Five chat tabs produce five branches, and one merge request each costs
  // ~48 compute-minutes against an allowance already exceeded. Folding them
  // in locally costs nothing, so the batch path has to be as trustworthy as
  // the single one: it must merge in a defined order, refuse to touch a
  // branch that is not finished, and stop rather than half-integrate.

  it("merges every ready branch in one pass, oldest first", () => {
    const a = createWorktree(repo, "first task");
    const b = createWorktree(repo, "second task");
    const c = createWorktree(repo, "third task");
    commitIn(a.path, "a.ts");
    commitIn(b.path, "b.ts");
    commitIn(c.path, "c.ts");

    const out = mergeAllWorktrees(repo);

    expect(out.stopped).toBeUndefined();
    expect(out.merged.map((m) => m.branch)).toEqual([a.branch, b.branch, c.branch]);
    for (const f of ["a.ts", "b.ts", "c.ts"]) {
      expect(existsSync(join(repo, f)), f).toBe(true);
    }
    // Local only — the message says so, because that is the whole point.
    expect(out.message).toMatch(/Not pushed/);
  }, 30_000);

  it("says so plainly when there is nothing to merge", () => {
    const out = mergeAllWorktrees(repo);
    expect(out.merged).toEqual([]);
    expect(out.message).toMatch(/No finished branches/);
  });

  it("never touches a branch that is not finished, and says why", () => {
    const ready = createWorktree(repo, "done");
    commitIn(ready.path, "done.ts");
    // An open chat tab's tree: its branch is decided at tab close, not here.
    const session = createSessionWorktree(repo, { sessionId: "s1", title: "an open tab" });
    commitIn(session.path, "tab.ts");
    // An implementer still building: `running` is the one state that is
    // RECORDED rather than derived, and binding the task is what records it.
    const running = createWorktree(repo, "in flight");
    commitIn(running.path, "wip.ts");
    bindWorktreeTask(repo, running.path, "task-1");

    const out = mergeAllWorktrees(repo);

    expect(out.merged.map((m) => m.branch)).toEqual([ready.branch]);
    const skipped = Object.fromEntries(out.skipped.map((s) => [s.slug, s.reason]));
    expect(skipped[session.slug]).toMatch(/open chat tab/);
    expect(skipped[running.slug]).toMatch(/implementer/);
    expect(existsSync(join(repo, "tab.ts"))).toBe(false);
  }, 30_000);

  it("stops at the first conflict instead of half-integrating", () => {
    // Two branches that change the same line: the second cannot apply.
    const a = createWorktree(repo, "first");
    const b = createWorktree(repo, "second");
    commitIn(a.path, "shared.ts", "from a\n");
    commitIn(b.path, "shared.ts", "from b\n");

    const out = mergeAllWorktrees(repo);

    expect(out.merged).toHaveLength(1);
    expect(out.stopped?.branch).toBe(b.branch);
    // The aborted merge left nothing behind: no half-applied merge, and the
    // branch still exists to be resolved by hand. (`.marvin/` is untracked
    // bookkeeping and is what `workingTreeDirty` deliberately ignores.)
    const status = git("status", "--porcelain")
      .split("\n")
      .filter((l) => l.trim() && !l.includes(".marvin/"));
    expect(status).toEqual([]);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git("branch", "--list", b.branch).trim()).not.toBe("");
    expect(out.message).toMatch(/Stopped at/);
  }, 30_000);

  it("an untracked file in the main tree does not block a merge", () => {
    // A user clicked "Merge into my branch" and nothing happened: their tree
    // held three untracked files no merge would have touched. `git merge`
    // refuses only when it would OVERWRITE an untracked file, and says which;
    // this pre-check refused merely because one existed.
    const a = createWorktree(repo, "ready work");
    commitIn(a.path, "feature.ts");
    writeFileSync(join(repo, "NOTES.md"), "a stray file\n");

    const out = mergeWorktree(repo, a.slug);

    expect(out.ok).toBe(true);
    expect(existsSync(join(repo, "feature.ts"))).toBe(true);
    // The stray file is untouched — merging is not a reason to lose it.
    expect(existsSync(join(repo, "NOTES.md"))).toBe(true);
  });

  it("merges past a modified tracked file the branch does not touch, and keeps the edit", () => {
    // 2026-09-11: a nine-file billing branch could not close with Merge
    // because two ADRs another tab was writing were unsaved on main. Git
    // merges disjoint paths without a word; so does MARVIN now.
    const a = createWorktree(repo, "ready work");
    commitIn(a.path, "feature.ts");
    writeFileSync(join(repo, "README.md"), "edited, not committed\n");

    const out = mergeWorktree(repo, a.slug);

    expect(out.ok).toBe(true);
    expect(existsSync(join(repo, "feature.ts"))).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("edited, not committed\n");
  });

  it("refuses when a modified tracked file is one the branch changes, naming it", () => {
    const a = createWorktree(repo, "ready work");
    commitIn(a.path, "README.md", "the branch's README\n");
    writeFileSync(join(repo, "README.md"), "edited, not committed\n");

    const out = mergeWorktree(repo, a.slug);

    expect(out.ok).toBe(false);
    expect(out.message).toContain("README.md");
    expect(out.message).toMatch(/would be overwritten/);
    // Nothing half-done: the edit is still there and no merge is in progress.
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("edited, not committed\n");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("merge-all folds the branches an edit on main does not overlap, and stops at the one it does", () => {
    const a = createWorktree(repo, "ready one");
    commitIn(a.path, "x.ts");
    const b = createWorktree(repo, "ready two");
    commitIn(b.path, "README.md", "b's README\n");
    writeFileSync(join(repo, "README.md"), "edited but not committed\n");

    const out = mergeAllWorktrees(repo);

    expect(out.merged.map((m) => m.branch)).toEqual([a.branch]);
    expect(out.stopped?.branch).toBe(b.branch);
    expect(out.stopped?.message).toContain("README.md");
  });

  it("merges past a Conventional-Commits commit-msg hook", () => {
    installConventionalCommitHook();
    const rec = createWorktree(repo, "wire RealEtransportAdapter health recorder calls");
    commitIn(rec.path, "adapter.ts", "x\n", "fix(etransport): record health outcomes");

    const out = mergeWorktree(repo, rec.slug);

    expect(out.ok).toBe(true);
    // The subject is git's own wording — that is what every merge exemption,
    // this hook's included, is written to match.
    expect(git("log", "-1", "--format=%s")).toBe(`Merge branch '${rec.branch}'`);
    // The task survives, in the body, where no hook inspects it.
    expect(git("log", "-1", "--format=%b")).toContain("wire RealEtransportAdapter health recorder calls");
  });

  it("refuses to remove a checkout whose implementer is still running, unless forced", () => {
    const rec = createWorktree(repo, "still building");
    bindWorktreeTask(repo, rec.path, "task-live");
    expect(reconcileWorktrees(repo)[0]?.state).toBe("running");

    const refused = removeWorktree(repo, rec.slug);
    expect(refused.removed).toBeNull();
    expect(refused.refused).toMatch(/still being built/);
    expect(existsSync(rec.path)).toBe(true);
    expect(listWorktrees(repo)).toHaveLength(1);

    const forced = removeWorktree(repo, rec.slug, { force: true });
    expect(forced.removed?.slug).toBe(rec.slug);
    expect(existsSync(rec.path)).toBe(false);
    // The branch survives a removal — only `sweepWorktrees` deletes refs.
    expect(git("branch", "--list", rec.branch)).toContain(rec.branch);
  });

  it("is `running` until the implementer finishes, and is never swept while it is", () => {
    const rec = createWorktree(repo, "build the thing");
    bindWorktreeTask(repo, rec.path, "task-1");
    expect(reconcileWorktrees(repo)[0]?.state).toBe("running");
    expect(sweepWorktrees(repo)).toEqual([]);
    expect(existsSync(rec.path)).toBe(true);
  });

  it("reports `empty` for a branch with no commits and reclaims both checkout and branch", () => {
    const rec = createWorktree(repo, "produce nothing");
    const w = reconcileWorktrees(repo, LATER)[0];
    expect(w?.state).toBe("empty");
    expect(w?.commits).toBe(0);

    const [outcome] = sweepWorktrees(repo, LATER);
    expect(outcome?.removedCheckout).toBe(true);
    expect(outcome?.deletedBranch).toBe(true);
    expect(existsSync(rec.path)).toBe(false);
    expect(git("branch", "--list", "marvin/*")).toBe("");
    expect(listWorktrees(repo)).toEqual([]);
  });

  it("reports `ready` for unmerged commits and the sweep NEVER touches it", () => {
    const rec = createWorktree(repo, "real work");
    commitIn(rec.path, "feature.ts");

    const w = reconcileWorktrees(repo, LATER)[0];
    expect(w?.state).toBe("ready");
    expect(w?.commits).toBe(1);
    expect(w?.filesChanged).toBe(1);

    expect(sweepWorktrees(repo, LATER)).toEqual([]);
    expect(existsSync(rec.path)).toBe(true);
    expect(git("branch", "--list", "marvin/*")).toContain("marvin/real-work");
  });

  it("detects a merge MARVIN never witnessed — into a branch that is not HEAD", () => {
    const rec = createWorktree(repo, "merged elsewhere");
    commitIn(rec.path, "feature.ts");

    // The user integrates by hand, on some other branch, then walks away.
    git("checkout", "-q", "-b", "integration");
    git("merge", "-q", "--no-ff", "-m", "integrate", "marvin/merged-elsewhere");
    git("checkout", "-q", "main");

    const w = reconcileWorktrees(repo, LATER)[0];
    expect(w?.state).toBe("merged");
    expect(w?.mergedInto).toBe("integration");

    const [outcome] = sweepWorktrees(repo, LATER);
    expect(outcome?.deletedBranch).toBe(true);
    expect(outcome?.reason).toContain("already merged into integration");
    expect(existsSync(rec.path)).toBe(false);
  });

  it("keeps anything dirty, in every state — uncommitted work is never collateral", () => {
    const rec = createWorktree(repo, "left dirty");
    writeFileSync(join(rec.path, "scratch.txt"), "unsaved\n");

    const w = reconcileWorktrees(repo, LATER)[0];
    expect(w?.state).toBe("empty");
    expect(w?.dirty).toBe(true);

    const [outcome] = sweepWorktrees(repo, LATER);
    expect(outcome?.removedCheckout).toBe(false);
    expect(outcome?.deletedBranch).toBe(false);
    expect(outcome?.reason).toContain("uncommitted");
    expect(existsSync(join(rec.path, "scratch.txt"))).toBe(true);
  });

  it("adopts a branch the registry lost — the orphan `worktree_remove` used to hide forever", () => {
    const rec = createWorktree(repo, "orphan me");
    commitIn(rec.path, "feature.ts");
    removeWorktree(repo, rec.slug); // drops the record, keeps the branch
    expect(listWorktrees(repo)).toEqual([]);

    const w = reconcileWorktrees(repo, LATER);
    expect(w.map((r) => r.branch)).toEqual(["marvin/orphan-me"]);
    expect(w[0]?.state).toBe("ready");
    expect(w[0]?.checkoutPresent).toBe(false);
  });

  it("drops a record whose branch was deleted outside MARVIN", () => {
    const rec = createWorktree(repo, "deleted branch");
    git("worktree", "remove", "--force", rec.path);
    git("branch", "-D", rec.branch);
    expect(reconcileWorktrees(repo, LATER)).toEqual([]);
  });

  it("reuses a slug only when nothing holds it — not by array length", () => {
    const a = createWorktree(repo, "same name");
    const b = createWorktree(repo, "same name");
    expect(b.slug).toBe("same-name-2");
    // Removing the first drops the record but KEEPS its branch; the next
    // create must not collide with that surviving ref.
    removeWorktree(repo, a.slug);
    expect(createWorktree(repo, "same name").slug).toBe("same-name-3");
  });

  it("binds a task id and finishing flips it out of `running`", () => {
    const rec = createWorktree(repo, "bound task");
    bindWorktreeTask(repo, rec.path, "task-42");
    expect(listWorktrees(repo)[0]?.taskId).toBe("task-42");
    expect(reconcileWorktrees(repo)[0]?.state).toBe("running");

    const finished = markWorktreeFinished(repo, "task-42");
    expect(finished?.state).toBe("empty");
    expect(listWorktrees(repo)[0]?.finishedAt).toBeTruthy();
  });

  it("merges locally into the current branch and does not push", () => {
    const rec = createWorktree(repo, "to merge");
    commitIn(rec.path, "feature.ts");

    const out = mergeWorktree(repo, rec.slug);
    expect(out.ok).toBe(true);
    expect(out.message).toContain("Not pushed");
    expect(existsSync(join(repo, "feature.ts"))).toBe(true);
    expect(reconcileWorktrees(repo, LATER)[0]?.state).toBe("merged");
  });

  it("refuses to merge into a dirty main tree, and refuses an empty branch", () => {
    const rec = createWorktree(repo, "to merge");
    commitIn(rec.path, "feature.ts");
    // A MODIFIED TRACKED file THE BRANCH ALSO CHANGES. This used to be any
    // tracked edit anywhere (2026-09-10), then any edit at all (untracked
    // included) — each stricter than git's own rule, each making
    // merge-on-close impossible on a real checkout (2026-09-11).
    commitIn(rec.path, "README.md", "the branch's README\n");
    writeFileSync(join(repo, "README.md"), "uncommitted edit\n");
    expect(mergeWorktree(repo, rec.slug).message).toContain("README.md");

    execFileSync("git", ["checkout", "--", "README.md"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["clean", "-qfd"], { cwd: repo, stdio: "pipe" });
    const empty = createWorktree(repo, "nothing here");
    expect(mergeWorktree(repo, empty.slug).message).toContain("no commits");
  });

  // Close-with-merge on a dirty tab worktree (ADR-0107). The commit that folds
  // the tab's loose work into its branch runs the project's hooks, and on a
  // real project (2026-09-10) the pre-commit band took longer than the 30 s a
  // synchronous route call allowed: `spawnSync git ETIMEDOUT`, six tabs that
  // could not close. These pin the async path, that hooks are honoured rather
  // than bypassed, and that MARVIN's own symlinks never ride along.
  const installPreCommitHook = (body: string) => {
    const dir = join(repo, ".githooks");
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, "pre-commit");
    writeFileSync(hook, `#!/bin/sh\n${body}\n`);
    chmodSync(hook, 0o755);
    git("add", ".githooks/pre-commit");
    git("commit", "-qm", "chore(hooks): add pre-commit");
    git("config", "core.hooksPath", ".githooks");
  };

  it("commits work in progress through a slow pre-commit hook — the hook gets its time, not 30 s", async () => {
    installPreCommitHook("sleep 1; exit 0");
    const rec = createSessionWorktree(repo, { sessionId: "s-slow" });
    writeFileSync(join(rec.path, "wip.ts"), "export const x = 1;\n");
    expect(worktreeHasWork(rec.path)).toBe(true);

    const out = await commitWorktreeWorkInProgress(rec.path, rec.slug);

    expect(out.ok).toBe(true);
    expect(worktreeHasWork(rec.path)).toBe(false);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: rec.path, encoding: "utf-8" }).trim()).toBe(
      `chore: work in progress from tab ${rec.slug}`,
    );
  });

  it("a hook that rejects the commit is reported with its own words, and a hook that never returns is cut off and named", async () => {
    installPreCommitHook('echo "policy: no wip commits" >&2; exit 1');
    const rec = createSessionWorktree(repo, { sessionId: "s-reject" });
    writeFileSync(join(rec.path, "wip.ts"), "x\n");

    const rejected = await commitWorktreeWorkInProgress(rec.path, rec.slug);
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("policy: no wip commits");
    expect(worktreeHasWork(rec.path)).toBe(true);

    // A relative `core.hooksPath` resolves inside the tree being committed.
    writeFileSync(join(rec.path, ".githooks", "pre-commit"), "#!/bin/sh\nsleep 30\n");
    const stuck = await commitWorktreeWorkInProgress(rec.path, rec.slug, { timeoutMs: 500 });
    expect(stuck.ok).toBe(false);
    expect(stuck.message).toMatch(/did not finish within 1 s/);
    expect(stuck.message).toContain("hook");
  });

  it("a symlink staged by an earlier failed attempt is unstaged, never committed", async () => {
    const rec = createSessionWorktree(repo, { sessionId: "s-link" });
    symlinkSync(repo, join(rec.path, "node_modules"), "dir");
    execFileSync("git", ["add", "-A"], { cwd: rec.path, stdio: "pipe" });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: rec.path, encoding: "utf-8" })).toContain("A  node_modules");

    unstageSymlinkedDirs(rec.path, ["node_modules", "apps/web/node_modules"]);

    // Untracked again — and the status line is what the exclude file (written
    // by `prepareSessionWorktree`) removes; this helper only owns the index.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: rec.path, encoding: "utf-8" })).toBe("?? node_modules\n");
  });
});

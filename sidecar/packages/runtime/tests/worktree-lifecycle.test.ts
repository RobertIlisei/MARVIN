import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bindWorktreeTask,
  createWorktree,
  listWorktrees,
  markWorktreeFinished,
  mergeWorktree,
  reconcileWorktrees,
  removeWorktree,
  sweepWorktrees,
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
    writeFileSync(join(repo, "uncommitted.txt"), "x\n");
    expect(mergeWorktree(repo, rec.slug).message).toContain("uncommitted changes");

    execFileSync("git", ["clean", "-qfd"], { cwd: repo, stdio: "pipe" });
    const empty = createWorktree(repo, "nothing here");
    expect(mergeWorktree(repo, empty.slug).message).toContain("no commits");
  });
});

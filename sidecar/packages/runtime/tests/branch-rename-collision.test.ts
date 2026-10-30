// 2026-10-30 — two tabs ended up on one branch name and a kept tab's last two
// commits went dangling. Replays that day's sequence:
//
//   1. Tab A commits; ADR-0111 names its branch after its first commit.
//   2. Tab B is cut from main and fast-forwards onto an OLDER tip of A, then
//      commits its own work. B was named after A's first commit, because a
//      fast-forward of a sibling puts the sibling's commits on B's
//      first-parent chain.
//   3. A is closed with "keep", then discarded from the app: `branch -D` on a
//      branch whose last commits no other ref held.
//   4. B's rename then took A's freed name.
//
// The invariants: a branch holding commits no other ref contains is never
// deleted without first pinning them; a tab's own commits exclude what a
// sibling tab's branch already holds.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_REF_PREFIX,
  createSessionWorktree,
  discardWorktree,
  findSessionWorktree,
  markSessionWorktreeClosed,
  nameSessionBranchFromCommit,
  SESSION_BRANCH_PREFIX,
  sessionOwnChanges,
  sweepWorktrees,
} from "../src/worktrees";

describe("tab branch rename collision (2026-10-30)", () => {
  let repo: string;
  let git: (...a: string[]) => string;
  const gitIn = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...a], { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  const commitIn = (path: string, file: string, subject: string) => {
    writeFileSync(join(path, file), `${subject}\n`);
    gitIn(path, "add", file);
    gitIn(path, "commit", "-qm", subject);
    return gitIn(path, "rev-parse", "HEAD");
  };
  /** Is `sha` reachable from any ref at all? (`git fsck` would call it dangling otherwise.) */
  const reachable = (sha: string) => git("for-each-ref", "--contains", sha, "--format=%(refname)") !== "";

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-collide-")));
    git = (...a: string[]) => gitIn(repo, ...a);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Steps 1–2: A names itself; B fast-forwards onto A's older tip and commits. */
  function replayUpToBsCommit() {
    const a = createSessionWorktree(repo, { sessionId: "tab-a", title: "supervisor" });
    commitIn(a.path, "adr.md", "docs(adr): a supervisor session");
    const aNamed = nameSessionBranchFromCommit(repo, "tab-a");
    expect(aNamed?.to).toBe(`${SESSION_BRANCH_PREFIX}docs-adr-a-supervisor-session`);
    commitIn(a.path, "m2.ts", "feat: milestone 2");
    const aOldTip = gitIn(a.path, "rev-parse", "HEAD");

    const b = createSessionWorktree(repo, { sessionId: "tab-b", title: "supervisor-m3" });
    gitIn(b.path, "merge", "-q", "--ff-only", aOldTip); // fast-forward onto A's older tip
    const aTail1 = commitIn(a.path, "m2-test.ts", "test: m2 tail");
    const aTail2 = commitIn(a.path, "scope.md", "docs: tick the box");
    commitIn(b.path, "posture.ts", "fix(supervisor): the posture api refuses widening");
    return { a, b, aTail: [aTail1, aTail2] };
  }

  it("(a) names a tab after its own first commit, never after a sibling tab's it fast-forwarded onto", () => {
    replayUpToBsCommit();
    const renamed = nameSessionBranchFromCommit(repo, "tab-b");
    expect(renamed?.to).toBe(`${SESSION_BRANCH_PREFIX}fix-supervisor-the-posture-api-refuses-w`);
  });

  it("(a) the scope-met own-changes set excludes a fast-forwarded sibling's files", () => {
    const { b } = replayUpToBsCommit();
    expect(sessionOwnChanges(findSessionWorktree(repo, "tab-b")!).files).toEqual(["posture.ts"]);
    expect(b.path).toBeTruthy();
  });

  it("(a) does not name a tab whose only commits so far are a sibling's", () => {
    const a = createSessionWorktree(repo, { sessionId: "tab-a", title: "a" });
    commitIn(a.path, "a.md", "docs: a's first");
    nameSessionBranchFromCommit(repo, "tab-a");
    const b = createSessionWorktree(repo, { sessionId: "tab-b", title: "b" });
    gitIn(b.path, "merge", "-q", "--ff-only", findSessionWorktree(repo, "tab-a")!.branch);
    expect(nameSessionBranchFromCommit(repo, "tab-b")).toBeNull();
    expect(findSessionWorktree(repo, "tab-b")?.branch).toBe(b.branch);
  });

  it("(b) close with keep, then discard: the commits only A held stay reachable, pinned under the archive", () => {
    const { a, aTail } = replayUpToBsCommit();
    const aBranch = findSessionWorktree(repo, "tab-a")!.branch;
    markSessionWorktreeClosed(repo, "tab-a"); // the supervisor's "keep"
    expect(sweepWorktrees(repo).find((s) => s.branch === aBranch)).toBeUndefined(); // ready → untouched

    const out = discardWorktree(repo, a.slug); // the app's discard, 13 minutes later
    expect(out.ok).toBe(true);
    expect(out.message).toContain(ARCHIVE_REF_PREFIX);
    for (const sha of aTail) expect(reachable(sha)).toBe(true);
    const archived = git("for-each-ref", "--format=%(refname) %(objectname)", `${ARCHIVE_REF_PREFIX}${aBranch}/`);
    expect(archived).toContain(aTail[1]);
    // Not a branch: no tab can adopt it, and the name it came from is free.
    expect(git("branch", "--list", "marvin/*", "--format=%(refname:short)")).not.toContain("archive");
  });

  it("(b) a whole replay ends with B on its own name and every commit of A still reachable", () => {
    const { a, aTail } = replayUpToBsCommit();
    const aBranch = findSessionWorktree(repo, "tab-a")!.branch;
    markSessionWorktreeClosed(repo, "tab-a");
    discardWorktree(repo, a.slug);
    const renamed = nameSessionBranchFromCommit(repo, "tab-b");
    expect(renamed?.to).not.toBe(aBranch);
    for (const sha of aTail) expect(reachable(sha)).toBe(true);
  });

  it("(b) a discard of a branch another ref already contains archives nothing", () => {
    const a = createSessionWorktree(repo, { sessionId: "tab-a", title: "a" });
    commitIn(a.path, "a.md", "docs: a");
    git("merge", "-q", "--no-edit", a.branch);
    markSessionWorktreeClosed(repo, "tab-a");
    expect(discardWorktree(repo, a.slug).message).not.toContain(ARCHIVE_REF_PREFIX);
    expect(git("for-each-ref", ARCHIVE_REF_PREFIX)).toBe("");
  });

  it("(b) the sweep pins a squash-merged branch's commits before deleting it", () => {
    const a = createSessionWorktree(repo, { sessionId: "tab-a", title: "a" });
    const tip = commitIn(a.path, "a.md", "docs: a");
    git("merge", "-q", "--squash", a.branch);
    git("commit", "-qm", "squash a");
    markSessionWorktreeClosed(repo, "tab-a");
    const swept = sweepWorktrees(repo);
    expect(swept.find((s) => s.branch === a.branch)).toMatchObject({ state: "merged", deletedBranch: true });
    expect(reachable(tip)).toBe(true);
  });

  it("never renames onto a name an existing ref holds", () => {
    const a = createSessionWorktree(repo, { sessionId: "tab-a", title: "a" });
    git("branch", `${SESSION_BRANCH_PREFIX}docs-same-subject`); // the user's own branch, same name
    commitIn(a.path, "a.md", "docs: same subject");
    expect(nameSessionBranchFromCommit(repo, "tab-a")?.to).toBe(`${SESSION_BRANCH_PREFIX}docs-same-subject-2`);
  });
});

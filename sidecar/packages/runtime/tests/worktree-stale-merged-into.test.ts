// 2026-11-26 — a tab's branch (`marvin/tab/rel-tests-c-last-six`) held two
// unmerged commits and was deleted by the sweep that ran when an UNRELATED tab
// closed. `mergedInto` is derived from git, but `reconcileOne` rebuilt each
// record as `{ ...record, … }` and `mergeDerived` saved the result, so a value
// recorded while the branch sat on another ref's tip (a fast-forward, seconds
// before its first own commit) survived every later reconcile that no longer
// re-derived it. An adopted, unbound `marvin/tab/*` record with a stale
// `mergedInto` is what `sweepReconciled` calls proven-merged (ADR-0103).
// These pin the timeline, the delete-time re-check, and the no-regression case.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionWorktreeInfo } from "../src/session-watch";
import { listWorktrees, reconcileWorktrees, sweepReconciled, sweepWorktreesAsync } from "../src/worktrees";

describe("a stored mergedInto never outlives the derivation", () => {
  let repo: string;
  let dataDir: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-stale-")));
    dataDir = mkdtempSync(join(tmpdir(), "marvin-stale-data-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    // Another tab's branch, one commit ahead of main.
    git("checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "other.txt"), "o\n");
    git("add", ".");
    git("commit", "-qm", "other work");
    git("checkout", "-q", "main");
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const BRANCH = "marvin/tab/rel-tests-c-last-six";
  const branchExists = (b: string) => git("branch", "--list", b) !== "";
  const inWt = (path: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...a], { cwd: path, encoding: "utf-8", stdio: "pipe" }).trim();

  /** A tab's checkout on a `marvin/tab/*` branch the registry does not know,
   *  fast-forwarded to `other`'s tip — the window the incident opened. */
  function lostTabOnOthersTip(): string {
    const path = join(repo, ".marvin", "worktrees", "tab-rel-tests-c-last-six");
    mkdirSync(join(repo, ".marvin", "worktrees"), { recursive: true });
    git("worktree", "add", "-q", "-b", BRANCH, path, "main");
    inWt(path, "reset", "-q", "--hard", "other");
    return path;
  }

  it("the incident: ff to another ref, reconcile, own commit, switch away, unrelated close — the branch survives", async () => {
    const path = lostTabOnOthersTip();

    // Reconcile in the window: adopted unbound, and genuinely contained in `other`.
    const first = reconcileWorktrees(repo).find((w) => w.branch === BRANCH);
    expect(first).toMatchObject({ kind: "session", mergedInto: "other" });
    expect(first?.sessionId).toBeUndefined();
    expect(listWorktrees(repo).find((w) => w.branch === BRANCH)?.mergedInto).toBe("other");

    // The tab's first own commit, then it moves its checkout to another branch.
    writeFileSync(join(path, "work.txt"), "real work\n");
    inWt(path, "add", "work.txt");
    inWt(path, "commit", "-qm", "the tab's own commit");
    inWt(path, "switch", "-q", "other");

    // Some other tab closes and the project is swept.
    const out = await sweepWorktreesAsync(repo);

    expect(out.find((o) => o.branch === BRANCH)?.deletedBranch ?? false).toBe(false);
    expect(branchExists(BRANCH)).toBe(true);
    const rec = reconcileWorktrees(repo).find((w) => w.branch === BRANCH);
    expect(rec?.mergedInto).toBeUndefined();
    expect(rec?.state).not.toBe("merged");
    expect(listWorktrees(repo).find((w) => w.branch === BRANCH)?.mergedInto).toBeUndefined();
  });

  it("a record's saved mergedInto is dropped by a reconcile that does not re-derive it", () => {
    lostTabOnOthersTip();
    reconcileWorktrees(repo);
    // `other` goes away: nothing contains the branch any more, and its commit
    // is not a merge into anything either (main lacks it).
    git("branch", "-q", "-D", "other");
    const w = reconcileWorktrees(repo).find((r) => r.branch === BRANCH);
    expect(w?.mergedInto).toBeUndefined();
    expect(listWorktrees(repo).find((r) => r.branch === BRANCH)?.mergedInto).toBeUndefined();
  });

  it("the watch row of a tab carries no stale mergedInto", async () => {
    lostTabOnOthersTip();
    reconcileWorktrees(repo);
    const stored = JSON.parse(readFileSync(join(repo, ".marvin", "worktrees.json"), "utf-8")) as { worktrees: Array<Record<string, unknown>> };
    // Bind the adopted record to a session, as a live tab's record would be.
    stored.worktrees = stored.worktrees.map((w) => (w.branch === BRANCH ? { ...w, sessionId: "s-tab" } : w));
    writeFileSync(join(repo, ".marvin", "worktrees.json"), JSON.stringify(stored));
    const path = join(repo, ".marvin", "worktrees", "tab-rel-tests-c-last-six");
    writeFileSync(join(path, "work.txt"), "real work\n");
    inWt(path, "add", "work.txt");
    inWt(path, "commit", "-qm", "the tab's own commit");

    const row = await sessionWorktreeInfo(repo, "s-tab", Date.now(), true);
    expect(row).not.toBeNull();
    expect(row?.mergedInto).toBeUndefined();
    const cached = await sessionWorktreeInfo(repo, "s-tab", Date.now() + 60_000);
    expect(cached?.mergedInto).toBeUndefined();
  });

  it("an adopted, unbound tab branch with commits no other ref holds is ready/session and never swept", async () => {
    const path = join(repo, ".marvin", "worktrees", "tab-rel-tests-c-last-six");
    mkdirSync(join(repo, ".marvin", "worktrees"), { recursive: true });
    git("worktree", "add", "-q", "-b", BRANCH, path, "main");
    writeFileSync(join(path, "work.txt"), "real work\n");
    inWt(path, "add", "work.txt");
    inWt(path, "commit", "-qm", "own work");
    inWt(path, "switch", "-q", "other");
    const w = reconcileWorktrees(repo).find((r) => r.branch === BRANCH);
    expect(w?.mergedInto).toBeUndefined();
    expect(w?.commits).toBe(1);
    await sweepWorktreesAsync(repo);
    expect(branchExists(BRANCH)).toBe(true);
  });

  it("a truly merged unbound tab branch is still swept", async () => {
    const path = lostTabOnOthersTip();
    // The tab's tree moves on; the branch stays fully contained in `other`.
    inWt(path, "switch", "-q", "other");
    const out = await sweepWorktreesAsync(repo);
    expect(out.find((o) => o.branch === BRANCH)).toMatchObject({ state: "merged", deletedBranch: true });
    expect(branchExists(BRANCH)).toBe(false);
  });

  it("the delete re-checks from git: a stale `merged` snapshot is refused, logged, and nothing is removed", () => {
    const path = lostTabOnOthersTip();
    const [snapshot] = reconcileWorktrees(repo).filter((w) => w.branch === BRANCH);
    expect(snapshot?.mergedInto).toBe("other");
    // The world moves on after the snapshot was taken: an own commit.
    writeFileSync(join(path, "work.txt"), "real work\n");
    inWt(path, "add", "work.txt");
    inWt(path, "commit", "-qm", "own commit");
    inWt(path, "switch", "-q", "other");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stale = { ...(snapshot as NonNullable<typeof snapshot>), state: "merged" as const, kind: undefined, mergedInto: "other", dirty: false, checkoutPresent: true };
    const out = sweepReconciled(repo, [stale], {});

    expect(branchExists(BRANCH)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(out.find((o) => o.branch === BRANCH)).toMatchObject({ deletedBranch: false, removedCheckout: false });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("worktree.sweep.refused"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(BRANCH);
    expect(lines[0]).toMatch(/reason/);
  });
});

// The registry is read-modify-written by an ASYNC reconcile: it reads
// `worktrees.json` once, yields to the event loop for every git call, then
// writes. A tab created in that window was overwritten, and the next reconcile
// adopted its branch as an orphan — `kind: session`, no `sessionId` — so the
// tab's close found no record and reported "closed" without merging
// (2026-10-31, tab d3546ff1 "tool-badge-colours").
//
// `runAsync` runs the generator's first step synchronously, so starting the
// reconcile, creating a tab, then awaiting interleaves the two writers
// deterministically.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSessionWorktree,
  findSessionWorktree,
  listWorktrees,
  markSessionWorktreeClosed,
  nameSessionBranchFromCommit,
  reconcileWorktreesAsync,
} from "../src/worktrees";

describe("registry writers under an in-flight async reconcile", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-wtrace-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("a tab created while a reconcile is in flight keeps its sessionId", async () => {
    createSessionWorktree(repo, { sessionId: "first", title: "first" });
    const inFlight = reconcileWorktreesAsync(repo);
    const rec = createSessionWorktree(repo, { sessionId: "second", title: "tool-badge-colours" });
    await inFlight;
    expect(findSessionWorktree(repo, "second")?.slug).toBe(rec.slug);
    // And a later reconcile does not turn it into an unbound adoption.
    await reconcileWorktreesAsync(repo);
    const stored = listWorktrees(repo).filter((w) => w.branch === rec.branch);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.sessionId).toBe("second");
    expect(stored[0]?.task).toBe("tool-badge-colours");
  });

  it("a close written while a reconcile is in flight is not undone", async () => {
    createSessionWorktree(repo, { sessionId: "s1", title: "one" });
    // Strip the cached state so the in-flight reconcile has something to write.
    const registry = join(repo, ".marvin", "worktrees.json");
    writeFileSync(registry, JSON.stringify({ worktrees: listWorktrees(repo).map(({ state: _s, ...w }) => w) }));
    const inFlight = reconcileWorktreesAsync(repo);
    markSessionWorktreeClosed(repo, "s1");
    await inFlight;
    expect(findSessionWorktree(repo, "s1")?.finishedAt).toBeTruthy();
  });

  it("a reconcile keeps fields it does not derive (`named`)", async () => {
    const rec = createSessionWorktree(repo, { sessionId: "s1", title: "one" });
    writeFileSync(join(rec.path, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: rec.path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "Add the a file"], { cwd: rec.path, stdio: "pipe" });
    expect(nameSessionBranchFromCommit(repo, "s1")).not.toBeNull();
    await reconcileWorktreesAsync(repo);
    expect(findSessionWorktree(repo, "s1")?.named).toBe(true);
  });
});

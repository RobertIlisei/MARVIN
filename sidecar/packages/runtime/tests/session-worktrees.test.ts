// ADR-0107 — a chat tab's own worktree. Pins the lifecycle rules that differ
// from an implementer's (ADR-0103): `session` while the tab is open and
// NEVER swept in that state; ready / empty / merged by derivation once
// closed; discard only after close; a lost session branch is adopted as an
// open tab, not as a spent orphan; every pre-0107 registry record still
// reconciles as it did.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSessionWorktree,
  createWorktree,
  discardWorktree,
  findSessionWorktree,
  listWorktrees,
  markSessionWorktreeClosed,
  mergeWorktree,
  reconcileWorktrees,
  removeWorktree,
  reopenSessionWorktree,
  SESSION_BRANCH_PREFIX,
  sweepWorktrees,
} from "../src/worktrees";

const LATER = Date.now() + 48 * 3_600_000;

describe("session worktrees", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-swt-")));
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

  const commitIn = (path: string, file: string, body = "x\n") => {
    writeFileSync(join(path, file), body);
    execFileSync("git", ["add", file], { cwd: path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", `add ${file}`], { cwd: path, stdio: "pipe" });
  };

  it("is cut from HEAD with its own prefixes and a session-bound record", () => {
    const rec = createSessionWorktree(repo, { sessionId: "abcdef12-0000", title: "Fix the widget" });
    expect(rec.kind).toBe("session");
    expect(rec.sessionId).toBe("abcdef12-0000");
    expect(rec.branch).toBe(`${SESSION_BRANCH_PREFIX}fix-the-widget`);
    expect(rec.path).toBe(join(repo, ".marvin", "worktrees", "tab-fix-the-widget"));
    expect(rec.base).toBe(git("rev-parse", "HEAD"));
    expect(existsSync(join(rec.path, "README.md"))).toBe(true);
    // Idempotent per session.
    expect(createSessionWorktree(repo, { sessionId: "abcdef12-0000" }).slug).toBe(rec.slug);
    expect(findSessionWorktree(repo, "abcdef12-0000")?.slug).toBe(rec.slug);
  });

  it("stays `session` while open — even 48 h later, even with commits — and is never swept", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s1" });
    commitIn(rec.path, "a.txt");
    const [w] = reconcileWorktrees(repo, LATER);
    expect(w?.state).toBe("session");
    expect(w?.commits).toBe(1);
    expect(sweepWorktrees(repo, LATER)).toEqual([]);
    expect(existsSync(rec.path)).toBe(true);
    expect(removeWorktree(repo, rec.slug).refused).toMatch(/open chat tab/);
  });

  it("closed → ready with commits, empty without; empty is swept, ready never", () => {
    const withWork = createSessionWorktree(repo, { sessionId: "s-work" });
    const noWork = createSessionWorktree(repo, { sessionId: "s-none" });
    commitIn(withWork.path, "b.txt");
    markSessionWorktreeClosed(repo, "s-work");
    markSessionWorktreeClosed(repo, "s-none");
    const states = Object.fromEntries(reconcileWorktrees(repo).map((w) => [w.sessionId, w.state]));
    expect(states).toEqual({ "s-work": "ready", "s-none": "empty" });
    const swept = sweepWorktrees(repo);
    expect(swept.map((s) => s.branch)).toEqual([noWork.branch]);
    expect(existsSync(withWork.path)).toBe(true);
    // Reopen brings a kept tree back to `session`.
    reopenSessionWorktree(repo, "s-work");
    expect(reconcileWorktrees(repo).find((w) => w.sessionId === "s-work")?.state).toBe("session");
  });

  it("merge folds a closed tab's branch into the main tree and derives `merged`", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s-merge" });
    commitIn(rec.path, "c.txt");
    markSessionWorktreeClosed(repo, "s-merge");
    const out = mergeWorktree(repo, rec.slug);
    expect(out.ok).toBe(true);
    expect(existsSync(join(repo, "c.txt"))).toBe(true);
    expect(reconcileWorktrees(repo).find((w) => w.slug === rec.slug)?.state).toBe("merged");
  });

  it("merge of an OPEN tab is refused only while that tab has a turn in flight", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s-live" });
    commitIn(rec.path, "d.txt");
    expect(mergeWorktree(repo, rec.slug, { isSessionBusy: () => true }).ok).toBe(false);
    expect(mergeWorktree(repo, rec.slug, { isSessionBusy: () => false }).ok).toBe(true);
  });

  it("discard removes checkout and branch, but only after the tab closed", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s-discard" });
    commitIn(rec.path, "e.txt");
    expect(discardWorktree(repo, rec.slug).ok).toBe(false);
    markSessionWorktreeClosed(repo, "s-discard");
    expect(discardWorktree(repo, rec.slug).ok).toBe(true);
    expect(existsSync(rec.path)).toBe(false);
    expect(() => git("rev-parse", "--verify", "--quiet", rec.branch)).toThrow();
    expect(listWorktrees(repo).find((w) => w.slug === rec.slug)).toBeUndefined();
    // An implementer tree is never discardable through this path.
    const impl = createWorktree(repo, "impl");
    expect(discardWorktree(repo, impl.slug).ok).toBe(false);
  });

  it("a session branch the registry lost is adopted as an open tab and never swept", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s-lost" });
    commitIn(rec.path, "f.txt");
    // Lose the registry.
    rmSync(join(repo, ".marvin", "worktrees.json"));
    const adopted = reconcileWorktrees(repo, LATER).find((w) => w.branch === rec.branch);
    expect(adopted?.kind).toBe("session");
    expect(adopted?.state).toBe("session");
    expect(adopted?.path).toBe(rec.path);
    expect(sweepWorktrees(repo, LATER)).toEqual([]);
  });

  it("pre-0107 implementer records reconcile exactly as before", () => {
    const impl = createWorktree(repo, "old style");
    expect(impl.kind).toBeUndefined();
    expect(reconcileWorktrees(repo, LATER).find((w) => w.slug === impl.slug)?.state).toBe("empty");
    expect(sweepWorktrees(repo, LATER).map((s) => s.branch)).toEqual([impl.branch]);
  });
});

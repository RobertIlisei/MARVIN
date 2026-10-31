// A tab whose registry binding was lost (2026-10-31, tab d3546ff1): its meta
// said `tree.mode: "worktree"`, its registry record had been adopted with no
// `sessionId`, and `POST /api/sessions/close {worktree: "merge"}` answered
// `200 closed` having merged nothing. Close now re-binds from the meta and
// carries the action out, or refuses with a 409 — never "closed" for a merge
// or a discard that did not happen.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slugifyWorkDir } from "../src/projects";
import { closeSession } from "../src/session-close";
import { readSessionMeta, type SessionMeta, writeSessionMeta } from "../src/session-meta";
import { createSessionWorktree, findSessionWorktree, listWorktrees, reconcileWorktrees, sweepWorktreesAsync, type WorktreeRecord } from "../src/worktrees";


describe("closeSession — a lost registry binding", () => {
  let repo: string;
  let dataDir: string;
  let git: (...a: string[]) => string;
  // Production derives a project's id from its workDir (projects.ts), and the
  // sweep finds a project's session metas the same way.
  let PROJECT: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-close-")));
    PROJECT = slugifyWorkDir(repo);
    dataDir = mkdtempSync(join(tmpdir(), "marvin-close-data-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A tab with one commit in its tree and a meta pointing at it. */
  function tabWithWork(sessionId: string): WorktreeRecord {
    const rec = createSessionWorktree(repo, { sessionId, title: "tool-badge-colours" });
    writeFileSync(join(rec.path, "badge.txt"), "teal\n");
    execFileSync("git", ["add", "badge.txt"], { cwd: rec.path, stdio: "pipe" });
    execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "tint the badges"], { cwd: rec.path, stdio: "pipe" });
    const meta: SessionMeta = {
      version: 1,
      marvinSessionId: sessionId,
      projectId: PROJECT,
      workDir: repo,
      createdAt: "2026-10-31T18:42:04.475Z",
      updatedAt: "2026-10-31T18:42:04.475Z",
      tree: { mode: "worktree", slug: rec.slug, path: rec.path, branch: rec.branch, base: rec.base, ...(rec.baseRef ? { baseRef: rec.baseRef } : {}) },
      posture: { model: "m", advisorModel: null, personality: "ultron", permissionStrategy: "auto", thinkingMode: "high" },
    };
    expect(writeSessionMeta(meta)).toEqual({ ok: true });
    return rec;
  }

  /** What the race left on disk: the record gone, then adopted unbound. */
  function loseBinding(rec: WorktreeRecord): void {
    writeFileSync(join(repo, ".marvin", "worktrees.json"), JSON.stringify({ worktrees: listWorktrees(repo).filter((w) => w.slug !== rec.slug) }));
    reconcileWorktrees(repo);
    const adopted = listWorktrees(repo).find((w) => w.branch === rec.branch);
    expect(adopted?.kind).toBe("session");
    expect(adopted?.sessionId).toBeUndefined();
  }

  it("merge on an adopted, unbound record re-binds from the meta and merges", async () => {
    const rec = tabWithWork("d3546ff1");
    loseBinding(rec);
    const out = await closeSession({ projectId: PROJECT, workDir: repo, sessionId: "d3546ff1", action: "merge" });
    expect(out.status).toBe(200);
    expect(out.body.worktree).toMatchObject({ branch: rec.branch, action: "merge" });
    expect(existsSync(join(repo, "badge.txt"))).toBe(true);
    expect(findSessionWorktree(repo, "d3546ff1")?.finishedAt).toBeTruthy();
    expect(readSessionMeta(PROJECT, "d3546ff1")?.closedAt).toBeTruthy();
  });

  it("merge with no record at all recovers one from the meta while the branch exists", async () => {
    const rec = tabWithWork("s-norecord");
    writeFileSync(join(repo, ".marvin", "worktrees.json"), JSON.stringify({ worktrees: [] }));
    const out = await closeSession({ projectId: PROJECT, workDir: repo, sessionId: "s-norecord", action: "merge" });
    expect(out.status).toBe(200);
    expect(existsSync(join(repo, "badge.txt"))).toBe(true);
    expect(findSessionWorktree(repo, "s-norecord")?.branch).toBe(rec.branch);
  });

  it("merge or discard that cannot be recovered is a 409, and the tab stays open", async () => {
    const rec = tabWithWork("s-gone");
    writeFileSync(join(repo, ".marvin", "worktrees.json"), JSON.stringify({ worktrees: [] }));
    git("worktree", "remove", "--force", rec.path);
    git("branch", "-D", rec.branch);
    for (const action of ["merge", "discard"] as const) {
      const out = await closeSession({ projectId: PROJECT, workDir: repo, sessionId: "s-gone", action });
      expect(out.status).toBe(409);
      expect(out.body.code).toBe("worktree-lost");
      expect(out.body.ok).toBeUndefined();
    }
    expect(readSessionMeta(PROJECT, "s-gone")?.closedAt).toBeUndefined();
  });

  describe("the orphan an unbound adoption leaves", () => {
    const closeMeta = (id: string) => {
      const m = readSessionMeta(PROJECT, id) as SessionMeta;
      expect(writeSessionMeta({ ...m, closedAt: "2026-10-31T18:46:32.952Z" })).toEqual({ ok: true });
    };
    const branchExists = (b: string) => git("branch", "--list", b) !== "";

    it("is reclaimed by the sweep once its branch is merged and no open tab claims it", async () => {
      const rec = tabWithWork("orphan-merged");
      loseBinding(rec);
      git("merge", "-q", "--no-ff", "-m", "merged by hand", rec.branch);
      closeMeta("orphan-merged");
      const out = await sweepWorktreesAsync(repo);
      expect(out.find((o) => o.branch === rec.branch)).toMatchObject({ state: "merged", deletedBranch: true });
      expect(branchExists(rec.branch)).toBe(false);
      expect(existsSync(rec.path)).toBe(false);
      expect(listWorktrees(repo).some((w) => w.branch === rec.branch)).toBe(false);
      // Not re-adopted on the next read.
      reconcileWorktrees(repo);
      expect(listWorktrees(repo).some((w) => w.branch === rec.branch)).toBe(false);
    });

    it("is kept while an open session's meta claims its checkout", async () => {
      const rec = tabWithWork("orphan-open");
      loseBinding(rec);
      git("merge", "-q", "--no-ff", "-m", "merged by hand", rec.branch);
      await sweepWorktreesAsync(repo);
      expect(branchExists(rec.branch)).toBe(true);
      expect(existsSync(rec.path)).toBe(true);
    });

    it("is never reclaimed while its branch holds unmerged work, or holds none", async () => {
      const withWork = tabWithWork("orphan-unmerged");
      loseBinding(withWork);
      closeMeta("orphan-unmerged");
      const empty = createSessionWorktree(repo, { sessionId: "orphan-empty", title: "empty tab" });
      writeFileSync(join(repo, ".marvin", "worktrees.json"), JSON.stringify({ worktrees: listWorktrees(repo).filter((w) => w.slug !== empty.slug) }));
      reconcileWorktrees(repo);
      await sweepWorktreesAsync(repo);
      expect(branchExists(withWork.branch)).toBe(true);
      expect(existsSync(withWork.path)).toBe(true);
      expect(branchExists(empty.branch)).toBe(true);
      expect(existsSync(empty.path)).toBe(true);
    });
  });

  it("never takes a record bound to another session", async () => {
    const rec = tabWithWork("s-mine");
    // The registry binds this tree to someone else; the meta of `s-other` claims it.
    const meta = readSessionMeta(PROJECT, "s-mine") as SessionMeta;
    expect(writeSessionMeta({ ...meta, marvinSessionId: "s-other" })).toEqual({ ok: true });
    const out = await closeSession({ projectId: PROJECT, workDir: repo, sessionId: "s-other", action: "merge" });
    expect(out.status).toBe(409);
    expect(existsSync(join(repo, "badge.txt"))).toBe(false);
    expect(findSessionWorktree(repo, "s-mine")?.branch).toBe(rec.branch);
  });
});

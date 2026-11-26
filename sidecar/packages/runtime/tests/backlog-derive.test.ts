import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addBacklogItem,
  archiveCounts,
  getBacklogItem,
  listBacklog,
  resetBacklogLayoutCacheForTests,
  resolveBacklogItem,
  setBacklogStatus,
} from "../src/backlog";
import { deriveBacklogFromGit, integrationBranch, parseTrailerLog, resetBacklogDeriveForTests } from "../src/backlog-derive";

// ADR-0044 addendum (2026-11-27) — an item is done when a commit carrying
// `Backlog: <slug>` is reachable from the integration branch. Real git repos in
// temp directories; nothing here touches a real project.

let repo: string;

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  }).trim();
}

let n = 0;
/** One commit with a message; each touches its own file so branches merge without conflict. */
async function commit(message: string, env: Record<string, string> = {}): Promise<string> {
  n += 1;
  await writeFile(join(repo, `f${n}.txt`), `${n}\n`);
  git(["add", "-A"]);
  git(["commit", "-m", message], env);
  return git(["rev-parse", "HEAD"]);
}

async function park(title: string): Promise<string> {
  const r = await addBacklogItem(repo, { title });
  if (!r.ok) throw new Error(r.error);
  return r.item.id;
}

const derive = () => deriveBacklogFromGit(repo, { force: true });

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "marvin-derive-"));
  resetBacklogLayoutCacheForTests();
  resetBacklogDeriveForTests();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, ".gitignore"), ".marvin/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-qm", "init"]);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("derived done", () => {
  it("a commit with the trailer on the integration branch closes the item, with the sha as evidence", async () => {
    const id = await park("Fix the flaky retention test");
    const sha = await commit(`fix: the retention test\n\nBody.\n\nBacklog: ${id}`);
    const report = await derive();
    expect(report.branch).toBe("main");
    expect(report.resolved).toEqual([{ id, sha, subject: "fix: the retention test" }]);
    const item = await getBacklogItem(repo, id);
    expect(item).toMatchObject({ status: "done", resolvedBy: "derived", evidence: sha });
    expect(item?.body).toContain(sha.slice(0, 12));
    expect(existsSync(join(repo, ".marvin", "backlog", "archive", `${id}.md`))).toBe(true);
    expect(await listBacklog(repo)).toEqual([]);
    expect(await archiveCounts(repo)).toEqual({ done: 1, dismissed: 0 });
  });

  it("a fix that lands on a side branch first counts only when the branch reaches the integration branch by a merge", async () => {
    const id = await park("Close the release branch gap");
    git(["checkout", "-q", "-b", "release/v3.2"]);
    const fix = await commit(`fix: the gap\n\nBacklog: ${id}`);
    git(["checkout", "-q", "main"]);
    await commit("feat: unrelated work on main");

    const before = await derive();
    expect(before.resolved).toEqual([]); // on a branch main has not merged
    expect((await getBacklogItem(repo, id))?.status).toBe("open");

    git(["merge", "-q", "--no-ff", "-m", "merge: release/v3.2", "release/v3.2"]);
    const after = await derive();
    expect(after.resolved.map((r) => r.id)).toEqual([id]);
    expect((await getBacklogItem(repo, id))?.evidence).toBe(fix); // the fix commit, not the merge commit
  });

  it("several trailers on one commit close several items; a comma list works too", async () => {
    const a = await park("First of three");
    const b = await park("Second of three");
    const c = await park("Third of three");
    await commit(`fix: two at once\n\nBacklog: ${a}\nBacklog: ${b}`);
    await commit(`fix: one more\n\nBacklog: ${c}, no-such-item`);
    const report = await derive();
    expect(report.resolved.map((r) => r.id).sort()).toEqual([a, b, c].sort());
    expect(await listBacklog(repo)).toEqual([]);
  });

  it("a slug that names no item is reported and never created", async () => {
    await commit("fix: typo in the trailer\n\nBacklog: fix-teh-thing");
    const report = await derive();
    expect(report.unknown).toEqual(["fix-teh-thing"]);
    expect(await getBacklogItem(repo, "fix-teh-thing")).toBeNull();
    expect(existsSync(join(repo, ".marvin", "backlog", "fix-teh-thing.md"))).toBe(false);
  });

  it("an item that is already done or dismissed is not touched", async () => {
    const done = await park("Already done by a person");
    const dismissed = await park("Already dismissed by a person");
    await resolveBacklogItem(repo, { id: done, resolution: "done", note: "by hand" });
    await resolveBacklogItem(repo, { id: dismissed, resolution: "dismissed" });
    await commit(`fix: later\n\nBacklog: ${done}\nBacklog: ${dismissed}`);
    const report = await derive();
    expect(report.resolved).toEqual([]);
    expect(report.unknown).toEqual([]); // archived items are known
    expect(await getBacklogItem(repo, done)).toMatchObject({ status: "done", resolvedBy: "", evidence: "" });
    expect((await getBacklogItem(repo, dismissed))?.status).toBe("dismissed");
  });

  it("a provisional item waits for the person's keep or dismiss", async () => {
    const r = await addBacklogItem(repo, { title: "Captured in flight", provisional: true });
    if (!r.ok) throw new Error(r.error);
    await commit(`fix: it\n\nBacklog: ${r.item.id}`);
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, r.item.id))?.status).toBe("provisional");
  });

  it("a commit older than the item does not close it (a re-filed title is not already fixed)", async () => {
    await commit("fix: long ago\n\nBacklog: filed-after-its-fix", { GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z", GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z" });
    const id = await park("Filed after its fix");
    expect(id).toBe("filed-after-its-fix");
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
  });

  it("a reopened item is not closed again by the commit that closed it", async () => {
    const id = await park("Reopened by hand");
    await commit(`fix: first try\n\nBacklog: ${id}`);
    expect((await derive()).resolved).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100)); // commit dates are whole seconds
    const reopened = await setBacklogStatus(repo, id, "open");
    expect(reopened.ok && reopened.item).toMatchObject({ status: "open", resolvedBy: "", evidence: "" });
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
    // …but a NEW fix after the reopen closes it.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await commit(`fix: second try\n\nBacklog: ${id}`);
    expect((await derive()).resolved).toEqual([{ id, sha: second, subject: "fix: second try" }]);
  });

  it("a revert does not reopen a derived done: it stays done, and the revert is its own piece of work", async () => {
    const id = await park("Fixed then reverted");
    const fix = await commit(`fix: it\n\nBacklog: ${id}`);
    await derive();
    git(["revert", "--no-edit", fix]);
    const report = await derive();
    expect(report.resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("done");
  });

  it("only a real trailer counts, not the words in a paragraph", async () => {
    const id = await park("Mentioned in prose");
    await commit(`fix: something\n\nI looked at Backlog: ${id} and moved on.\nBacklog: ${id} is mentioned here too.\n\nSigned-off-by: t`);
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
  });

  it("the cache: an unchanged tip reads no history, and a moved tip scans only what is new", async () => {
    const a = await park("First fix");
    await commit(`fix: a\n\nBacklog: ${a}`);
    const first = await derive();
    expect(first.cached).toBe(false);
    expect(first.resolved).toHaveLength(1);
    const same = await derive();
    expect(same.cached).toBe(true);
    const b = await park("Second fix");
    await commit(`fix: b\n\nBacklog: ${b}`);
    const next = await derive();
    expect(next.cached).toBe(false);
    expect(next.resolved.map((r) => r.id)).toEqual([b]);
    expect(next.trailerCommits).toBe(2); // the first commit stayed in the cache
  });

  it("inside the TTL a burst of calls shares one answer and still checks newly filed items against it", async () => {
    const early = await park("Filed before the fix");
    await commit(`fix: both\n\nBacklog: ${early}\nBacklog: filed-just-now`);
    const first = await deriveBacklogFromGit(repo); // not forced: starts the window
    expect(first.resolved.map((r) => r.id)).toEqual([early]);
    await new Promise((r) => setTimeout(r, 1100));
    await park("Filed just now");
    const second = await deriveBacklogFromGit(repo); // inside the window: no git, same cache
    expect(second.cached).toBe(true);
    expect(second.resolved).toEqual([]); // the commit predates the item
  });

  it("derives nothing, and says why, outside a repository or on a detached HEAD", async () => {
    const plain = await mkdtemp(join(tmpdir(), "marvin-derive-plain-"));
    try {
      await addBacklogItem(plain, { title: "No repo here" });
      const r = await deriveBacklogFromGit(plain, { force: true });
      expect(r.branch).toBeNull();
      expect(r.skipped).toMatch(/not a git repository|detached/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
    const head = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "--detach", head]);
    expect(await integrationBranch(repo)).toBeNull();
    expect((await derive()).skipped).toMatch(/detached/);
  });

  it("the resolution is persisted: the next read finds the item done without git", async () => {
    const id = await park("Persisted once");
    await commit(`fix: it\n\nBacklog: ${id}`);
    await derive();
    resetBacklogDeriveForTests();
    git(["checkout", "-q", "--detach"]); // git is no longer a source
    expect((await getBacklogItem(repo, id))?.status).toBe("done");
    expect(await readFile(join(repo, ".marvin", "backlog", "archive", `${id}.md`), "utf-8")).toMatch(/^resolvedBy: derived$/m);
  });
});

describe("parseTrailerLog", () => {
  it("reads sha, date, subject and every slug, in either separator, lowercased", () => {
    const out = `abc1234\0${"2026-11-27T10:00:00+02:00"}\0fix: x\0Alpha-One, beta-two\ngamma\n\x1e\n` + `def5678\0${"2026-11-26T10:00:00+02:00"}\0docs: y\0\n\x1e`;
    const { bySlug, commits } = parseTrailerLog(out);
    expect([...bySlug.keys()].sort()).toEqual(["alpha-one", "beta-two", "gamma"]);
    expect(commits).toBe(1);
    expect(bySlug.get("gamma")?.[0]).toMatchObject({ sha: "abc1234", subject: "fix: x" });
  });
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addBacklogItem, claimBacklogItem, closedCounts, getBacklogItem, listBacklog, resolveBacklogItem, setBacklogStatus } from "../src/backlog";
import { deriveBacklogFromGit, integrationBranch, parseSlugList, parseTrailerLog, resetBacklogDeriveForTests } from "../src/backlog-derive";
import { slugifyWorkDir } from "../src/projects";
import { upsertSessionMeta } from "../src/session-meta";

// ADR-0044 addendum (2026-11-27) — an item is done when a commit carrying
// `Fixes-Backlog: <slug>` is reachable from the integration branch. Real git repos in
// temp directories; nothing here touches a real project.

let repo: string;
let dataDir: string;
const prevData = process.env.MARVIN_DATA_DIR;

const posture = { model: "claude-sonnet-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
/** A tab's session meta: open until `closedAt` is set. */
function tab(sessionId: string, patch: { closedAt?: string } = {}): void {
  upsertSessionMeta(slugifyWorkDir(repo), sessionId, { workDir: repo, tree: { mode: "shared" }, posture }, patch);
}

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
  dataDir = await mkdtemp(join(tmpdir(), "marvin-derive-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetBacklogDeriveForTests();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, ".gitignore"), ".marvin/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-qm", "init"]);
});
afterEach(async () => {
  if (prevData === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prevData;
  await rm(dataDir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("derived done", () => {
  it("a commit with the trailer on the integration branch closes the item, with the sha as evidence", async () => {
    const id = await park("Fix the flaky retention test");
    const sha = await commit(`fix: the retention test\n\nBody.\n\nFixes-Backlog: ${id}`);
    const report = await derive();
    expect(report.branch).toBe("main");
    expect(report.resolved).toEqual([{ id, sha, subject: "fix: the retention test" }]);
    const item = await getBacklogItem(repo, id);
    expect(item).toMatchObject({ status: "done", resolvedBy: "derived", evidence: sha });
    expect(item?.body).toContain(sha.slice(0, 12));
    expect(existsSync(join(repo, ".marvin", "backlog", `${id}.md`))).toBe(true); // the file stays where it is
    expect(await listBacklog(repo)).toEqual([]);
    expect(await closedCounts(repo)).toEqual({ done: 1, dismissed: 0 });
  });

  it("a fix that lands on a side branch first counts only when the branch reaches the integration branch by a merge", async () => {
    const id = await park("Close the release branch gap");
    git(["checkout", "-q", "-b", "release/v3.2"]);
    const fix = await commit(`fix: the gap\n\nFixes-Backlog: ${id}`);
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
    await commit(`fix: two at once\n\nFixes-Backlog: ${a}\nFixes-Backlog: ${b}`);
    await commit(`fix: one more\n\nBacklog: ignored reference\nFixes-Backlog: ${c}`);
    const report = await derive();
    expect(report.resolved.map((r) => r.id).sort()).toEqual([a, b, c].sort());
    expect(await listBacklog(repo)).toEqual([]);
  });

  it("a slug that names no item is reported and never created", async () => {
    await commit("fix: typo in the trailer\n\nFixes-Backlog: fix-teh-thing");
    const report = await derive();
    expect(report.ignored.map((i) => i.value)).toEqual(["fix-teh-thing"]);
    expect(await getBacklogItem(repo, "fix-teh-thing")).toBeNull();
    expect(existsSync(join(repo, ".marvin", "backlog", "fix-teh-thing.md"))).toBe(false);
  });

  it("an item that is already done or dismissed is not touched", async () => {
    const done = await park("Already done by a person");
    const dismissed = await park("Already dismissed by a person");
    await resolveBacklogItem(repo, { id: done, resolution: "done", note: "by hand" });
    await resolveBacklogItem(repo, { id: dismissed, resolution: "dismissed" });
    await commit(`fix: later\n\nFixes-Backlog: ${done}\nFixes-Backlog: ${dismissed}`);
    const report = await derive();
    expect(report.resolved).toEqual([]);
    expect(report.ignored).toEqual([]); // closed items are known slugs
    expect(await getBacklogItem(repo, done)).toMatchObject({ status: "done", resolvedBy: "", evidence: "" });
    expect((await getBacklogItem(repo, dismissed))?.status).toBe("dismissed");
  });

  it("a provisional item waits for the person's keep or dismiss", async () => {
    const r = await addBacklogItem(repo, { title: "Captured in flight", provisional: true });
    if (!r.ok) throw new Error(r.error);
    await commit(`fix: it\n\nFixes-Backlog: ${r.item.id}`);
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, r.item.id))?.status).toBe("provisional");
  });

  it("a commit older than the item does not close it (a re-filed title is not already fixed)", async () => {
    await commit("fix: long ago\n\nFixes-Backlog: filed-after-its-fix", { GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z", GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z" });
    const id = await park("Filed after its fix");
    expect(id).toBe("filed-after-its-fix");
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
  });

  it("a reopened item is not closed again by the commit that closed it", async () => {
    const id = await park("Reopened by hand");
    await commit(`fix: first try\n\nFixes-Backlog: ${id}`);
    expect((await derive()).resolved).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100)); // commit dates are whole seconds
    const reopened = await setBacklogStatus(repo, id, "open");
    expect(reopened.ok && reopened.item).toMatchObject({ status: "open", resolvedBy: "", evidence: "" });
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
    // …but a NEW fix after the reopen closes it.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await commit(`fix: second try\n\nFixes-Backlog: ${id}`);
    expect((await derive()).resolved).toEqual([{ id, sha: second, subject: "fix: second try" }]);
  });

  it("a revert does not reopen a derived done: it stays done, and the revert is its own piece of work", async () => {
    const id = await park("Fixed then reverted");
    const fix = await commit(`fix: it\n\nFixes-Backlog: ${id}`);
    await derive();
    git(["revert", "--no-edit", fix]);
    const report = await derive();
    expect(report.resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("done");
  });

  it("only a real trailer counts, not the words in a paragraph", async () => {
    const id = await park("Mentioned in prose");
    await commit(`fix: something\n\nI looked at Fixes-Backlog: ${id} and moved on.\nFixes-Backlog: ${id} is mentioned here too.\n\nSigned-off-by: t`);
    const r = await derive();
    expect(r.resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
  });

  it("`Backlog:` is a reference and closes nothing, even with a bare slug on the line", async () => {
    const id = await park("Only referenced");
    await commit(`docs: note\n\nBacklog: ${id}`);
    await commit(`docs: another\n\nBacklog: ${id}, points 1 to 4.`);
    expect((await derive()).resolved).toEqual([]);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
  });

  it("the WHOLE value must be a list of existing slugs: prose after a slug, or a slug that does not exist, closes nothing on the line, and is reported once", async () => {
    const one = await park("Short");
    expect(one).toBe("short");
    const a = await park("Alpha item here");
    const b = await park("Bravo item here");
    await commit(`fix: prose\n\nFixes-Backlog: ${a}, points 1 to 4.`);
    await commit(`fix: half\n\nFixes-Backlog: ${b} (tab half), ${one}`);
    await commit("fix: missing\n\nFixes-Backlog: " + `${a}, no-such-item`);
    await commit("fix: lone word\n\nFixes-Backlog: to");
    const r = await derive();
    expect(r.resolved).toEqual([]);
    expect(r.ignored.map((i) => i.value).sort()).toEqual([`${a}, no-such-item`.replace(/^/, "").trim(), `${a}, points 1 to 4.`, `${b} (tab half), ${one}`, "to"].sort());
    for (const id of [one, a, b]) expect((await getBacklogItem(repo, id))?.status).toBe("open");
    expect(existsSync(join(repo, ".marvin", "backlog", "no-such-item.md"))).toBe(false);
    // said once: a second run over the same history reports nothing new
    await commit("chore: unrelated");
    expect((await derive()).ignored).toEqual([]);
  });

  it("a commit with two trailer lines closes both, and a comma list closes several", async () => {
    const a = await park("List one here");
    const b = await park("List two here");
    const c = await park("List three here");
    await commit(`fix: lists\n\nFixes-Backlog: ${a}, ${b}\nFixes-Backlog: ${c}`);
    expect((await derive()).resolved.map((r) => r.id).sort()).toEqual([a, b, c].sort());
  });

  it("an item held by an open tab is not closed from under it, and closes after the tab is done", async () => {
    const id = await park("Held by a live tab");
    const sessionId = "live-session-1";
    const claim = await claimBacklogItem(repo, id, { sessionId, branch: "marvin/tab/held" });
    expect(claim.ok).toBe(true);
    tab(sessionId);
    await commit(`fix: it\n\nFixes-Backlog: ${id}`);
    const first = await derive();
    expect(first.resolved).toEqual([]);
    expect(first.held).toEqual([id]);
    expect(await getBacklogItem(repo, id)).toMatchObject({ status: "doing", claimedBy: sessionId });
    // the tab closes: the next run (the tip has not moved) closes it
    tab(sessionId, { closedAt: new Date().toISOString() });
    const second = await deriveBacklogFromGit(repo, { now: Date.now() + 60_000 });
    expect(second.resolved.map((r) => r.id)).toEqual([id]);
    expect(await getBacklogItem(repo, id)).toMatchObject({ status: "done", claimedBy: "" });
  });

  it("a claim whose session is unknown is stale and is cleared with the closure", async () => {
    const id = await park("Stale claim");
    await claimBacklogItem(repo, id, { sessionId: "gone-session" });
    await commit(`fix: it\n\nFixes-Backlog: ${id}`);
    expect((await derive()).resolved.map((r) => r.id)).toEqual([id]);
    expect((await getBacklogItem(repo, id))?.claimedBy).toBe("");
  });

  it("the cache: an unchanged tip reads no history, and a moved tip scans only what is new", async () => {
    const a = await park("First fix");
    await commit(`fix: a\n\nFixes-Backlog: ${a}`);
    const first = await derive();
    expect(first.cached).toBe(false);
    expect(first.resolved).toHaveLength(1);
    const same = await derive();
    expect(same.cached).toBe(true);
    const b = await park("Second fix");
    await commit(`fix: b\n\nFixes-Backlog: ${b}`);
    const next = await derive();
    expect(next.cached).toBe(false);
    expect(next.resolved.map((r) => r.id)).toEqual([b]);
    expect(next.trailerCommits).toBe(2); // the first commit stayed in the cache
  });

  it("inside the TTL a burst of calls shares one answer and still checks newly filed items against it", async () => {
    const early = await park("Filed before the fix");
    await commit(`fix: both\n\nFixes-Backlog: ${early}\nFixes-Backlog: filed-just-now`);
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
    expect((await integrationBranch(repo)).branch).toBeNull();
    expect((await derive()).skipped).toMatch(/detached/);
  });

  it("uses the base tabs are cut from while the main checkout sits on another branch", async () => {
    const id = await park("Fixed on the base");
    const fix = await commit(`fix: on main\n\nFixes-Backlog: ${id}`);
    // The main checkout moves to a branch that does not have the fix (a merge train working there).
    git(["checkout", "-q", "-b", "train/wip", "HEAD~1"]);
    await mkdir(join(repo, ".marvin"), { recursive: true });
    await writeFile(join(repo, ".marvin", "worktrees.json"), `${JSON.stringify({ worktrees: [{ slug: "t", path: join(repo, "x"), branch: "marvin/tab/t", base: fix, baseRef: "main", createdAt: "2026-11-27T00:00:00Z", task: "t", state: "session" }] })}\n`);
    expect(await integrationBranch(repo)).toEqual({ branch: "main", source: "configured" });
    const report = await derive();
    expect(report.branch).toBe("main");
    expect(report.resolved.map((r) => r.id)).toEqual([id]);
  });

  it("falls back to the checkout's branch when no tab base is recorded, or the recorded one is gone", async () => {
    expect(await integrationBranch(repo)).toEqual({ branch: "main", source: "checkout" });
    await mkdir(join(repo, ".marvin"), { recursive: true });
    await writeFile(join(repo, ".marvin", "worktrees.json"), `${JSON.stringify({ worktrees: [{ slug: "t", path: "x", branch: "b", base: "0", baseRef: "deleted-branch", createdAt: "2026-11-27T00:00:00Z", task: "t", state: "session" }] })}\n`);
    expect(await integrationBranch(repo)).toEqual({ branch: "main", source: "checkout" });
  });

  it("derives nothing while a merge is in progress in the main checkout, and the next read does", async () => {
    const id = await park("Fixed during a merge");
    git(["checkout", "-q", "-b", "side"]);
    await writeFile(join(repo, "shared.txt"), "side\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "side change"]);
    git(["checkout", "-q", "main"]);
    await writeFile(join(repo, "shared.txt"), "main\n");
    git(["add", "-A"]);
    git(["commit", "-qm", `fix: it\n\nFixes-Backlog: ${id}`]);
    expect(() => git(["merge", "side"])).toThrow(); // conflict: MERGE_HEAD stays
    const busy = await derive();
    expect(busy.resolved).toEqual([]);
    expect(busy.skipped).toMatch(/merge is in progress/);
    expect((await getBacklogItem(repo, id))?.status).toBe("open");
    git(["merge", "--abort"]);
    expect((await derive()).resolved.map((r) => r.id)).toEqual([id]);
  });

  it("the resolution is persisted: the next read finds the item done without git", async () => {
    const id = await park("Persisted once");
    await commit(`fix: it\n\nFixes-Backlog: ${id}`);
    await derive();
    resetBacklogDeriveForTests();
    git(["checkout", "-q", "--detach"]); // git is no longer a source
    expect((await getBacklogItem(repo, id))?.status).toBe("done");
    expect(await readFile(join(repo, ".marvin", "backlog", `${id}.md`), "utf-8")).toMatch(/^resolvedBy: derived$/m);
  });
});

describe("parseTrailerLog / parseSlugList", () => {
  it("reads sha, date, subject and each line as a group of slugs, lowercased; a line that is not a list is malformed", () => {
    const out =
      `abc1234\0${"2026-11-27T10:00:00+02:00"}\0fix: x\0Alpha-One, beta-two\ngamma\nnot a slug list.\n\x1e\n` +
      `def5678\0${"2026-11-26T10:00:00+02:00"}\0docs: y\0\n\x1e`;
    const { groups, malformed, commits } = parseTrailerLog(out);
    expect(groups.map((g) => g.slugs)).toEqual([["alpha-one", "beta-two"], ["gamma"]]);
    expect(groups[1]?.commit).toMatchObject({ sha: "abc1234", subject: "fix: x" });
    expect(malformed.map((m) => m.value)).toEqual(["not a slug list."]);
    expect(commits).toBe(1);
  });

  it("accepts only a comma-separated list of whole slugs", () => {
    expect(parseSlugList("a, b-c ,d")).toEqual({ ok: true, slugs: ["a", "b-c", "d"] });
    for (const bad of ["", "a b", "a, b.", "a (half), b", "a, points 1 to 4.", "A_B", "a,,b", "-a"]) expect(parseSlugList(bad).ok).toBe(false);
  });
});

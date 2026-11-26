import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addBacklogItem,
  backlogOverview,
  closedCounts,
  getBacklogItem,
  legacySeverity,
  lenientSeverity,
  listBacklog,
  listResolved,
  MAX_NOTES_CHARS,
  normalizeSeverity,
  parseSeverity,
  resolveBacklogItem,
  setBacklogStatus,
  updateBacklogItem,
} from "../src/backlog";
import { CLOSED_INDEX_FILE, parseClosedIndex, resetClosedIndexCacheForTests, serializeClosedIndex } from "../src/backlog-index";

// ADR-0044 amendment (2026-11-27) — item files never move; the open index and a
// closed index make reading open work cheap; severity is one field with three
// values; `type` / `waitsOn` are input aliases, not fields; a full note cap
// refuses with advice.

let workDir: string;
const dir = () => join(workDir, ".marvin", "backlog");
const idxPath = () => join(workDir, ".marvin", CLOSED_INDEX_FILE);

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-backlog-index-"));
  resetClosedIndexCacheForTests();
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function legacyFile(id: string, status: string, over: Record<string, string> = {}): string {
  const f = { severity: "med", kind: "bug", updated: "2026-11-02T00:00:00.000Z", ...over };
  return (
    `---\nid: ${id}\ntitle: ${over.title ?? id}\nstatus: ${status}\nseverity: ${f.severity}\nkind: ${f.kind}\n` +
    `blocked: false\nblockedOn: \nsessionId: s\ncreated: 2026-11-01T00:00:00.000Z\nupdated: ${f.updated}\n---\n\nbody of ${id}\n`
  );
}

async function seedLegacy(open: number, done: number, dismissed: number): Promise<void> {
  await mkdir(dir(), { recursive: true });
  for (let i = 0; i < open; i++) await writeFile(join(dir(), `open-${i}.md`), legacyFile(`open-${i}`, i % 5 === 0 ? "doing" : "open", { severity: i % 2 ? "med" : "hi" }));
  for (let i = 0; i < done; i++) await writeFile(join(dir(), `done-${i}.md`), legacyFile(`done-${i}`, "done", { updated: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` }));
  for (let i = 0; i < dismissed; i++) await writeFile(join(dir(), `dismissed-${i}.md`), legacyFile(`dismissed-${i}`, "dismissed"));
}

describe("the closed index; item files never move", () => {
  it("reading a legacy store builds the index, returns only open items, and touches no item file", async () => {
    await seedLegacy(6, 4, 3);
    const before = await Promise.all((await readdir(dir())).map(async (f) => [f, await readFile(join(dir(), f), "utf-8"), (await stat(join(dir(), f))).mtimeMs] as const));
    const open = await listBacklog(workDir);
    expect(open).toHaveLength(6);
    expect(open.every((i) => ["open", "doing", "provisional"].includes(i.status))).toBe(true);
    expect(await closedCounts(workDir)).toEqual({ done: 4, dismissed: 3 });
    // every file is where it was, byte for byte, mtime for mtime — including `severity: med` / `hi`
    expect(existsSync(join(dir(), "archive"))).toBe(false);
    for (const [f, text, mtime] of before) {
      expect(await readFile(join(dir(), f), "utf-8")).toBe(text);
      expect((await stat(join(dir(), f))).mtimeMs).toBe(mtime);
    }
    expect(open.map((i) => i.severity).sort()).toEqual(["high", "high", "high", "medium", "medium", "medium"]);
  });

  it("the index is one line per closed item, newest first, with nothing that changes on a read", async () => {
    await seedLegacy(1, 4, 0);
    await listBacklog(workDir);
    const first = await readFile(idxPath(), "utf-8");
    const mtime = (await stat(idxPath())).mtimeMs;
    const lines = first.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines.map((l) => l.split("\t")[1])).toEqual(["done-3", "done-2", "done-1", "done-0"]); // newest `updated` first
    await new Promise((r) => setTimeout(r, 20));
    await listBacklog(workDir);
    await closedCounts(workDir);
    expect(await readFile(idxPath(), "utf-8")).toBe(first);
    expect((await stat(idxPath())).mtimeMs).toBe(mtime); // an unchanged index is not rewritten
    expect(serializeClosedIndex(parseClosedIndex(first).values())).toBe(first); // deterministic round trip
  });

  it("resolving keeps the file in place and moves the item's line to the closed index; reopening takes it back", async () => {
    const a = await addBacklogItem(workDir, { title: "Move me around" });
    if (!a.ok) throw new Error(a.error);
    await listBacklog(workDir); // builds the (empty) index
    await resolveBacklogItem(workDir, { id: a.item.id, resolution: "dismissed" });
    expect(existsSync(join(dir(), "move-me-around.md"))).toBe(true);
    expect(await readFile(idxPath(), "utf-8")).toContain("dismissed\tmove-me-around\t");
    expect(await listBacklog(workDir)).toEqual([]);
    expect(await closedCounts(workDir)).toEqual({ done: 0, dismissed: 1 });
    await setBacklogStatus(workDir, a.item.id, "done");
    expect(await closedCounts(workDir)).toEqual({ done: 1, dismissed: 0 });
    const back = await setBacklogStatus(workDir, a.item.id, "open");
    expect(back.ok && back.item.reopenedAt).toBeTruthy();
    expect(await readFile(idxPath(), "utf-8")).not.toContain("move-me-around");
    expect((await listBacklog(workDir)).map((i) => i.id)).toEqual(["move-me-around"]);
  });

  it("an index that is missing, stale or wrong is rebuilt from the files", async () => {
    await seedLegacy(2, 3, 1);
    await listBacklog(workDir);
    // a closed file reopened by hand, in a different size
    await writeFile(join(dir(), "done-1.md"), legacyFile("done-1", "open", { title: "reopened by hand with a longer title" }));
    expect((await listBacklog(workDir)).map((i) => i.id)).toContain("done-1");
    expect(await closedCounts(workDir)).toEqual({ done: 2, dismissed: 1 });
    // a closed file deleted
    await rm(join(dir(), "done-0.md"));
    expect(await closedCounts(workDir)).toEqual({ done: 1, dismissed: 1 });
    // the index deleted
    await rm(idxPath());
    expect(await closedCounts(workDir)).toEqual({ done: 1, dismissed: 1 });
    expect(existsSync(idxPath())).toBe(true);
    // the index garbled
    await writeFile(idxPath(), "not an index\n\u0000\tx\n");
    expect(await closedCounts(workDir)).toEqual({ done: 1, dismissed: 1 });
  });

  it("a line whose file changed size is not trusted", async () => {
    await seedLegacy(0, 2, 0);
    await listBacklog(workDir);
    const idx = (await readFile(idxPath(), "utf-8")).replace(/^(done\tdone-0\t[^\t]*\t[^\t]*\t)\d+/m, "$1999999");
    await writeFile(idxPath(), idx);
    const page = await listResolved(workDir);
    expect(page.items.map((i) => i.id).sort()).toEqual(["done-0", "done-1"]);
    expect(await readFile(idxPath(), "utf-8")).not.toContain("999999");
  });

  it("concurrent scans in one process cannot tear the index: every write has its own temp file", async () => {
    await seedLegacy(2, 40, 10);
    await Promise.all(Array.from({ length: 12 }, () => listResolved(workDir, { limit: 5 })));
    const text = await readFile(idxPath(), "utf-8");
    expect(parseClosedIndex(text).size).toBe(50);
    expect(serializeClosedIndex(parseClosedIndex(text).values())).toBe(text);
    expect((await readdir(join(workDir, ".marvin"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a symlinked item is not an item", async () => {
    await seedLegacy(1, 0, 0);
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/hosts", join(dir(), "linked.md"));
    expect((await listBacklog(workDir)).map((i) => i.id)).toEqual(["open-0"]);
  });
});

describe("paging the closed items", () => {
  it("newest first, a page at a time, with the total from the index", async () => {
    await seedLegacy(0, 7, 0);
    const first = await listResolved(workDir, { limit: 3, offset: 0 });
    expect(first.items.map((i) => i.id)).toEqual(["done-6", "done-5", "done-4"]);
    expect(first).toMatchObject({ total: 7, hasMore: true, offset: 0 });
    const last = await listResolved(workDir, { limit: 3, offset: 6 });
    expect(last.items.map((i) => i.id)).toEqual(["done-0"]);
    expect(last.hasMore).toBe(false);
  });

  it("filters by status without losing the page", async () => {
    await seedLegacy(0, 3, 4);
    const page = await listResolved(workDir, { status: "dismissed", limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((i) => i.status === "dismissed")).toBe(true);
    expect(page).toMatchObject({ total: 4, hasMore: true });
  });

  it("the overview gives the open items and counts with the closed ones counted, not read", async () => {
    await seedLegacy(3, 5, 2);
    const o = await backlogOverview(workDir);
    expect(o.open).toHaveLength(3);
    expect(o.counts).toMatchObject({ open: 2, doing: 1, done: 5, dismissed: 2, active: 3 });
    expect(o.resolved).toEqual({ done: 5, dismissed: 2, total: 7 });
    expect((await listBacklog(workDir, { status: "all" })).length).toBe(10);
  });

  it("the open index names the closed count and carries compact fields", async () => {
    await seedLegacy(0, 2, 0);
    await addBacklogItem(workDir, { title: "Compact fields", release: "v3.2", waitsOn: "owner" });
    const index = await readFile(join(workDir, ".marvin", "backlog.md"), "utf-8");
    expect(index).toContain("2 closed items are not listed here");
    expect(index).toContain("v3.2 · waits on owner");
    expect(index.match(/^- \[/gm)).toHaveLength(1);
  });
});

describe("severity: one field, three values", () => {
  it("folds every spelling it has met; an unknown value reads as medium", () => {
    for (const [raw, want] of [["med", "medium"], ["medium", "medium"], ["MED", "medium"], ["hi", "high"], ["high", "high"], ["lo", "low"], ["low", "low"], ["", "medium"], ["whatever", "medium"]] as const) {
      expect(normalizeSeverity(raw)).toBe(want);
    }
    expect(lenientSeverity("whatever")).toBeNull();
    expect(legacySeverity("medium")).toBe("med");
  });

  it("is accepted on write only as low | medium | high, with a message that says so", () => {
    expect(parseSeverity("medium")).toEqual({ ok: true, value: "medium" });
    const bad = parseSeverity("med");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/low, medium, high.*did you mean "medium"/);
    expect(parseSeverity("urgent-ish").ok).toBe(false);
  });

  it("the store refuses an invalid severity on add and on update, and writes nothing", async () => {
    const res = await addBacklogItem(workDir, { title: "Bad severity", severity: "med" as never });
    expect(res.ok).toBe(false);
    expect(existsSync(join(dir(), "bad-severity.md"))).toBe(false);
    const ok = await addBacklogItem(workDir, { title: "Good severity", severity: "high" });
    if (!ok.ok) throw new Error(ok.error);
    expect((await updateBacklogItem(workDir, ok.item.id, { severity: "hi" as never })).ok).toBe(false);
    expect((await getBacklogItem(workDir, ok.item.id))?.severity).toBe("high");
  });

  it("an older file is rewritten only when its item is next written, and then as `severity: medium`", async () => {
    await seedLegacy(2, 0, 0);
    const before = await readFile(join(dir(), "open-1.md"), "utf-8"); // severity: med
    expect((await listBacklog(workDir)).find((i) => i.id === "open-1")?.severity).toBe("medium");
    expect(await readFile(join(dir(), "open-1.md"), "utf-8")).toBe(before);
    await updateBacklogItem(workDir, "open-1", { note: "touched" });
    const after = await readFile(join(dir(), "open-1.md"), "utf-8");
    expect(after).toMatch(/^severity: medium$/m);
    expect(after).not.toMatch(/^priority:/m);
    expect(await readFile(join(dir(), "open-0.md"), "utf-8")).toContain("severity: hi"); // the sibling is untouched
  });
});

describe("kind and blockedOn stay the fields; type and waitsOn are aliases", () => {
  it("`type` writes `kind`, `waitsOn` writes `blockedOn` and blocks; no second field reaches the file", async () => {
    const a = await addBacklogItem(workDir, { title: "Alias round", type: "debt", waitsOn: "the owner", release: "v3.2", origin: "review-x" });
    if (!a.ok) throw new Error(a.error);
    expect(a.item).toMatchObject({ kind: "chore", blocked: true, blockedOn: "the owner", release: "v3.2", origin: "review-x" });
    const text = await readFile(join(dir(), "alias-round.md"), "utf-8");
    expect(text).not.toMatch(/^type:/m);
    expect(text).not.toMatch(/^waitsOn:/m);
    expect(text).toMatch(/^kind: chore$/m);
    expect(text).toMatch(/^blockedOn: the owner$/m);
    const idea = await addBacklogItem(workDir, { title: "Idea alias", type: "idea" });
    expect(idea.ok && idea.item.kind).toBe("feature");
    const explicit = await addBacklogItem(workDir, { title: "Kind wins", type: "bug", kind: "docs" });
    expect(explicit.ok && explicit.item.kind).toBe("docs");
  });

  it("update takes the aliases too, keeps an omitted field, and refuses an unknown type", async () => {
    await addBacklogItem(workDir, { title: "Update by alias", release: "v1" });
    const upd = await updateBacklogItem(workDir, "update-by-alias", { type: "bug", waitsOn: "reviewer" });
    expect(upd.ok && upd.item).toMatchObject({ kind: "bug", blocked: true, blockedOn: "reviewer", release: "v1" });
    const cleared = await updateBacklogItem(workDir, "update-by-alias", { waitsOn: "", blocked: false });
    expect(cleared.ok && cleared.item).toMatchObject({ blockedOn: "", blocked: false });
    expect((await updateBacklogItem(workDir, "update-by-alias", { type: "epic" as never })).ok).toBe(false);
    expect((await addBacklogItem(workDir, { title: "Bad type", type: "epic" as never })).ok).toBe(false);
  });

  it("release and origin refuse an over-long line, never truncating; a body line that looks like a field is not one", async () => {
    expect((await addBacklogItem(workDir, { title: "Long release", release: "x".repeat(60) })).ok).toBe(false);
    expect(existsSync(join(dir(), "long-release.md"))).toBe(false);
    const a = await addBacklogItem(workDir, { title: "Body lookalike", body: "release: v9\norigin: nowhere" });
    expect(a.ok && a.item.release).toBe("");
  });
});

describe("the note cap refuses with advice, and relatesTo links the follow-up", () => {
  async function fullItem(): Promise<string> {
    const a = await addBacklogItem(workDir, { title: "Long running stage item" });
    if (!a.ok) throw new Error(a.error);
    const notes = Array.from({ length: 20 }, (_, i) => `> note 2026-11-0${(i % 9) + 1} — ${"progress ".repeat(23)}`).join("\n");
    const upd = await updateBacklogItem(workDir, a.item.id, { body: `${a.item.body}\n\n${notes.slice(0, MAX_NOTES_CHARS - 50)}` });
    if (!upd.ok) throw new Error(upd.error);
    return a.item.id;
  }

  it("a note that does not fit is refused, names relatesTo, and nothing is written", async () => {
    const id = await fullItem();
    const before = await readFile(join(dir(), `${id}.md`), "utf-8");
    const res = await updateBacklogItem(workDir, id, { note: "x".repeat(200) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(`relatesTo: "${id}"`);
      expect(res.error).toContain("Nothing was written");
    }
    expect(await readFile(join(dir(), `${id}.md`), "utf-8")).toBe(before);
    const resolve = await resolveBacklogItem(workDir, { id, resolution: "done", note: "y".repeat(200) });
    expect(resolve.ok).toBe(false);
    if (!resolve.ok) expect(resolve.error).toContain("relatesTo");
  });

  it("the follow-up is filed with relatesTo and stored; a slug that does not exist is refused; a closed item is a valid target", async () => {
    const id = await fullItem();
    const next = await addBacklogItem(workDir, { title: "Second half of the stage item", relatesTo: id });
    expect(next.ok && next.item.relatesTo).toBe(id);
    expect((await getBacklogItem(workDir, "second-half-of-the-stage-item"))?.relatesTo).toBe(id);
    const bad = await addBacklogItem(workDir, { title: "Points nowhere", relatesTo: "no-such-item" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not a backlog item");
    await resolveBacklogItem(workDir, { id, resolution: "done" });
    expect((await addBacklogItem(workDir, { title: "Third part, after the first closed", relatesTo: id })).ok).toBe(true);
  });
});

describe("a store whose files are tracked in git", () => {
  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workDir,
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).trim();
  }

  it("shows a clean `git status` after a full index build, and after add / resolve only the item files and the open index", async () => {
    await seedLegacy(8, 30, 6);
    git(["init", "-q", "-b", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    await addBacklogItem(workDir, { title: "Seed the open index" }); // writes .marvin/backlog.md
    git(["add", "-A"]);
    git(["commit", "-qm", "tracked store"]);
    expect(git(["status", "--porcelain"])).toBe("");

    // a full build of the closed index, from nothing
    await rm(idxPath(), { force: true });
    expect(await closedCounts(workDir)).toEqual({ done: 30, dismissed: 6 });
    expect(existsSync(idxPath())).toBe(true);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(git(["status", "--porcelain", "--ignored"])).toContain(`!! .marvin/${CLOSED_INDEX_FILE}`);

    // add and resolve: only the files they are about change
    await addBacklogItem(workDir, { title: "A brand new follow up" });
    await resolveBacklogItem(workDir, { id: "open-2", resolution: "done" });
    const lines = git(["status", "--porcelain"]).split("\n").filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, "")).sort();
    expect(lines).toEqual([".marvin/backlog.md", ".marvin/backlog/a-brand-new-follow-up.md", ".marvin/backlog/open-2.md"]);
    expect(lines.some((l) => l.includes(".idx") || l.includes("archive"))).toBe(false);
    expect(git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((l) => l.startsWith("??")).map((l) => l.replace(/^\S+\s+/, ""))).toEqual([".marvin/backlog/a-brand-new-follow-up.md"]);
  });
});

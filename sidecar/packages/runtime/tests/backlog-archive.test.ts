import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addBacklogItem,
  archiveCounts,
  claimBacklogItem,
  ensureBacklogLayout,
  getBacklogItem,
  legacySeverity,
  lenientPriority,
  listBacklog,
  listResolved,
  MAX_NOTES_CHARS,
  normalizePriority,
  parsePriority,
  resetBacklogLayoutCacheForTests,
  resolveBacklogItem,
  rewriteBacklogIndex,
  setBacklogStatus,
  updateBacklogItem,
} from "../src/backlog";

// ADR-0044 addendum (2026-11-27) — open items beside the index, resolved items
// in `archive/`; one priority vocabulary; optional fields; a note cap that
// refuses with advice.

let workDir: string;
const dir = () => join(workDir, ".marvin", "backlog");
const archive = () => join(dir(), "archive");

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-backlog-archive-"));
  resetBacklogLayoutCacheForTests();
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function legacyFile(id: string, status: string, over: Record<string, string> = {}): string {
  const f = { severity: "med", kind: "bug", ...over };
  return (
    `---\nid: ${id}\ntitle: ${over.title ?? id}\nstatus: ${status}\nseverity: ${f.severity}\nkind: ${f.kind}\n` +
    `blocked: false\nblockedOn: \nsessionId: s\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-0${status === "done" ? 2 : 1}T00:00:00.000Z\n---\n\nbody of ${id}\n`
  );
}

async function seedLegacy(open: number, done: number, dismissed: number): Promise<void> {
  await mkdir(dir(), { recursive: true });
  for (let i = 0; i < open; i++) await writeFile(join(dir(), `open-${i}.md`), legacyFile(`open-${i}`, i % 5 === 0 ? "doing" : "open", { severity: i % 2 ? "med" : "hi" }));
  for (let i = 0; i < done; i++) await writeFile(join(dir(), `done-${i}.md`), legacyFile(`done-${i}`, "done"));
  for (let i = 0; i < dismissed; i++) await writeFile(join(dir(), `dismissed-${i}.md`), legacyFile(`dismissed-${i}`, "dismissed"));
}

describe("the migration", () => {
  it("moves done and dismissed files to archive/, byte for byte, and leaves the open ones in place", async () => {
    await seedLegacy(6, 4, 3);
    const doneBefore = await readFile(join(dir(), "done-1.md"), "utf-8");
    const run = await ensureBacklogLayout(workDir);
    expect(run).toMatchObject({ migrated: true, moved: 7 });
    expect(await readFile(join(archive(), "done-1.md"), "utf-8")).toBe(doneBefore);
    expect(existsSync(join(dir(), "done-1.md"))).toBe(false);
    const open = (await readdir(dir())).filter((f) => f.endsWith(".md"));
    expect(open).toHaveLength(6);
    expect(await archiveCounts(workDir)).toEqual({ done: 4, dismissed: 3 });
    expect(JSON.parse(await readFile(join(archive(), "summary.json"), "utf-8"))).toMatchObject({ layout: 1, done: 4, dismissed: 3 });
  });

  it("is idempotent: a second run, and a second process, change nothing", async () => {
    await seedLegacy(3, 2, 1);
    await ensureBacklogLayout(workDir);
    const snapshot = JSON.stringify(await readdir(archive()));
    resetBacklogLayoutCacheForTests(); // as if another MARVIN process arrived
    const again = await ensureBacklogLayout(workDir);
    expect(again.migrated).toBe(false);
    expect(JSON.stringify(await readdir(archive()))).toBe(snapshot);
  });

  it("two sessions migrating at once end with every file in exactly one place", async () => {
    await seedLegacy(5, 40, 10);
    resetBacklogLayoutCacheForTests();
    await Promise.all([ensureBacklogLayout(workDir), ensureBacklogLayout(workDir), listBacklog(workDir)]);
    expect((await readdir(archive())).filter((f) => f.endsWith(".md"))).toHaveLength(50);
    expect((await readdir(dir())).filter((f) => f.endsWith(".md"))).toHaveLength(5);
    expect(await archiveCounts(workDir)).toEqual({ done: 40, dismissed: 10 });
  });

  it("resumes after a crash: a half-moved store is finished by the next run", async () => {
    await seedLegacy(2, 6, 0);
    await mkdir(archive(), { recursive: true });
    // As if an earlier run moved three files and died before writing the summary.
    for (const n of ["done-0", "done-1", "done-2"]) {
      await writeFile(join(archive(), `${n}.md`), await readFile(join(dir(), `${n}.md`), "utf-8"));
      await rm(join(dir(), `${n}.md`));
    }
    const run = await ensureBacklogLayout(workDir);
    expect(run.migrated).toBe(true);
    expect(await archiveCounts(workDir)).toEqual({ done: 6, dismissed: 0 });
    expect((await readdir(dir())).filter((f) => f.endsWith(".md"))).toHaveLength(2);
  });

  it("takes over a lock a crashed session left behind", async () => {
    await seedLegacy(1, 2, 0);
    await mkdir(join(dir(), ".layout.lock"));
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(join(dir(), ".layout.lock"), old, old);
    expect((await ensureBacklogLayout(workDir)).migrated).toBe(true);
    expect(existsSync(join(dir(), ".layout.lock"))).toBe(false);
  });

  it("rewrites open items once with `priority:` (the old spelling folded) and keeps `severity:` beside it", async () => {
    await seedLegacy(2, 0, 0);
    await ensureBacklogLayout(workDir);
    const text = await readFile(join(dir(), "open-0.md"), "utf-8"); // severity: hi
    expect(text).toContain("priority: high");
    expect(text).toContain("severity: high");
    const text1 = await readFile(join(dir(), "open-1.md"), "utf-8"); // severity: med
    expect(text1).toContain("priority: medium");
    expect(text1).toContain("severity: med");
  });

  it("leaves a project with no backlog alone (no directory is created by a read)", async () => {
    expect(await listBacklog(workDir)).toEqual([]);
    expect(existsSync(dir())).toBe(false);
  });

  it("a resolved file that turns up beside the index later (an older MARVIN, a checkout) is moved on read", async () => {
    await addBacklogItem(workDir, { title: "Seed the layout" });
    await writeFile(join(dir(), "late-arrival.md"), legacyFile("late-arrival", "done"));
    const open = await listBacklog(workDir);
    expect(open.map((i) => i.id)).toEqual(["seed-the-layout"]);
    expect(existsSync(join(archive(), "late-arrival.md"))).toBe(true);
    expect((await archiveCounts(workDir)).done).toBe(1);
  });
});

describe("open index + archive at work", () => {
  it("the index and the default list hold only provisional / open / doing; the archive answers on request", async () => {
    await seedLegacy(4, 5, 2);
    const open = await listBacklog(workDir);
    expect(open).toHaveLength(4);
    expect(open.every((i) => ["open", "doing", "provisional"].includes(i.status))).toBe(true);
    await rewriteBacklogIndex(workDir);
    const index = await readFile(join(workDir, ".marvin", "backlog.md"), "utf-8");
    expect(index.match(/^- \[/gm)).toHaveLength(4);
    expect(index).toContain("7 resolved items are archived");
    expect(index).not.toContain("done-1");
    expect((await listBacklog(workDir, { status: "done" })).map((i) => i.id).sort()).toEqual(["done-0", "done-1", "done-2", "done-3", "done-4"]);
    expect(await listBacklog(workDir, { status: "all" })).toHaveLength(11);
  });

  it("resolving moves the file and the counts; reopening brings it back and stamps reopenedAt", async () => {
    const a = await addBacklogItem(workDir, { title: "Move me around" });
    if (!a.ok) throw new Error(a.error);
    await resolveBacklogItem(workDir, { id: a.item.id, resolution: "dismissed" });
    expect(existsSync(join(archive(), "move-me-around.md"))).toBe(true);
    expect(await archiveCounts(workDir)).toEqual({ done: 0, dismissed: 1 });
    await setBacklogStatus(workDir, a.item.id, "done"); // dismissed -> done inside the archive
    expect(await archiveCounts(workDir)).toEqual({ done: 1, dismissed: 0 });
    const back = await setBacklogStatus(workDir, a.item.id, "open");
    expect(back.ok && back.item.reopenedAt).toBeTruthy();
    expect(existsSync(join(dir(), "move-me-around.md"))).toBe(true);
    expect(existsSync(join(archive(), "move-me-around.md"))).toBe(false);
    expect(await archiveCounts(workDir)).toEqual({ done: 0, dismissed: 0 });
  });

  it("re-adding a resolved title reopens it from the archive", async () => {
    const a = await addBacklogItem(workDir, { title: "Come back later" });
    if (!a.ok) throw new Error(a.error);
    await resolveBacklogItem(workDir, { id: a.item.id, resolution: "done" });
    const again = await addBacklogItem(workDir, { title: "Come back later" });
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.item.status).toBe("open");
    expect(existsSync(join(archive(), "come-back-later.md"))).toBe(false);
  });

  it("claim, update and lookup find an item wherever it lives", async () => {
    const a = await addBacklogItem(workDir, { title: "Find me in the archive" });
    if (!a.ok) throw new Error(a.error);
    await resolveBacklogItem(workDir, { id: a.item.id, resolution: "done" });
    expect((await getBacklogItem(workDir, a.item.id))?.status).toBe("done");
    const upd = await updateBacklogItem(workDir, a.item.id, { note: "late word" });
    expect(upd.ok).toBe(true);
    expect(existsSync(join(archive(), `${a.item.id}.md`))).toBe(true); // an edit does not reopen it
    const claim = await claimBacklogItem(workDir, a.item.id, { sessionId: "s1" });
    expect(claim.ok).toBe(false);
    expect(await getBacklogItem(workDir, "../etc/passwd")).toBeNull();
  });

  it("a summary that disagrees with the files is recounted, not trusted", async () => {
    await seedLegacy(1, 3, 1);
    await ensureBacklogLayout(workDir);
    await writeFile(join(archive(), "summary.json"), JSON.stringify({ layout: 1, done: 99, dismissed: 0 }));
    expect(await archiveCounts(workDir)).toEqual({ done: 3, dismissed: 1 });
  });
});

describe("paging the archive", () => {
  it("newest first, a page at a time, with the total from the summary", async () => {
    await seedLegacy(0, 7, 0);
    await ensureBacklogLayout(workDir);
    // make the order explicit: done-0 oldest … done-6 newest
    for (let i = 0; i < 7; i++) {
      const t = new Date(Date.UTC(2026, 10, 1 + i));
      await utimes(join(archive(), `done-${i}.md`), t, t);
    }
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
});

describe("priority", () => {
  it("normalises every spelling it has ever met; an unknown value reads as medium", () => {
    for (const [raw, want] of [["med", "medium"], ["medium", "medium"], ["MED", "medium"], ["hi", "high"], ["high", "high"], ["lo", "low"], ["low", "low"], ["", "medium"], ["whatever", "medium"]] as const) {
      expect(normalizePriority(raw)).toBe(want);
    }
    expect(lenientPriority("whatever")).toBeNull();
    expect(legacySeverity("medium")).toBe("med");
  });

  it("is accepted only as low | medium | high on write, with a message that says so", () => {
    expect(parsePriority("medium")).toEqual({ ok: true, value: "medium" });
    const bad = parsePriority("med");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/low, medium, high.*did you mean "medium"/);
    expect(parsePriority("urgent-ish").ok).toBe(false);
  });

  it("the store refuses an invalid priority on add and on update, and writes nothing", async () => {
    const res = await addBacklogItem(workDir, { title: "Bad priority", priority: "med" as never });
    expect(res.ok).toBe(false);
    expect(existsSync(join(dir(), "bad-priority.md"))).toBe(false);
    const ok = await addBacklogItem(workDir, { title: "Good priority", priority: "high" });
    if (!ok.ok) throw new Error(ok.error);
    const upd = await updateBacklogItem(workDir, ok.item.id, { priority: "hi" as never });
    expect(upd.ok).toBe(false);
    expect((await getBacklogItem(workDir, ok.item.id))?.priority).toBe("high");
  });

  it("a legacy file reads normalised, and writes both spellings", async () => {
    await seedLegacy(1, 0, 0);
    const item = (await listBacklog(workDir))[0];
    expect(item?.priority).toBe("high"); // severity: hi
    const text = await readFile(join(dir(), "open-0.md"), "utf-8");
    expect(text).toMatch(/^priority: high$/m);
    expect(text).toMatch(/^severity: high$/m);
  });
});

describe("new optional fields", () => {
  it("type, release, origin and waitsOn are stored, shown in the index, kept on a re-add, and editable", async () => {
    const a = await addBacklogItem(workDir, { title: "Fields all round", type: "debt", release: "v3.2", origin: "session-ab12", waitsOn: "owner" });
    if (!a.ok) throw new Error(a.error);
    expect(a.item).toMatchObject({ type: "debt", release: "v3.2", origin: "session-ab12", waitsOn: "owner" });
    const index = await readFile(join(workDir, ".marvin", "backlog.md"), "utf-8");
    expect(index).toContain("debt · v3.2 · waits on owner");
    const again = await addBacklogItem(workDir, { title: "Fields all round" });
    expect(again.ok && again.item).toMatchObject({ type: "debt", release: "v3.2", waitsOn: "owner" });
    const upd = await updateBacklogItem(workDir, a.item.id, { release: "v3.3", waitsOn: "" });
    expect(upd.ok && upd.item).toMatchObject({ release: "v3.3", waitsOn: "" });
    expect((await getBacklogItem(workDir, a.item.id))?.release).toBe("v3.3");
  });

  it("refuses an unknown type and an over-long line, never truncating", async () => {
    expect((await addBacklogItem(workDir, { title: "T", type: "epic" as never })).ok).toBe(false);
    const long = await addBacklogItem(workDir, { title: "Long wait", waitsOn: "x".repeat(300) });
    expect(long.ok).toBe(false);
    expect(existsSync(join(dir(), "long-wait.md"))).toBe(false);
  });

  it("a body line that starts like a field is not read as one", async () => {
    const a = await addBacklogItem(workDir, { title: "Body lookalike", body: "release: v9\norigin: nowhere" });
    expect(a.ok && a.item.release).toBe("");
    expect((await getBacklogItem(workDir, "body-lookalike"))?.release).toBe("");
  });
});

describe("the note cap refuses with advice, and relatesTo links the follow-up", () => {
  async function fullItem(): Promise<string> {
    const a = await addBacklogItem(workDir, { title: "Long running stage item" });
    if (!a.ok) throw new Error(a.error);
    const notes = Array.from({ length: 20 }, (_, i) => `> note 2026-11-0${(i % 9) + 1} — ${"progress ".repeat(23)}`).join("\n");
    expect(notes.length).toBeGreaterThan(MAX_NOTES_CHARS - 300);
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

  it("the follow-up is filed with relatesTo and the link is stored; a slug that does not exist is refused", async () => {
    const id = await fullItem();
    const next = await addBacklogItem(workDir, { title: "Second half of the stage item", relatesTo: id });
    expect(next.ok && next.item.relatesTo).toBe(id);
    expect((await getBacklogItem(workDir, "second-half-of-the-stage-item"))?.relatesTo).toBe(id);
    const bad = await addBacklogItem(workDir, { title: "Points nowhere", relatesTo: "no-such-item" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not a backlog item");
    // an archived item is still a valid target
    await resolveBacklogItem(workDir, { id, resolution: "done" });
    const viaArchive = await addBacklogItem(workDir, { title: "Third part, after the first closed", relatesTo: id });
    expect(viaArchive.ok).toBe(true);
  });
});

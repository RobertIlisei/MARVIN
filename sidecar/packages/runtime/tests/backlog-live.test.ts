import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addBacklogItem, listBacklog, setBacklogStatus, updateBacklogItem } from "../src/backlog";
import {
  type BacklogChange,
  type BacklogCounts,
  createBacklogCounter,
  createBacklogLive,
  countsFromRows,
  EMPTY_BACKLOG_COUNTS,
  noteBacklogWrite,
  setBacklogLiveForTests,
} from "../src/backlog-live";

// The owner's report (2026-11-25): the "N backlog items parked" strip is read
// once and never again, so it goes stale while sessions file and resolve items
// all day. The sidecar now says WHEN the backlog changed: one debounced signal
// per project for any write (the tool, the routes, a hand edit, a git checkout),
// carrying the new counts. These tests pin the counting, the coalescing and the
// two ways a change reaches the signal.

const item = (status: string, blocked = false, name = "x") =>
  `---\nid: ${name}\ntitle: ${name}\nstatus: ${status}\nseverity: med\nkind: bug\nblocked: ${blocked}\nblockedOn: \nsessionId: s\ncreated: 2026-11-01T00:00:00Z\nupdated: 2026-11-01T00:00:00Z\n---\n\nbody ${name}\n`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let workDir: string;
let dir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-backlog-live-"));
  dir = join(workDir, ".marvin", "backlog");
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  setBacklogLiveForTests(null);
  await rm(workDir, { recursive: true, force: true });
});

describe("countsFromRows", () => {
  it("counts every status, the blocked flag, and the active total the strip shows", () => {
    const c = countsFromRows([
      { status: "provisional", blocked: false },
      { status: "open", blocked: true },
      { status: "open", blocked: false },
      { status: "doing", blocked: false },
      { status: "done", blocked: false },
      { status: "dismissed", blocked: true },
    ]);
    expect(c).toEqual({ provisional: 1, open: 2, doing: 1, done: 1, dismissed: 1, blocked: 2, active: 4 });
  });

  it("reads an unknown status as open, like the store's parser does", () => {
    expect(countsFromRows([{ status: "weird", blocked: false }]).open).toBe(1);
  });
});

describe("the file counter", () => {
  it("agrees with the store's own list on a mixed directory", async () => {
    await addBacklogItem(workDir, { title: "first thing", body: "b", severity: "high" });
    await addBacklogItem(workDir, { title: "second thing", body: "b" });
    await addBacklogItem(workDir, { title: "third thing", body: "b", provisional: true });
    await setBacklogStatus(workDir, "second-thing", "done");
    const items = await listBacklog(workDir);
    const counter = createBacklogCounter();
    const got = await counter.count(workDir);
    expect(got).toEqual(countsFromRows(items));
    expect(got.active).toBe(2);
  });

  it("re-reads only files whose mtime or size moved, and sees an in-place status edit", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    await writeFile(join(dir, "b.md"), item("open", false, "b"));
    const counter = createBacklogCounter();
    expect((await counter.count(workDir)).open).toBe(2);
    // Same size, new mtime: status flips in place.
    await writeFile(join(dir, "a.md"), item("done", false, "a"));
    await utimes(join(dir, "a.md"), new Date(), new Date(Date.now() + 5000));
    const after = await counter.count(workDir);
    expect(after.open).toBe(1);
    expect(after.done).toBe(1);
  });

  it("drops a deleted file and ignores non-markdown and symlinked entries", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    await writeFile(join(dir, "notes.txt"), item("open", false, "t"));
    await writeFile(join(workDir, "outside.md"), item("open", false, "o"));
    await symlink(join(workDir, "outside.md"), join(dir, "link.md"));
    const counter = createBacklogCounter();
    expect((await counter.count(workDir)).open).toBe(1);
    await rm(join(dir, "a.md"));
    expect(await counter.count(workDir)).toEqual(EMPTY_BACKLOG_COUNTS);
  });

  it("answers zeroes for a project with no backlog directory", async () => {
    await rm(dir, { recursive: true });
    expect(await createBacklogCounter().count(workDir)).toEqual(EMPTY_BACKLOG_COUNTS);
  });

  it("does not follow a symlinked backlog directory out of the project", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "marvin-elsewhere-"));
    try {
      await writeFile(join(elsewhere, "z.md"), item("open", false, "z"));
      await rm(dir, { recursive: true });
      await symlink(elsewhere, dir);
      expect(await createBacklogCounter().count(workDir)).toEqual(EMPTY_BACKLOG_COUNTS);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the debounced signal (fake clock)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const live = (counts: BacklogCounts[] = []) => {
    let n = 0;
    const count = vi.fn(async () => counts[Math.min(n++, counts.length - 1)] ?? EMPTY_BACKLOG_COUNTS);
    const hub = createBacklogLive({ debounceMs: 300, maxWaitMs: 1500, count });
    const seen: BacklogChange[] = [];
    hub.subscribe("/p", (c) => seen.push(c));
    return { hub, seen, count };
  };

  it("coalesces a burst into exactly one signal, after the quiet period", async () => {
    const { hub, seen } = live([{ ...EMPTY_BACKLOG_COUNTS, open: 3, active: 3 }]);
    for (let i = 0; i < 10; i++) {
      hub.noteWrite("/p");
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.active).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(1);
  });

  it("never lets a steady stream of writes postpone the signal past the max wait", async () => {
    const { hub, seen } = live();
    for (let t = 0; t < 4000; t += 100) {
      hub.noteWrite("/p");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("numbers the signals so a client can drop an older one", async () => {
    const { hub, seen } = live();
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(400);
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(400);
    expect(seen.map((s) => s.revision)).toEqual([1, 2]);
    expect(seen.every((s) => s.reason === "change")).toBe(true);
  });

  it("keeps projects apart", async () => {
    const { hub, seen } = live();
    hub.noteWrite("/other");
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(0);
  });

  it("a write that lands while the count is being read is not lost", async () => {
    let release: (c: BacklogCounts) => void = () => {};
    const gate = new Promise<BacklogCounts>((r) => {
      release = r;
    });
    let calls = 0;
    const count = vi.fn(async () => (calls++ === 0 ? gate : { ...EMPTY_BACKLOG_COUNTS, open: 2, active: 2 }));
    const hub = createBacklogLive({ debounceMs: 100, maxWaitMs: 1000, count });
    const seen: BacklogChange[] = [];
    hub.subscribe("/p", (c) => seen.push(c));
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(150); // flush starts, count() pending
    hub.noteWrite("/p");
    release({ ...EMPTY_BACKLOG_COUNTS, open: 1, active: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.at(-1)?.counts.active).toBe(2);
  });

  it("stays quiet when the count cannot be read", async () => {
    const hub = createBacklogLive({
      debounceMs: 50,
      maxWaitMs: 500,
      count: async () => {
        throw new Error("EIO");
      },
    });
    const seen: BacklogChange[] = [];
    hub.subscribe("/p", (c) => seen.push(c));
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(0);
  });

  it("answers a snapshot for a new subscriber without a revision bump", async () => {
    const { hub } = live([{ ...EMPTY_BACKLOG_COUNTS, open: 7, active: 7 }]);
    const snap = await hub.snapshot("/p");
    expect(snap.reason).toBe("snapshot");
    expect(snap.counts.active).toBe(7);
    expect(snap.revision).toBe(0);
  });
});

describe("a tool write and an outside edit each produce exactly one signal (real files, real clock)", () => {
  const collect = (hub: ReturnType<typeof createBacklogLive>) => {
    const seen: BacklogChange[] = [];
    hub.subscribe(workDir, (c) => seen.push(c));
    return seen;
  };

  it("the tool path: addBacklogItem signals once, with the new count", async () => {
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 300 });
    setBacklogLiveForTests(hub);
    const seen = collect(hub);
    await addBacklogItem(workDir, { title: "parked by a tool", body: "b" });
    await sleep(250);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.active).toBe(1);
    await sleep(250);
    expect(seen).toHaveLength(1);
  });

  it("the tool path with the watcher attached still signals once, not twice", async () => {
    const hub = createBacklogLive({ debounceMs: 60, maxWaitMs: 400 });
    setBacklogLiveForTests(hub);
    const release = hub.watch(workDir);
    try {
      await sleep(80);
      const seen = collect(hub);
      await addBacklogItem(workDir, { title: "parked with a watcher", body: "b" });
      await setBacklogStatus(workDir, "parked-with-a-watcher", "done");
      await sleep(400);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.counts).toMatchObject({ active: 0, done: 1 });
    } finally {
      release();
    }
  });

  it("a hand edit of a file in .marvin/backlog signals once, with no tool involved", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    await writeFile(join(dir, "b.md"), item("open", false, "b"));
    const hub = createBacklogLive({ debounceMs: 60, maxWaitMs: 400 });
    await hub.snapshot(workDir); // warm the cache like a connected client would
    const release = hub.watch(workDir);
    try {
      await sleep(80);
      const seen = collect(hub);
      await writeFile(join(dir, "a.md"), item("dismissed", false, "a-longer-id-so-size-moves"));
      await sleep(400);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.counts).toMatchObject({ open: 1, dismissed: 1, active: 1 });
    } finally {
      release();
    }
  });

  it("a file appearing from outside (a git checkout) signals once", async () => {
    const hub = createBacklogLive({ debounceMs: 60, maxWaitMs: 400 });
    const release = hub.watch(workDir);
    try {
      await sleep(80);
      const seen = collect(hub);
      for (const n of ["p", "q", "r"]) await writeFile(join(dir, `${n}.md`), item("provisional", false, n));
      await sleep(400);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.counts.provisional).toBe(3);
    } finally {
      release();
    }
  });

  it("releasing the watch stops outside edits from signalling", async () => {
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 200 });
    const release = hub.watch(workDir);
    await sleep(80);
    release();
    const seen = collect(hub);
    await writeFile(join(dir, "late.md"), item("open", false, "late"));
    await sleep(300);
    expect(seen).toHaveLength(0);
  });

  it("two watchers of one project share one watch, and the last release closes it", async () => {
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 200 });
    const r1 = hub.watch(workDir);
    const r2 = hub.watch(workDir);
    expect(hub.watchedCount()).toBe(1);
    r1();
    expect(hub.watchedCount()).toBe(1);
    r2();
    expect(hub.watchedCount()).toBe(0);
  });

  it("a directory replaced under the watch (a checkout that recreates it) is picked up and signalled", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 200, healthMs: 60 });
    const release = hub.watch(workDir);
    try {
      await sleep(80);
      const seen = collect(hub);
      await rm(dir, { recursive: true });
      await mkdir(dir);
      await writeFile(join(dir, "n.md"), item("open", false, "n"));
      await sleep(400);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.at(-1)?.counts.active).toBe(1);
      // And the NEW directory is the one being watched.
      const before = seen.length;
      await writeFile(join(dir, "m.md"), item("open", false, "m"));
      await sleep(300);
      expect(seen.length).toBe(before + 1);
      expect(seen.at(-1)?.counts.active).toBe(2);
    } finally {
      release();
    }
  });

  it("the module-level noteBacklogWrite feeds the installed hub", async () => {
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 200 });
    setBacklogLiveForTests(hub);
    const seen = collect(hub);
    noteBacklogWrite(workDir);
    await sleep(200);
    expect(seen).toHaveLength(1);
  });

  it("a classification edit signals too (the open window re-reads it)", async () => {
    await addBacklogItem(workDir, { title: "to classify", body: "b" });
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 300 });
    setBacklogLiveForTests(hub);
    const seen = collect(hub);
    await updateBacklogItem(workDir, "to-classify", { blocked: true, blockedOn: "legal" });
    await sleep(250);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.blocked).toBe(1);
  });
});

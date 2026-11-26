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
    const items = await listBacklog(workDir, { status: "all" }); // the open files + the closed ones
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


// ---------------------------------------------------------------------------
// The exact-number guarantees, driven deterministically. A full vitest run on a
// loaded machine (2026-11-25) failed "a directory replaced under the watch":
// one `writeFile` produced two watcher events 51 ms apart, the test's 40 ms
// quiet period split them into two flushes, and a real-clock test that asserted
// "exactly one" failed 7 runs in 30 under CPU load. Two fixes: a flush that
// finds the directory exactly as the last signal left it says nothing (a late
// second event for the same write is not a change), and these tests drive the
// watcher's callback and the clock themselves instead of racing the kernel.
// ---------------------------------------------------------------------------

const counts = (o: Partial<BacklogCounts>): BacklogCounts => {
  const c = { ...EMPTY_BACKLOG_COUNTS, ...o };
  c.active = c.provisional + c.open + c.doing;
  return c;
};

/** A directory state the fake scan can be told to be in. */
function fakeState() {
  const st = { counts: counts({ open: 1 }), signature: "s1" };
  const scan = vi.fn(async () => ({ counts: st.counts, signature: st.signature }));
  return {
    scan,
    set: (sig: string, c: Partial<BacklogCounts>) => {
      st.signature = sig;
      st.counts = counts(c);
    },
  };
}

/** A watcher whose events the test fires itself. */
function fakeWatcher() {
  const made: Array<{ dir: string; fire: (name: string | null) => void; fail: () => void; closed: boolean }> = [];
  const factory = (dir: string, onEvent: (name: string | null) => void, onError: () => void) => {
    const w = { dir, fire: onEvent, fail: onError, closed: false };
    made.push(w);
    return {
      close: () => {
        w.closed = true;
      },
    };
  };
  return { made, factory };
}

describe("one signal per change, however the events arrive (fake clock, fake watcher)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const state = fakeState();
    const w = fakeWatcher();
    let ino: number | null = 1;
    const hub = createBacklogLive({
      debounceMs: 40,
      maxWaitMs: 200,
      healthMs: 60,
      scan: state.scan,
      watcher: w.factory,
      inode: () => ino,
    });
    // Attached like the announce stream: the state now arrives as a snapshot
    // frame (kept apart); `seen` holds the changes after it.
    const seen: BacklogChange[] = [];
    const snapshots: BacklogChange[] = [];
    hub.attach("/p", (c) => (c.reason === "snapshot" ? snapshots : seen).push(c));
    return {
      hub,
      state,
      w,
      seen,
      snapshots,
      setIno: (n: number | null) => {
        ino = n;
      },
    };
  };

  it("attaching tells the subscriber the state now, once, as a snapshot", async () => {
    const { snapshots, seen } = setup();
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.counts.active).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("what one subscriber already knows never hides a change from another (a snapshot read just before a write)", async () => {
    const { hub, state, seen } = setup(); // A: attached at s1
    await vi.advanceTimersByTimeAsync(10);
    state.set("s2", { open: 2 }); // the write lands ...
    const b: BacklogChange[] = [];
    hub.attach("/p", (c) => b.push(c)); // ... and B attaches before A's flush runs: B's snapshot already is s2
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(500);
    expect(b.map((c) => [c.reason, c.counts.active])).toEqual([["snapshot", 2]]); // B is told once
    expect(seen.map((c) => c.counts.active)).toEqual([2]); // A is still told its change
  });

  it("a write the store reports and the watcher also sees is one signal", async () => {
    const { hub, w, seen, state } = setup();
    hub.watch("/p");
    state.set("s2", { open: 1, doing: 1 });
    hub.noteWrite("/p"); // the store
    w.made[0]?.fire("x.md"); // the watcher, same write
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.active).toBe(2);
  });

  it("two events for ONE write, further apart than the quiet period, are still one signal", async () => {
    // The failure seen under load: a create event, then a second one 51 ms later.
    const { hub, w, seen, state } = setup();
    hub.watch("/p");
    state.set("s2", { open: 2 });
    w.made[0]?.fire("m.md");
    await vi.advanceTimersByTimeAsync(51);
    w.made[0]?.fire("m.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts.active).toBe(2);
  });

  it("a write that really changes the directory again after the first signal is a second signal, with the final counts", async () => {
    const { hub, w, seen, state } = setup();
    hub.watch("/p");
    state.set("s2", { open: 2 });
    w.made[0]?.fire("a.md");
    await vi.advanceTimersByTimeAsync(100);
    state.set("s3", { open: 1, done: 1 });
    w.made[0]?.fire("a.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.map((s) => s.counts.active)).toEqual([2, 1]);
    expect(seen.at(-1)?.counts).toMatchObject({ open: 1, done: 1 });
    expect(seen.map((s) => s.revision)).toEqual([2, 3]); // the attach snapshot was revision 1
  });

  it("an edit that moves no count (a body change) is still a change: the open window re-reads", async () => {
    const { hub, w, seen, state } = setup();
    hub.watch("/p");
    state.set("s2", { open: 1 }); // same counts, new signature (mtime or size moved)
    w.made[0]?.fire("a.md");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(1);
  });

  it("an outside edit through the watcher alone is one signal with the right counts", async () => {
    const { hub, w, seen, state } = setup();
    hub.watch("/p");
    state.set("s2", { open: 1, dismissed: 1 });
    w.made[0]?.fire("a.md");
    w.made[0]?.fire("a.md");
    w.made[0]?.fire(null); // a name-less event
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts).toMatchObject({ open: 1, dismissed: 1, active: 1 });
  });

  it("names that are not items never signal", async () => {
    const { hub, w, seen } = setup();
    hub.watch("/p");
    w.made[0]?.fire("notes.txt");
    w.made[0]?.fire(".DS_Store");
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toHaveLength(0);
  });

  it("a state already told is not told again, even after a quiet minute", async () => {
    const { hub, seen, state } = setup();
    state.set("s2", { open: 5 });
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(300);
    hub.noteWrite("/p");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(1);
  });

  it("releasing the last watch closes the watcher and stops the health check", async () => {
    const { hub, w, state } = setup();
    const release = hub.watch("/p");
    const first = w.made[0];
    release();
    expect(first?.closed).toBe(true);
    expect(hub.watchedCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300); // the one recount a new watch asks for
    const calls = state.scan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.made).toHaveLength(1); // nothing re-attached
    expect(state.scan.mock.calls.length).toBe(calls); // nothing counted
  });

  it("a watcher that errors is replaced on the next health check, and the recount does not signal by itself", async () => {
    const { hub, w, seen } = setup();
    hub.watch("/p");
    w.made[0]?.fail();
    expect(w.made[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(w.made).toHaveLength(2); // re-attached
    expect(seen).toHaveLength(0); // nothing changed, so nothing is said
  });

  describe("a directory replaced under the watch (what a branch checkout does)", () => {
    it("re-attaches to the new directory and says nothing when the contents are the same", async () => {
      const { hub, w, seen, setIno, state } = setup();
      hub.watch("/p");
      state.set("s2", { open: 1 });
      hub.noteWrite("/p");
      await vi.advanceTimersByTimeAsync(300); // the last signal left state s2
      expect(seen).toHaveLength(1);
      setIno(null); // removed
      await vi.advanceTimersByTimeAsync(70);
      setIno(2); // recreated
      await vi.advanceTimersByTimeAsync(400);
      expect(w.made).toHaveLength(2);
      expect(w.made[0]?.closed).toBe(true);
      expect(w.made[1]?.closed).toBe(false);
      expect(seen).toHaveLength(1); // same contents: no second signal
    });

    it("is exactly one signal when the contents differ, with the right final counts, however slowly it unfolds", async () => {
      const { hub, seen, setIno, state } = setup();
      hub.watch("/p");
      state.set("s2", { open: 1 });
      hub.noteWrite("/p");
      await vi.advanceTimersByTimeAsync(300);
      setIno(null);
      await vi.advanceTimersByTimeAsync(70);
      setIno(2);
      state.set("s3", { open: 3 }); // files appeared in the new directory
      await vi.advanceTimersByTimeAsync(400);
      expect(seen).toHaveLength(2);
      expect(seen.at(-1)?.counts.active).toBe(3);
      expect(seen.at(-1)?.revision).toBe(3); // snapshot 1, the first change 2, this one 3
    });

    it("the NEW directory's events signal", async () => {
      const { hub, w, seen, setIno, state } = setup();
      hub.watch("/p");
      setIno(null);
      await vi.advanceTimersByTimeAsync(70);
      setIno(2);
      await vi.advanceTimersByTimeAsync(300);
      state.set("s9", { open: 9 });
      w.made.at(-1)?.fire("m.md");
      await vi.advanceTimersByTimeAsync(300);
      expect(seen.at(-1)?.counts.active).toBe(9);
    });

    it("a directory that is gone (not yet recreated) is counted as empty and told once", async () => {
      const { hub, seen, setIno, state } = setup();
      hub.watch("/p");
      state.set("s2", { open: 1 });
      hub.noteWrite("/p");
      await vi.advanceTimersByTimeAsync(300);
      setIno(null);
      state.set("s0", {});
      await vi.advanceTimersByTimeAsync(600);
      expect(seen.at(-1)?.counts.active).toBe(0);
      expect(seen).toHaveLength(2);
    });
  });
});

// Real files and a real watcher: a SMOKE test that the pieces connect. Event
// timing belongs to the kernel and the machine's load, so nothing here counts
// signals; each waits (no fixed sleeps) for the signal that carries the right
// final counts and fails only if that never comes.
describe("real files, real watcher: the final counts arrive (smoke)", () => {
  async function until(seen: BacklogChange[], ok: (last: BacklogChange) => boolean, ms = 8000): Promise<BacklogChange> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const last = seen.at(-1);
      if (last && ok(last)) return last;
      await sleep(25);
    }
    throw new Error(`no matching signal in ${ms} ms; saw ${JSON.stringify(seen.map((s) => s.counts))}`);
  }
  const collect = (hub: ReturnType<typeof createBacklogLive>) => {
    const seen: BacklogChange[] = [];
    hub.subscribe(workDir, (c) => seen.push(c));
    return seen;
  };

  it("the tool path signals, with the new count", async () => {
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300 });
    setBacklogLiveForTests(hub);
    const seen = collect(hub);
    await addBacklogItem(workDir, { title: "parked by a tool", body: "b" });
    const last = await until(seen, (c) => c.counts.active === 1);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(last.counts.open).toBe(1);
  });

  it("with the watcher attached, tool writes end on the right counts", async () => {
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300 });
    setBacklogLiveForTests(hub);
    const release = hub.watch(workDir);
    try {
      const seen = collect(hub);
      await addBacklogItem(workDir, { title: "parked with a watcher", body: "b" });
      await setBacklogStatus(workDir, "parked-with-a-watcher", "done");
      const last = await until(seen, (c) => c.counts.done === 1 && c.counts.active === 0);
      expect(last.revision).toBeGreaterThanOrEqual(1);
    } finally {
      release();
    }
  });

  it("a hand edit of a file in .marvin/backlog arrives with no tool involved", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    await writeFile(join(dir, "b.md"), item("open", false, "b"));
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300 });
    await hub.snapshot(workDir);
    const release = hub.watch(workDir);
    try {
      const seen = collect(hub);
      await writeFile(join(dir, "a.md"), item("dismissed", false, "a-longer-id-so-size-moves"));
      await until(seen, (c) => c.counts.open === 1 && c.counts.dismissed === 1);
    } finally {
      release();
    }
  });

  it("files appearing from outside (a branch checkout) arrive", async () => {
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300 });
    const release = hub.watch(workDir);
    try {
      const seen = collect(hub);
      for (const n of ["p", "q", "r"]) await writeFile(join(dir, `${n}.md`), item("provisional", false, n));
      await until(seen, (c) => c.counts.provisional === 3);
    } finally {
      release();
    }
  });

  it("a directory removed and recreated is followed, and a write to the new one arrives", async () => {
    await writeFile(join(dir, "a.md"), item("open", false, "a"));
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300, healthMs: 50 });
    const release = hub.watch(workDir);
    try {
      const seen = collect(hub);
      await rm(dir, { recursive: true });
      await mkdir(dir);
      await writeFile(join(dir, "n.md"), item("open", false, "n"));
      await until(seen, (c) => c.counts.active === 1);
      await sleep(300); // let the re-attach settle, then write into the NEW directory
      await writeFile(join(dir, "m.md"), item("open", false, "m"));
      await until(seen, (c) => c.counts.active === 2);
    } finally {
      release();
    }
  });

  it("two watchers of one project share one watch, and the last release closes it", () => {
    const hub = createBacklogLive({ debounceMs: 40, maxWaitMs: 200 });
    const r1 = hub.watch(workDir);
    const r2 = hub.watch(workDir);
    expect(hub.watchedCount()).toBe(1);
    r1();
    expect(hub.watchedCount()).toBe(1);
    r2();
    expect(hub.watchedCount()).toBe(0);
  });

  it("the module-level noteBacklogWrite feeds the installed hub", async () => {
    const state = fakeState();
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300, scan: state.scan });
    setBacklogLiveForTests(hub);
    const seen = collect(hub); // the baseline reads state s1
    state.set("s2", { open: 4 });
    noteBacklogWrite(workDir);
    const last = await until(seen, (c) => c.counts.active === 4);
    expect(last.reason).toBe("change");
  });

  it("a classification edit signals too (the open window re-reads it)", async () => {
    await addBacklogItem(workDir, { title: "to classify", body: "b" });
    const hub = createBacklogLive({ debounceMs: 30, maxWaitMs: 300 });
    setBacklogLiveForTests(hub);
    const seen = collect(hub);
    await updateBacklogItem(workDir, "to-classify", { blocked: true, blockedOn: "legal" });
    await until(seen, (c) => c.counts.blocked === 1);
  });
});

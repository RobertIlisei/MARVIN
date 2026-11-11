import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slugifyWorkDir } from "../src/projects";
import { readLedger, supervisorDir } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import { approveEntries, holdEntry, type QueueEntry, type QueueEntryProposal, queuePath, readQueue, releaseEntry, setUserCap, updateQueue } from "../src/supervisor-queue";
import { acquireQueueLock, clearStaleQueueLocks, queueLockPath } from "../src/supervisor-queue-lock";
import { type OpenerDeps, QueueOpener } from "../src/supervisor-queue-opener";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";
import { announceProjectEvent, subscribeProjectEvents } from "../src/turn-registry";
import { createSessionWorktree, markSessionWorktreeClosed, reconcileWorktrees, sweepWorktrees } from "../src/worktrees";

// ADR-0133 — the runtime opens the queue, never the model; the cap is the
// user's; one opener per project; `after` reads the DERIVED merged state.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };
const proposal = (id: string, extra: Partial<QueueEntryProposal> = {}): QueueEntryProposal => ({ id, title: `Brief ${id}`, brief: `Do ${id}`, posture: POSTURE, wider: [], ...extra });
const approve = (...entries: QueueEntryProposal[]) => expect(approveEntries("proj", entries).ok).toBe(true);
const entryOf = (id: string) => readQueue("proj").entries.find((e) => e.id === id) as QueueEntry;
const lines = (verb?: string) => readLedger("proj").filter((l) => !verb || l.verb === verb);

interface Fake {
  deps: OpenerDeps;
  opened: QueueEntry[];
  tabs: { n: number };
  merged: Set<string>;
  inFlight: { now: number; max: number };
}
function fake(over: Partial<OpenerDeps> = {}): Fake {
  const f: Fake = { opened: [], tabs: { n: 0 }, merged: new Set(), inFlight: { now: 0, max: 0 }, deps: undefined as never };
  f.deps = {
    pid: 111,
    isAlive: () => true,
    now: () => Date.now(),
    workDirOf: () => "/work",
    supervisorRefusal: () => null,
    openTabCount: () => f.tabs.n,
    mergedBranches: async () => f.merged,
    diskRefusal: () => null,
    open: async (_p, _w, entry) => {
      f.inFlight.now += 1;
      f.inFlight.max = Math.max(f.inFlight.max, f.inFlight.now);
      await new Promise((r) => setTimeout(r, 2));
      f.inFlight.now -= 1;
      f.opened.push(entry);
      f.tabs.n += 1;
      return { ok: true, marvinSessionId: `tab-${entry.id}`, branch: `marvin/tab/${entry.id}` };
    },
    ...over,
  };
  return f;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-opener-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({ action: "start" });
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("invariant 1 — nothing the user did not approve opens", () => {
  it("a hand-written or model-written entry in queue.json never opens", async () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    const base = { title: "t", brief: "b", posture: POSTURE, wider: [], approvedAt: new Date().toISOString(), status: "queued" };
    writeFileSync(
      queuePath("proj"),
      JSON.stringify({ version: 1, cap: 5, entries: [{ ...base, id: "forged" }, { ...base, id: "model", approvedBy: "model" }, { ...base, id: "sup", approvedBy: "supervisor" }] }),
    );
    const f = fake();
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened).toEqual([]);
  });

  it("only an entry the user approved opens", async () => {
    approve(proposal("A"));
    const f = fake();
    expect((await new QueueOpener(f.deps).kick("proj"))?.opened).toEqual(["A"]);
    expect(f.opened.map((e) => e.approvedBy)).toEqual(["user"]);
  });
});

describe("invariant 2 — the runtime opens, no supervisor verb does", () => {
  it("none of the supervisor's verbs opens a queued tab, however it is called", async () => {
    const f = fake();
    const v = createSupervisorVerbs({
      projectId: "proj",
      workDir: dataDir,
      wakeId: "w",
      wake: { acts: 0 },
      limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
      deps: { listRows: async () => [], newTabBase: async () => ({ posture: POSTURE, baseRef: "main", baseSha: "x" }), modelLookup: async () => () => null, openTab: f.deps.open },
    } as unknown as VerbContext);
    act({ action: "autonomy", category: "posture", value: "autonomous" });
    await v.propose_queue({ entries: [{ id: "A", title: "t", brief: "b" }] });
    await v.propose_guard({ command: "true" });
    await v.lower_cap({ to: 0, reason: "alarm" });
    await v.restore_cap();
    await v.hold_queue_entry({ id: "A", reason: "x" });
    expect(f.opened).toEqual([]);
    expect(readQueue("proj").entries).toEqual([]);
    expect(Object.keys(v).filter((k) => /open|approve|release|reorder|raise/i.test(k))).toEqual([]);
  });
});

describe("invariant 3 — one opener per project", () => {
  it("a second opener (another live pid) cannot open; the first can", async () => {
    approve(proposal("A"));
    const a = fake({ pid: 111 });
    const b = fake({ pid: 222, isAlive: (pid) => pid === 111 });
    expect((await new QueueOpener(a.deps).kick("proj"))?.lock).toBe("ours");
    expect((await new QueueOpener(b.deps).kick("proj"))?.opened).toEqual([]);
    approve(proposal("B"));
    setUserCap("proj", 5);
    const second = await new QueueOpener(b.deps).kick("proj");
    expect(second).toMatchObject({ lock: "held", opened: [] });
    expect(b.opened).toEqual([]);
    expect(lines("queue.refused").some((l) => l.reasonCode === "lock-held")).toBe(true);
    expect((await new QueueOpener(a.deps).kick("proj"))?.opened).toEqual(["B"]);
  });

  it("the lock records the holder's pid", () => {
    expect(acquireQueueLock("proj", { pid: 4242 })).toBe("ours");
    expect(JSON.parse(readFileSync(queueLockPath("proj"), "utf8")).pid).toBe(4242);
  });

  it("a lock whose pid is gone is cleared at boot, and a live one is left", () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    writeFileSync(queueLockPath("proj"), JSON.stringify({ pid: 999999 }));
    expect(clearStaleQueueLocks((pid) => pid !== 999999, 1)).toEqual(["proj"]);
    writeFileSync(queueLockPath("proj"), JSON.stringify({ pid: 555 }));
    expect(clearStaleQueueLocks(() => true, 1)).toEqual([]);
    // Our own pid from an earlier life is stale too.
    writeFileSync(queueLockPath("proj"), JSON.stringify({ pid: 1 }));
    expect(clearStaleQueueLocks(() => true, 1)).toEqual(["proj"]);
  });

  it("a stale lock does not hold the queue shut", async () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    writeFileSync(queueLockPath("proj"), JSON.stringify({ pid: 999999 }));
    approve(proposal("A"));
    const f = fake({ pid: 111, isAlive: (pid) => pid === 111 });
    expect((await new QueueOpener(f.deps).kick("proj"))?.opened).toEqual(["A"]);
  });

  it("bootSupervisor clears a lock whose pid is gone", () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    writeFileSync(queueLockPath("proj"), JSON.stringify({ pid: 2147483646 }));
    bootSupervisor();
    expect(existsSync(queueLockPath("proj"))).toBe(false);
  });
});

describe("invariant 4 — the cap is the user's", () => {
  it("holds under a burst of triggers: ten concurrent kicks, never more than the cap, never two openings at once", async () => {
    approve(...["A", "B", "C", "D", "E"].map((id) => proposal(id)));
    const f = fake();
    setUserCap("proj", 2);
    const o = new QueueOpener(f.deps);
    await Promise.all(Array.from({ length: 10 }, () => o.kick("proj")));
    expect(f.opened.map((e) => e.id)).toEqual(["A", "B"]);
    expect(f.inFlight.max).toBe(1);
    expect(entryOf("C").blocked).toMatchObject({ code: "cap" });
  });

  it("counts a tab the user opened by hand: the default cap is 1", async () => {
    approve(proposal("A"));
    const f = fake();
    f.tabs.n = 1;
    expect((await new QueueOpener(f.deps).kick("proj"))?.opened).toEqual([]);
    expect(entryOf("A").blocked).toMatchObject({ code: "cap", reason: expect.stringContaining("1 tab open, cap 1") });
    f.tabs.n = 0;
    expect((await new QueueOpener(f.deps).kick("proj"))?.opened).toEqual(["A"]);
  });

  it("the supervisor lowers the cap and restores it, both ledgered; raising is refused", async () => {
    setUserCap("proj", 3);
    act({ action: "autonomy", category: "posture", value: "autonomous" });
    const v = createSupervisorVerbs({
      projectId: "proj",
      workDir: dataDir,
      wakeId: "w",
      wake: { acts: 0 },
      limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
      deps: { listRows: async () => [] },
    } as unknown as VerbContext);
    expect(await v.lower_cap({ to: 5, reason: "alarm" })).toMatch(/never raise/);
    expect(await v.lower_cap({ to: 3, reason: "alarm" })).toMatch(/never raise/);
    expect(readQueue("proj").capLowered).toBeNull();
    expect(await v.lower_cap({ to: 1, reason: "test machine unreachable" })).toMatch(/Lowered the cap from 3 to 1/);
    expect(readQueue("proj")).toMatchObject({ cap: 3, capLowered: { to: 1, reason: "test machine unreachable" } });
    // While lowered, even a raise back up to the user's number is a raise.
    expect(await v.lower_cap({ to: 2, reason: "x" })).toMatch(/never raise/);
    approve(proposal("A"), proposal("B"));
    const f = fake();
    expect((await new QueueOpener(f.deps).kick("proj"))?.opened).toEqual(["A"]);
    expect(await v.restore_cap()).toMatch(/Restored the cap to the user.s 3/);
    expect(readQueue("proj").capLowered).toBeNull();
    expect(await v.restore_cap()).toMatch(/not lowered/);
    expect(lines("lower_cap").map((l) => l.decision)).toEqual(["refuse", "refuse", "act", "refuse"]);
    expect(lines("restore_cap").map((l) => l.decision)).toEqual(["act", "refuse"]);
  });

  it("in shadow the supervisor's lowering is a proposal and changes nothing", async () => {
    setUserCap("proj", 3);
    const v = createSupervisorVerbs({ projectId: "proj", workDir: dataDir, wakeId: "w", wake: { acts: 0 }, limiter: new ActionLimiter(() => getSupervisorState("proj").caps), deps: { listRows: async () => [] } } as unknown as VerbContext);
    expect(await v.lower_cap({ to: 0, reason: "alarm" })).toMatch(/proposal/);
    expect(readQueue("proj").capLowered).toBeNull();
  });

  it("the queue never closes a tab to make room: it has no way to (an over-cap project simply waits)", async () => {
    approve(proposal("A"));
    const f = fake();
    f.tabs.n = 4;
    await new QueueOpener(f.deps).kick("proj");
    expect(f.tabs.n).toBe(4);
    expect(f.opened).toEqual([]);
  });
});

describe("invariant 6 — one entry, one tab, at the approved posture", () => {
  it("opens through the injected atomic path with the entry's own approved posture and brief, once", async () => {
    const posture = { ...POSTURE, model: "claude-opus-5-5" };
    approve(proposal("A", { posture, wider: ["model"] }));
    const f = fake();
    await new QueueOpener(f.deps).kick("proj");
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({ id: "A", brief: "Do A", posture });
    expect(entryOf("A")).toMatchObject({ status: "opened", openedSessionId: "tab-A", openedBranch: "marvin/tab/A" });
  });

  it("a refusal before the worktree existed holds the entry with the reason and retries; one after never reopens", async () => {
    approve(proposal("A"), proposal("B"));
    let n = 0;
    const f = fake({
      open: async (_p, _w, e) => {
        n += 1;
        if (e.id === "A" && n === 1) return { ok: false, code: "worktree-failed", error: "no disk", tabExists: false };
        if (e.id === "B") return { ok: false, code: "no-first-message", error: "refused", tabExists: true };
        return { ok: true, marvinSessionId: "tab-A", branch: "marvin/tab/A" };
      },
    });
    await new QueueOpener(f.deps).kick("proj");
    expect(entryOf("A")).toMatchObject({ status: "queued", blocked: { code: "worktree-failed" } });
    const o = new QueueOpener(f.deps);
    await o.kick("proj");
    expect(entryOf("A").status).toBe("opened");
    await o.kick("proj");
    expect(entryOf("B")).toMatchObject({ status: "failed" });
    expect(n).toBe(3);
  });

  it("an opening interrupted by a crash is held for the user, never opened again on its own", async () => {
    approve(proposal("A"));
    updateQueue("proj", "opening", (q) => {
      (q.entries[0] as QueueEntry).status = "opening";
    });
    const f = fake();
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened).toEqual([]);
    expect(entryOf("A")).toMatchObject({ status: "failed", blocked: { code: "interrupted" } });
  });
});

describe("the supervisor off or paused holds the queue", () => {
  it("says why on every pending entry and opens nothing", async () => {
    approve(proposal("A"));
    const f = fake({ supervisorRefusal: () => "the supervisor is paused" });
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened).toEqual([]);
    expect(entryOf("A").blocked).toMatchObject({ code: "supervisor" });
  });
  it("the disk floor holds an entry with its reason", async () => {
    approve(proposal("A"));
    const f = fake({ diskRefusal: () => "free disk space is below the worktree floor" });
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened).toEqual([]);
    expect(entryOf("A").blocked).toMatchObject({ code: "disk" });
  });
});

describe("invariant 7 — `after` waits for the DERIVED merged state", () => {
  it("holds B until A's branch reads merged, then opens it", async () => {
    approve(proposal("A"), proposal("B", { after: ["A"] }));
    const f = fake();
    setUserCap("proj", 5);
    const o = new QueueOpener(f.deps);
    await o.kick("proj");
    expect(f.opened.map((e) => e.id)).toEqual(["A"]);
    expect(entryOf("B").blocked).toMatchObject({ code: "after", reason: expect.stringContaining("marvin/tab/A") });
    f.merged.add("marvin/tab/A");
    await o.kick("proj");
    expect(f.opened.map((e) => e.id)).toEqual(["A", "B"]);
  });

  it("an entry the supervisor held is skipped, an independent one behind it still opens, and only the user releases", async () => {
    approve(proposal("A"), proposal("B"));
    setUserCap("proj", 5);
    expect(holdEntry("proj", "A", "the plan deferred it").ok).toBe(true);
    const f = fake();
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened.map((e) => e.id)).toEqual(["B"]);
    expect(entryOf("A").blocked).toMatchObject({ code: "held", reason: expect.stringContaining("the plan deferred it") });
    expect(releaseEntry("proj", "A")).toBe(true);
    await new QueueOpener(f.deps).kick("proj");
    expect(f.opened.map((e) => e.id)).toEqual(["B", "A"]);
  });

  it("with real git: a branch merged in a terminal reads merged, and a sweep keeps it until its successor opens", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "marvin-after-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const wt = createSessionWorktree(repo, { sessionId: "s-a", title: "tab a" });
    writeFileSync(path.join(wt.path, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: wt.path });
    execFileSync("git", ["commit", "-qm", "a"], { cwd: wt.path });
    const projectId = slugifyWorkDir(repo);
    approveEntries(projectId, [proposal("A"), proposal("B", { after: ["A"] })]);
    updateQueue(projectId, "opened", (q) => {
      Object.assign(q.entries[0] as QueueEntry, { status: "opened", openedBranch: wt.branch, openedSessionId: "s-a" });
    });
    const later = Date.now() + 48 * 3_600_000;
    expect(reconcileWorktrees(repo, later).find((w) => w.branch === wt.branch)?.state).not.toBe("merged");
    git("merge", "-q", "--no-ff", "-m", "integrate", wt.branch); // the user merges in a terminal
    markSessionWorktreeClosed(repo, "s-a"); // and the tab is closed
    expect(reconcileWorktrees(repo, later).find((w) => w.branch === wt.branch)?.state).toBe("merged");
    // The tab closed; the sweep would reclaim a merged branch — but B still waits on it.
    sweepWorktrees(repo, later);
    expect(git("branch", "--list", wt.branch)).toContain(wt.branch);
    expect(reconcileWorktrees(repo, later).find((w) => w.branch === wt.branch)?.state).toBe("merged");
    // Once B has opened, the branch is ordinary again and is reclaimed.
    updateQueue(projectId, "opened", (q) => {
      (q.entries[1] as QueueEntry).status = "opened";
    });
    sweepWorktrees(repo, later);
    expect(git("branch", "--list", wt.branch)).toBe("");
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("woken by the project event stream, never a timer", () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("an approval opens the entry; a closing tab frees the slot for the next; the opener's own bookkeeping wakes nothing", async () => {
    const f = fake();
    const o = new QueueOpener(f.deps);
    o.start(subscribeProjectEvents);
    try {
      approve(proposal("A"), proposal("B"));
      await settle();
      expect(f.opened.map((e) => e.id)).toEqual(["A"]);
      // B waits for a slot: nothing else happens until an event says one may have freed.
      await settle();
      expect(f.opened.map((e) => e.id)).toEqual(["A"]);
      f.tabs.n = 0;
      announceProjectEvent({ event: "session.closed", data: { marvinSessionId: "tab-A", projectId: "proj" } });
      await settle();
      expect(f.opened.map((e) => e.id)).toEqual(["A", "B"]);
    } finally {
      o.stop();
    }
  });

  it("a branch merged in a terminal is noticed on the next event (turn ended anywhere in the project)", async () => {
    const f = fake();
    setUserCap("proj", 5);
    approve(proposal("A"), proposal("B", { after: ["A"] }));
    const o = new QueueOpener(f.deps);
    o.start(subscribeProjectEvents);
    try {
      await settle();
      expect(f.opened.map((e) => e.id)).toEqual(["A"]);
      f.merged.add("marvin/tab/A");
      announceProjectEvent({ event: "turn.ended", data: { marvinSessionId: "other", projectId: "proj", turnId: "t", outcome: "completed" } });
      await settle();
      expect(f.opened.map((e) => e.id)).toEqual(["A", "B"]);
    } finally {
      o.stop();
    }
  });
});

describe("invariant 10 — everything the opener does or refuses is in the ledger", () => {
  it("writes an opened line naming the tab, and a refused line naming the reason", async () => {
    approve(proposal("A"), proposal("B"));
    const f = fake({
      open: async (_p, _w, e) => (e.id === "A" ? { ok: true, marvinSessionId: "tab-A", branch: "marvin/tab/A" } : { ok: false, code: "worktree-failed", error: "disk", tabExists: false }),
    });
    setUserCap("proj", 5);
    await new QueueOpener(f.deps).kick("proj");
    expect(lines("queue.opened")).toMatchObject([{ tab: "tab-A", decision: "act", reasonCode: "approved-queue" }]);
    expect(lines("queue.refused")).toMatchObject([{ decision: "refuse", reasonCode: "worktree-failed", reason: expect.stringContaining("disk") }]);
  });
});

// ADR-0130 addendum (2026-11-24) — the watch row's `waitingOn` carries the
// honest clock (`waitingSince`), how many things the tab waits on (`jobs`) and
// a structural `cause`; the response carries the sidecar's own start time.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __setJobsFileForTests, startBackgroundJob } from "../src/background-jobs";
import { updateSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { __resetSessionDiffMemoForTests, buildSessionWatch, ownWaitsOf, sidecarStartedAt } from "../src/session-watch";
import { __resetSchedulerForTests, enqueueWakeup, type WakeupRecord } from "../src/wakeup-scheduler";

const projectId = "wait-proj";
const posture = { model: "m", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function wakeup(over: Partial<WakeupRecord> & { id: string; marvinSessionId: string }): WakeupRecord {
  return {
    projectId,
    cwd: process.cwd(),
    model: "m",
    advisorModel: null,
    personality: "ultron",
    permissionStrategy: "auto",
    thinkingMode: "high",
    prompt: "p",
    reason: "gated commit: baseline",
    createdAt: ago(3),
    fireAt: Date.now() + 3_600_000,
    depth: 1,
    ...over,
  };
}

describe("watch row waitingOn — the honest wait clock", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-watch-wait-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    __setJobsFileForTests(join(dataDir, "jobs.json"));
    __resetSessionDiffMemoForTests();
    for (const id of ["a", "b", "c", "d"]) upsertSessionMeta(projectId, id, { workDir: dataDir, tree: { mode: "shared" }, posture });
  });
  afterEach(() => {
    __resetSchedulerForTests();
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const row = async (id: string) => (await buildSessionWatch({ projectId, workDir: dataDir, sessionIds: [id] }))[0]!;

  it("keeps `since` (this wait) and reports the stretch as `waitingSince`, the wait as one job", async () => {
    const stretchStart = ago(13);
    updateSessionMeta(projectId, "a", { waitStretch: { since: stretchStart } });
    enqueueWakeup(wakeup({ id: "w1", marvinSessionId: "a", createdAt: ago(3) }));
    const w = (await row("a")).waitingOn!;
    expect(w.kind).toBe("wakeup");
    expect(Date.parse(w.since)).toBeGreaterThan(Date.parse(stretchStart));
    expect(w.waitingSince).toBe(stretchStart);
    expect(w.jobs).toBe(1);
    expect(w.cause).toBeUndefined();
  });

  it("without a recorded stretch (a tab already waiting when this landed) waitingSince is this wait's start", async () => {
    const createdAt = ago(3);
    enqueueWakeup(wakeup({ id: "w2", marvinSessionId: "b", createdAt }));
    const w = (await row("b")).waitingOn!;
    expect(w.waitingSince).toBe(createdAt);
    expect(w.jobs).toBe(1);
  });

  it("a stretch that starts after this wait never makes waitingSince later than since", async () => {
    const createdAt = ago(30);
    updateSessionMeta(projectId, "b", { waitStretch: { since: ago(2) } });
    enqueueWakeup(wakeup({ id: "w3", marvinSessionId: "b", createdAt }));
    expect((await row("b")).waitingOn!.waitingSince).toBe(createdAt);
  });

  it("counts every pending job and own wakeup, and ignores a supervisor's wakeup", async () => {
    enqueueWakeup(wakeup({ id: "w4", marvinSessionId: "c" }));
    enqueueWakeup(wakeup({ id: "w5", marvinSessionId: "c", reason: "check back" }));
    enqueueWakeup(wakeup({ id: "w6", marvinSessionId: "c", author: "supervisor" } as Partial<WakeupRecord> & { id: string; marvinSessionId: string }));
    const res = startBackgroundJob({
      command: "sleep 30",
      reason: "gate",
      ctx: { marvinSessionId: "c", projectId, cwd: process.cwd(), model: "m", advisorModel: null, personality: "marvin", permissionStrategy: "auto", thinkingMode: "high", depth: 0 },
    });
    expect(res.ok).toBe(true);
    try {
      const w = (await row("c")).waitingOn!;
      expect(w.kind).toBe("job");
      expect(w.jobs).toBe(3);
    } finally {
      if (res.ok) process.kill(res.pid, "SIGKILL");
    }
  });

  it("a wakeup recovery re-created carries cause 'restart'; the stretch's cause reaches a wait the model armed afterwards", async () => {
    enqueueWakeup(wakeup({ id: "w7", marvinSessionId: "d", cause: "restart", reason: "background job interrupted: gate" }));
    expect((await row("d")).waitingOn!.cause).toBe("restart");
    __resetSchedulerForTests();
    updateSessionMeta(projectId, "a", { waitStretch: { since: ago(20), cause: "restart" } });
    enqueueWakeup(wakeup({ id: "w8", marvinSessionId: "a", reason: "gated commit rerun after restart: baseline" }));
    expect((await row("a")).waitingOn!.cause).toBe("restart");
  });

  it("a row that waits on nothing has no waitingOn", async () => {
    expect((await row("a")).waitingOn).toBeNull();
  });
});

describe("ownWaitsOf", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-own-waits-"));
    process.env.MARVIN_DATA_DIR = dataDir;
  });
  afterEach(() => {
    __resetSchedulerForTests();
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });
  it("counts the session's own waits and names the earliest start; a supervisor's wakeup is not one", () => {
    const early = ago(40);
    enqueueWakeup(wakeup({ id: "o1", marvinSessionId: "x", createdAt: ago(5) }));
    enqueueWakeup(wakeup({ id: "o2", marvinSessionId: "x", createdAt: early }));
    enqueueWakeup(wakeup({ id: "o3", marvinSessionId: "x", createdAt: ago(60), author: "supervisor" } as Partial<WakeupRecord> & { id: string; marvinSessionId: string }));
    expect(ownWaitsOf(projectId, "x")).toEqual({ count: 2, since: early });
    expect(ownWaitsOf(projectId, "nobody")).toEqual({ count: 0, since: null });
  });
});

describe("sidecarStartedAt", () => {
  it("is when this process started: an ISO time in the past, stable between calls", () => {
    const t = sidecarStartedAt();
    expect(Date.parse(t)).toBeLessThanOrEqual(Date.now());
    expect(sidecarStartedAt()).toBe(t);
  });
});

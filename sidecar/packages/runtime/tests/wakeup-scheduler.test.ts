import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { marvinPaths } from "../src/paths";
import {
  MAX_CHAIN_DEPTH,
  MAX_PENDING_PER_SESSION,
  type WakeupRecord,
  __resetSchedulerForTests,
  armAll,
  cancelWakeup,
  listWakeups,
  scheduleWakeup,
  setWakeupFireHandler,
} from "../src/wakeup-scheduler";

// The scheduler is the mechanism that makes MARVIN's "I'll check back"
// promise real (ADR-0031). These tests pin the bounds (delay clamp, per-
// session cap, chain-depth guard) and the boot re-arm semantics (future
// stays armed, past-due fires once, >24 h is dropped) — the rails that keep
// a self-scheduling assistant from becoming a runaway loop.

const SESSION = "sess-1";
const PROJECT = "proj-1";

function baseInput(over: Partial<Parameters<typeof scheduleWakeup>[0]> = {}) {
  return {
    marvinSessionId: SESSION,
    projectId: PROJECT,
    cwd: "/tmp/project",
    model: "claude-opus-4-8",
    advisorModel: null,
    personality: "marvin" as const,
    permissionStrategy: "auto" as const,
    thinkingMode: "high",
    delaySeconds: 600,
    reason: "check build",
    prompt: "Check the build status.",
    schedulingDepth: 0,
    ...over,
  };
}

/** Write a persisted wakeup file directly (to forge past/stale fireAt). */
function writeWakeupFile(projectId: string, records: WakeupRecord[]): void {
  const file = marvinPaths.wakeupsFile(projectId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ wakeups: records }, null, 2));
}

function record(over: Partial<WakeupRecord> = {}): WakeupRecord {
  return {
    id: "fixed-id",
    marvinSessionId: SESSION,
    projectId: PROJECT,
    cwd: "/tmp/project",
    model: "claude-opus-4-8",
    advisorModel: null,
    personality: "marvin",
    permissionStrategy: "auto",
    thinkingMode: "high",
    prompt: "Check the build.",
    reason: "check build",
    createdAt: new Date().toISOString(),
    fireAt: Date.now() + 600_000,
    depth: 1,
    ...over,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "marvin-wakeups-"));
  process.env.MARVIN_DATA_DIR = dir;
  __resetSchedulerForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetSchedulerForTests();
  vi.useRealTimers();
  delete process.env.MARVIN_DATA_DIR;
});

describe("scheduleWakeup — validation", () => {
  it("schedules and persists a valid wakeup", () => {
    const res = scheduleWakeup(baseInput());
    expect(res.ok).toBe(true);
    const pending = listWakeups({ marvinSessionId: SESSION });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe("check build");
    expect(pending[0]?.depth).toBe(1);
    // persisted to disk
    expect(existsSync(marvinPaths.wakeupsFile(PROJECT))).toBe(true);
  });

  it("rejects a delay below the 60 s floor", () => {
    const res = scheduleWakeup(baseInput({ delaySeconds: 30 }));
    expect(res.ok).toBe(false);
    expect(listWakeups()).toHaveLength(0);
  });

  it("rejects a delay above the 24 h ceiling", () => {
    const res = scheduleWakeup(baseInput({ delaySeconds: 100_000 }));
    expect(res.ok).toBe(false);
  });

  it("enforces the per-session pending cap", () => {
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      expect(scheduleWakeup(baseInput()).ok).toBe(true);
    }
    const overflow = scheduleWakeup(baseInput());
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toMatch(/cap/);
  });

  it("enforces the chain-depth guard", () => {
    // schedulingDepth at the ceiling means nextDepth would exceed the cap.
    const res = scheduleWakeup(baseInput({ schedulingDepth: MAX_CHAIN_DEPTH }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/depth/);
  });

  it("cancels a pending wakeup", () => {
    const res = scheduleWakeup(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(cancelWakeup(res.record.id, PROJECT)).toBe(true);
    expect(listWakeups()).toHaveLength(0);
  });
});

describe("scheduleWakeup — firing", () => {
  it("fires a real turn after the delay and clears itself from disk", async () => {
    const fired: WakeupRecord[] = [];
    setWakeupFireHandler((r) => {
      fired.push(r);
    });
    const res = scheduleWakeup(baseInput({ delaySeconds: 600 }));
    expect(res.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(600_000);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.reason).toBe("check build");
    // removed from disk so it can't double-fire on next boot
    expect(listWakeups()).toHaveLength(0);
  });
});

describe("armAll — boot re-arm", () => {
  it("re-arms a future wakeup without firing it", async () => {
    writeWakeupFile(PROJECT, [record({ fireAt: Date.now() + 600_000 })]);
    const fired: WakeupRecord[] = [];
    setWakeupFireHandler((r) => void fired.push(r));

    const stats = armAll();
    expect(stats.armed).toBe(1);
    expect(stats.firedImmediately).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toHaveLength(0); // not yet due
    expect(listWakeups()).toHaveLength(1);
  });

  it("fires a past-due wakeup exactly once", async () => {
    writeWakeupFile(PROJECT, [record({ fireAt: Date.now() - 5_000 })]);
    const fired: WakeupRecord[] = [];
    setWakeupFireHandler((r) => void fired.push(r));

    const stats = armAll();
    expect(stats.firedImmediately).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toHaveLength(1);
    expect(listWakeups()).toHaveLength(0);
  });

  it("drops a stale (>24 h past-due) wakeup without firing", async () => {
    writeWakeupFile(PROJECT, [
      record({ fireAt: Date.now() - 25 * 60 * 60 * 1000 }),
    ]);
    const fired: WakeupRecord[] = [];
    setWakeupFireHandler((r) => void fired.push(r));

    const stats = armAll();
    expect(stats.dropped).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toHaveLength(0);
    expect(listWakeups()).toHaveLength(0);
    // file rewritten without the stale record
    const onDisk = JSON.parse(
      readFileSync(marvinPaths.wakeupsFile(PROJECT), "utf-8"),
    );
    expect(onDisk.wakeups).toHaveLength(0);
  });

  it("is idempotent — a second armAll is a no-op", () => {
    writeWakeupFile(PROJECT, [record({ fireAt: Date.now() + 600_000 })]);
    setWakeupFireHandler(() => {});
    armAll();
    const second = armAll();
    expect(second).toEqual({ armed: 0, firedImmediately: 0, dropped: 0 });
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetBackgroundJobsForTests,
  cancelBackgroundJob,
  listBackgroundJobs,
  startBackgroundJob,
} from "../src/background-jobs";
import {
  __resetSchedulerForTests,
  setWakeupFireHandler,
  type WakeupRecord,
} from "../src/wakeup-scheduler";

// ADR-0038: a background job's process EXIT fires a real follow-up turn via
// the shared wakeup fire handler — an event-triggered wakeup. These pin the
// exit→turn dispatch, the success/failure framing, that a cancel fires
// nothing, and the concurrency cap.

const ctx = {
  marvinSessionId: "sess",
  projectId: "proj",
  cwd: process.cwd(),
  model: "m",
  advisorModel: null,
  personality: "marvin" as const,
  permissionStrategy: "auto" as const,
  thinkingMode: "high",
  depth: 0,
};

afterEach(() => {
  __resetBackgroundJobsForTests();
  __resetSchedulerForTests();
});

function onNextFire(): Promise<WakeupRecord> {
  return new Promise((resolve) => {
    setWakeupFireHandler((rec) => resolve(rec));
  });
}

describe("background-job completion wakeup", () => {
  it("a finished job fires a completion turn with the command, exit code, and output tail", async () => {
    const fired = onNextFire();
    const res = startBackgroundJob({ command: "echo marvin-job-ok", reason: "test", ctx });
    expect(res.ok).toBe(true);
    const rec = await fired;
    expect(rec.prompt).toContain("echo marvin-job-ok");
    expect(rec.prompt).toContain("exit code 0");
    expect(rec.prompt).toContain("marvin-job-ok"); // captured output tail
    expect(rec.depth).toBe(1); // one deeper than the starting turn (chain guard)
    expect(rec.permissionStrategy).toBe("auto"); // posture inherited
  });

  it("a job whose output outgrows the window reports head + tail with the cut named", async () => {
    const fired = onNextFire();
    // ~6 KB in the middle, with a distinctive first and last line.
    startBackgroundJob({
      command: "echo FIRST-LINE; yes filler | head -c 6000; echo; echo LAST-LINE",
      reason: "big",
      ctx,
    });
    const rec = await fired;
    expect(rec.prompt).toContain("FIRST-LINE");
    expect(rec.prompt).toContain("LAST-LINE");
    expect(rec.prompt).toMatch(/…\[\d+ bytes elided\]…/);
    // The whole point — bounded regardless of how much the job printed.
    expect(rec.prompt.length).toBeLessThan(4500);
  });

  it("a successful job wakes the session one effort rung down; a failed one keeps the ceiling", async () => {
    const okFired = onNextFire();
    startBackgroundJob({ command: "true", reason: "ok", ctx: { ...ctx, model: "claude-opus-5", thinkingMode: "max" } });
    const ok = await okFired;
    expect(ok.effort).toBe("xhigh");

    const failFired = onNextFire();
    startBackgroundJob({ command: "exit 2", reason: "fail", ctx: { ...ctx, model: "claude-opus-5", thinkingMode: "max" } });
    const failed = await failFired;
    expect(failed.effort).toBeUndefined();
  });

  it("a failing job's completion turn frames it as a failure", async () => {
    const fired = onNextFire();
    startBackgroundJob({ command: "exit 3", reason: "fail", ctx });
    const rec = await fired;
    expect(rec.prompt).toContain("exit code 3");
    expect(rec.prompt).toMatch(/did NOT succeed/i);
  });

  it("a cancelled job fires NO completion turn", async () => {
    let fired = false;
    setWakeupFireHandler(() => {
      fired = true;
    });
    const res = startBackgroundJob({ command: "sleep 5", reason: "long", ctx });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(listBackgroundJobs("sess")).toHaveLength(1);
      cancelBackgroundJob(res.id);
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(fired).toBe(false);
    expect(listBackgroundJobs("sess")).toHaveLength(0);
  });

  it("a job killed by SIGTERM (app shutdown, NOT the cancel tool) fires NO completion turn", async () => {
    // ADR-0038 follow-up: when the app quits, the sidecar is SIGTERM'd and its
    // child jobs die by signal — but `cancelled` is false (no one called the
    // cancel tool). Without the STOP_SIGNALS guard this fired a spurious
    // "killed by signal SIGTERM — did NOT succeed" turn that resurfaced on
    // every relaunch.
    let fired = false;
    setWakeupFireHandler(() => {
      fired = true;
    });
    const res = startBackgroundJob({ command: "sleep 5", reason: "dev server", ctx });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Kill the job directly, the way an OS/app shutdown would — NOT via
      // cancelBackgroundJob (which sets `cancelled`).
      process.kill(res.pid, "SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 800));
    expect(fired).toBe(false);
  });

  it("a job killed by SIGSEGV (genuine crash) DOES fire a failure turn", async () => {
    // The STOP_SIGNALS guard is scoped to shutdown-shaped signals; a real
    // crash signal must still notify — the user needs to diagnose it.
    const fired = onNextFire();
    const res = startBackgroundJob({ command: "sleep 5", reason: "crasher", ctx });
    expect(res.ok).toBe(true);
    if (res.ok) {
      process.kill(res.pid, "SIGSEGV");
    }
    const rec = await fired;
    expect(rec.prompt).toContain("killed by signal SIGSEGV");
    expect(rec.prompt).toMatch(/did NOT succeed/i);
  });

  it("enforces the per-session concurrency cap", () => {
    const ok = [1, 2, 3].map((n) =>
      startBackgroundJob({ command: "sleep 5", reason: `${n}`, ctx }),
    );
    expect(ok.every((r) => r.ok)).toBe(true);
    const overflow = startBackgroundJob({ command: "sleep 5", reason: "4", ctx });
    expect(overflow.ok).toBe(false);
  });
});

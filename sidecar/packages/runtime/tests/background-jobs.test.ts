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

  it("enforces the per-session concurrency cap", () => {
    const ok = [1, 2, 3].map((n) =>
      startBackgroundJob({ command: "sleep 5", reason: `${n}`, ctx }),
    );
    expect(ok.every((r) => r.ok)).toBe(true);
    const overflow = startBackgroundJob({ command: "sleep 5", reason: "4", ctx });
    expect(overflow.ok).toBe(false);
  });
});

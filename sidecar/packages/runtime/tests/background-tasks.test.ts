import { describe, expect, it } from "vitest";

import { BackgroundTaskLedger, backgroundTasksPayload } from "../src/background-tasks";

// ADR-0080 — background subagents outlive the main turn's `result`. The
// ledger is what stops `runAgent` from closing the channel and arming the
// kill-watchdog while a scout is still working.

const task = (id: string, desc = "scout: survey auth") => ({
  task_id: id,
  task_type: "local_agent",
  description: desc,
});

describe("BackgroundTaskLedger", () => {
  it("starts idle — a turn with no dispatch keeps today's terminal-result behaviour", () => {
    const l = new BackgroundTaskLedger();
    expect(l.hasLive).toBe(false);
    expect(l.live).toBe(0);
  });

  it("uses REPLACE semantics: a payload is the whole live set, not a delta", () => {
    const l = new BackgroundTaskLedger();
    l.replace([task("a"), task("b")]);
    expect(l.live).toBe(2);
    // The SDK reports the set after `a` finished. `a` must not linger.
    l.replace([task("b")]);
    expect(l.live).toBe(1);
    expect(l.describe()).toBe("local_agent:scout: survey auth");
    l.replace([]);
    expect(l.hasLive).toBe(false);
  });

  it("a missed bookend cannot wedge a stale 'still running'", () => {
    const l = new BackgroundTaskLedger();
    l.replace([task("a")]);
    // No task_notification for `a` ever arrives — only the level signal.
    l.replace([]);
    expect(l.hasLive).toBe(false);
  });
});

describe("backgroundTasksPayload", () => {
  it("recognises the SDK's level signal and nothing else", () => {
    expect(
      backgroundTasksPayload({ type: "system", subtype: "background_tasks_changed", tasks: [task("x")] }),
    ).toEqual([task("x")]);
    expect(backgroundTasksPayload({ type: "system", subtype: "task_started", task_id: "x" })).toBeNull();
    expect(backgroundTasksPayload({ type: "result", subtype: "success" })).toBeNull();
    expect(backgroundTasksPayload(null)).toBeNull();
  });

  it("tolerates a malformed payload as 'nothing live' rather than throwing", () => {
    expect(backgroundTasksPayload({ type: "system", subtype: "background_tasks_changed" })).toEqual([]);
    expect(
      backgroundTasksPayload({ type: "system", subtype: "background_tasks_changed", tasks: [null, {}, task("ok")] }),
    ).toEqual([task("ok")]);
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { BackgroundDrainBound } from "../src/background-tasks";

describe("BackgroundDrainBound — silence, not elapsed time", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires only after a full bound of silence; every event restarts the clock", () => {
    // 2026-09-13: two turns aborted fifteen minutes after a deferred result
    // while the model was mid-edit. The bound must not fire while events
    // keep arriving.
    const fired = vi.fn();
    const b = new BackgroundDrainBound(1000);
    b.arm(fired);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(900);
      b.touch();
    }
    expect(fired).not.toHaveBeenCalled();
    expect(b.armed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(b.armed).toBe(false);
  });

  it("clears when the ledger drains, and a second arm while armed keeps the running clock", () => {
    const fired = vi.fn();
    const b = new BackgroundDrainBound(1000);
    b.arm(fired);
    vi.advanceTimersByTime(600);
    b.arm(fired); // a second deferred result: same wait, not a fresh one
    vi.advanceTimersByTime(600);
    expect(fired).toHaveBeenCalledTimes(1);
    const c = new BackgroundDrainBound(1000);
    c.arm(fired);
    c.clear(); // advisor settled — nothing left to wait for
    vi.advanceTimersByTime(5000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(c.armed).toBe(false);
  });

  it("touch and clear are no-ops when not armed", () => {
    const b = new BackgroundDrainBound(1000);
    b.touch();
    b.clear();
    expect(b.armed).toBe(false);
  });
});

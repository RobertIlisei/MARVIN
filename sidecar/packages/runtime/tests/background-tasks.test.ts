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

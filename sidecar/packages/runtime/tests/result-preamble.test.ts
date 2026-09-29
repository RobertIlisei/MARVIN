import { describe, expect, it } from "vitest";

import { isPreambleResult, PREAMBLE_RESULT_GRACE_MS } from "../src/result-preamble";

// 2026-09-29: a background job's completion turn opened with the SDK
// delivering a `task_notification` from an earlier turn, answered by an empty
// `result` (num_turns 0) BEFORE the model saw the prompt. The runner took that
// result as the end of the turn, closed the channel, and the model's first tool
// call got the SDK's generic "the user doesn't want to take this action".
// 8 of 625 turns over four days had the shape; 2 lost a tool call to it.
describe("isPreambleResult", () => {
  it("an empty result after a task notification and before any assistant message is a preamble", () => {
    expect(isPreambleResult({ numTurns: 0, sawAssistant: false, sawTaskNotification: true })).toBe(true);
  });

  it("a result after the model answered is the real end of the turn", () => {
    expect(isPreambleResult({ numTurns: 0, sawAssistant: true, sawTaskNotification: true })).toBe(false);
    expect(isPreambleResult({ numTurns: 3, sawAssistant: true, sawTaskNotification: true })).toBe(false);
  });

  it("an empty result with no task notification is terminal (a local command, not a preamble)", () => {
    expect(isPreambleResult({ numTurns: 0, sawAssistant: false, sawTaskNotification: false })).toBe(false);
  });

  it("a result that did run model turns is never a preamble", () => {
    expect(isPreambleResult({ numTurns: 1, sawAssistant: false, sawTaskNotification: true })).toBe(false);
  });

  it("the grace bound is short enough that a genuinely empty turn still closes", () => {
    expect(PREAMBLE_RESULT_GRACE_MS).toBeLessThanOrEqual(120_000);
  });
});

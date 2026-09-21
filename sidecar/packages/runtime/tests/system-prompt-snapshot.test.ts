import { describe, expect, it } from "vitest";

import { turnSystemPrompt } from "../src/sdk-runner";

// ADR-0073 addendum (0.3.278). The SDK records the system prompt on a
// session's first request and replays it on every resume unless told not to.
// MARVIN's append changes per turn (mode, posture, practice rules), so a
// recorded prompt would freeze them mid-session with no error anywhere.
describe("turnSystemPrompt", () => {
  it("pins snapshot off so a per-turn append reaches the model", () => {
    expect(turnSystemPrompt("x").snapshot).toBe(false);
  });

  it("keeps the claude_code preset and passes the append through verbatim", () => {
    expect(turnSystemPrompt("MODE: ask")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "MODE: ask",
      snapshot: false,
    });
  });
});

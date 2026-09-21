import { describe, expect, it } from "vitest";

import { turnReminders, turnSystemPrompt } from "../src/sdk-runner";

// ADR-0118 — one system prompt per session. The SDK records it on the first
// request and replays it until compaction (`snapshot`); everything that
// changes per turn rides the turn's <system-reminder> suffix instead. Before
// this, a resumed turn's append REPLACED turn 1's — so from turn 2 the model
// had no project context at all, and every turn-1 → turn-2 switch broke the
// prompt cache (on Fable 5.1 it also invalidates earlier thinking blocks).
describe("turnSystemPrompt", () => {
  it("lets the SDK record the prompt for the session", () => {
    expect(turnSystemPrompt("x")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "x",
      snapshot: true,
    });
  });
});

describe("turnReminders", () => {
  it("carries the mode for every mode, so a stale PLAN reminder in history is overruled", () => {
    const plan = turnReminders({ mode: "plan" });
    const ask = turnReminders({ mode: "ask" });
    const agent = turnReminders({ mode: "agent" });
    expect(plan.join("\n")).toContain("Mode: PLAN");
    expect(ask.join("\n")).toContain("Mode: ASK");
    expect(agent.join("\n")).toContain("Mode: AGENT");
    expect(agent.join("\n")).not.toContain("read-only");
  });

  it("keeps orientation, mode, session and plan context in that order, dropping empties", () => {
    const r = turnReminders({ orientation: "O", mode: "agent", sessionContext: "", planContext: "P" });
    expect(r).toHaveLength(3);
    expect(r[0]).toBe("O");
    expect(r[1]).toContain("Mode: AGENT");
    expect(r[2]).toBe("P");
  });
});

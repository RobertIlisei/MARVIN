import { describe, expect, it } from "vitest";

import {
  buildCheckBackWakeup,
  detectUncoveredCheckBack,
  parseDelaySeconds,
} from "../src/checkback-guard";

// ADR-0055 — the mechanical backstop for unbacked "I'll check back" promises.

describe("detectUncoveredCheckBack", () => {
  it("catches the observed 2026-07-23 failure and parses ~7 minutes → 420s", () => {
    const text =
      "Verified ModularityTests 4/4 green locally, committed as `7fd1a7c6`, " +
      "and pushed. New pipeline `#2701545119` is running — I'll check back in ~7 minutes.";
    const d = detectUncoveredCheckBack(text);
    expect(d).not.toBeNull();
    expect(d!.delaySeconds).toBe(420);
    expect(d!.quote.toLowerCase()).toContain("check back");
  });

  it.each([
    "I'll check back once CI finishes.",
    "Kicking off the deploy — I'll report back when it's done.",
    "I'll keep an eye on the build and let you know.",
    "I'll be monitoring the pipeline.",
    "I'll continue when it reports green.",
    "Check back in a few minutes for the result.",
  ])("flags a check-back promise: %s", (text) => {
    expect(detectUncoveredCheckBack(text)).not.toBeNull();
  });

  it("defaults to 300s when the promise names no time", () => {
    const d = detectUncoveredCheckBack("I'll check back once it's done.");
    expect(d?.delaySeconds).toBe(300);
  });

  it.each([
    "Done — ModularityTests are 4/4 green and pushed. Anything else?",
    "You could check back later if you want, but it's already merged.",
    "The build takes about 7 minutes to run in CI.",
    "I checked the logs and fixed the missing import.",
    "",
  ])("does NOT trip on non-promise text: %s", (text) => {
    expect(detectUncoveredCheckBack(text)).toBeNull();
  });

  it("clamps a named delay into the scheduler window", () => {
    expect(detectUncoveredCheckBack("I'll check back in 30 seconds.")?.delaySeconds).toBe(60);
    expect(detectUncoveredCheckBack("I'll check back in 48 hours.")?.delaySeconds).toBe(86_400);
  });
});

describe("parseDelaySeconds", () => {
  it("parses units", () => {
    expect(parseDelaySeconds("~7 minutes")).toBe(420);
    expect(parseDelaySeconds("in 2 hours")).toBe(7200);
    expect(parseDelaySeconds("90 seconds")).toBe(90);
    expect(parseDelaySeconds("in 3 min")).toBe(180);
  });
  it("returns null when no duration is present", () => {
    expect(parseDelaySeconds("once it's done")).toBeNull();
  });
});

describe("buildCheckBackWakeup", () => {
  it("quotes the promise and tells the fired turn to follow through, not re-promise", () => {
    const { reason, prompt } = buildCheckBackWakeup({ quote: "I'll check back in ~7 minutes", delaySeconds: 420 });
    expect(reason).toMatch(/ADR-0055/);
    expect(prompt).toContain("I'll check back in ~7 minutes");
    expect(prompt).toMatch(/do not simply\s+re-promise/i);
  });
});

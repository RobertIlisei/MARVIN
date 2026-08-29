import { describe, expect, it } from "vitest";

import { clampEffort, resolveEffort, stepDownEffort } from "../src/effort";

/**
 * Dynamic effort (2026-08-29): the user's picker is a CEILING. These pin the
 * two invariants that make lowering it safe — a request can never raise a
 * turn above the ceiling, and stepping down never falls off the ladder.
 */
describe("resolveEffort", () => {
  it("maps legacy aliases and defaults unknowns to high", () => {
    expect(resolveEffort("fast", "claude-opus-5")).toBe("low");
    expect(resolveEffort("thinking", "claude-opus-5")).toBe("high");
    expect(resolveEffort(undefined, "claude-opus-5")).toBe("high");
    expect(resolveEffort("nonsense", "claude-opus-5")).toBe("high");
  });

  it("caps the top rungs at high on non-Opus executors", () => {
    expect(resolveEffort("max", "claude-sonnet-5")).toBe("high");
    expect(resolveEffort("xhigh", "claude-sonnet-5")).toBe("high");
    expect(resolveEffort("max", "claude-opus-5")).toBe("max");
  });
});

describe("stepDownEffort", () => {
  it("goes one rung down and floors at low", () => {
    expect(stepDownEffort("max", "claude-opus-5")).toBe("xhigh");
    expect(stepDownEffort("high", "claude-opus-5")).toBe("medium");
    expect(stepDownEffort("low", "claude-opus-5")).toBe("low");
  });

  it("steps down from the rung the turn would ACTUALLY run at", () => {
    // `max` on Sonnet resolves to `high`, so one rung down is `medium` —
    // not `xhigh`, which Sonnet never had.
    expect(stepDownEffort("max", "claude-sonnet-5")).toBe("medium");
  });
});

describe("clampEffort", () => {
  it("returns the ceiling when nothing was requested", () => {
    expect(clampEffort(undefined, "max", "claude-opus-5")).toBe("max");
  });

  it("honours a request below the ceiling", () => {
    expect(clampEffort("low", "max", "claude-opus-5")).toBe("low");
    expect(clampEffort("medium", "high", "claude-opus-5")).toBe("medium");
  });

  it("never lets a request exceed the ceiling", () => {
    expect(clampEffort("max", "medium", "claude-opus-5")).toBe("medium");
    expect(clampEffort("xhigh", "low", "claude-opus-5")).toBe("low");
  });
});

import { describe, expect, it } from "vitest";

import { resolveEffort, effortForThinkingMode } from "../src/sdk-runner";

// Pin the reasoning-effort resolver. MARVIN's picker now exposes the
// full SDK ladder (low/medium/high/xhigh/max) instead of the old
// 3-mode (fast/thinking/max) abstraction. Two load-bearing rules:
//   1. The top rungs (xhigh, max) are Opus-only — on non-Opus
//      executors they must fall back to `high`, or the SDK refuses
//      the turn. The UI also disables them off-Opus, but a stale pref
//      or out-of-sync client must still produce a valid SDK call.
//   2. Legacy fast/thinking/max values keep resolving (persisted
//      prefs + old transcripts), so the migration is seamless.
//
// If you change the mapping, also update the picker UI in
// ChatAgentsFooter.swift so disabled/visible options match.

describe("resolveEffort — ladder values", () => {
  it("low / medium / high pass through on any model", () => {
    expect(resolveEffort("low", "claude-sonnet-4-6")).toBe("low");
    expect(resolveEffort("medium", "claude-sonnet-4-6")).toBe("medium");
    expect(resolveEffort("high", "claude-sonnet-4-6")).toBe("high");
    expect(resolveEffort("low", "claude-opus-4-8")).toBe("low");
    expect(resolveEffort("medium", "claude-opus-4-8")).toBe("medium");
  });

  it("xhigh holds on Opus, falls back to high elsewhere", () => {
    expect(resolveEffort("xhigh", "claude-opus-4-8")).toBe("xhigh");
    expect(resolveEffort("xhigh", "claude-opus-4-7")).toBe("xhigh");
    expect(resolveEffort("xhigh", "claude-sonnet-4-6")).toBe("high");
    expect(resolveEffort("xhigh", "claude-haiku-4-5-20251001")).toBe("high");
  });

  it("max holds on Opus, falls back to high elsewhere", () => {
    expect(resolveEffort("max", "claude-opus-4-8")).toBe("max");
    expect(resolveEffort("max", "claude-sonnet-4-6")).toBe("high");
    expect(resolveEffort("max", "claude-haiku-4-5-20251001")).toBe("high");
  });

  it("Opus detection is case-insensitive", () => {
    expect(resolveEffort("xhigh", "CLAUDE-OPUS-4-8")).toBe("xhigh");
    expect(resolveEffort("max", "Claude-Opus-4-8")).toBe("max");
  });

  it("unknown / undefined defaults to high", () => {
    expect(resolveEffort(undefined, "claude-opus-4-8")).toBe("high");
    expect(resolveEffort("bogus", "claude-opus-4-8")).toBe("high");
    expect(resolveEffort("", "claude-opus-4-8")).toBe("high");
  });

  it("input is case-normalised", () => {
    expect(resolveEffort("XHIGH", "claude-opus-4-8")).toBe("xhigh");
    expect(resolveEffort("Max", "claude-opus-4-8")).toBe("max");
  });
});

describe("resolveEffort — legacy aliases (backward compat)", () => {
  it("fast → low (model-agnostic)", () => {
    expect(resolveEffort("fast", "claude-opus-4-8")).toBe("low");
    expect(resolveEffort("fast", "claude-sonnet-4-6")).toBe("low");
  });

  it("thinking → high (the prior default)", () => {
    expect(resolveEffort("thinking", "claude-opus-4-8")).toBe("high");
    expect(resolveEffort("thinking", "claude-sonnet-4-6")).toBe("high");
  });

  it("legacy max keeps the Opus-only fallback", () => {
    expect(resolveEffort("max", "claude-opus-4-8")).toBe("max");
    expect(resolveEffort("max", "claude-sonnet-4-6")).toBe("high");
  });
});

describe("effortForThinkingMode — deprecated alias still works", () => {
  it("delegates to resolveEffort", () => {
    expect(effortForThinkingMode("fast", "claude-opus-4-8")).toBe("low");
    expect(effortForThinkingMode("thinking", "claude-sonnet-4-6")).toBe("high");
    expect(effortForThinkingMode("max", "claude-opus-4-8")).toBe("max");
    expect(effortForThinkingMode("max", "claude-sonnet-4-6")).toBe("high");
  });
});

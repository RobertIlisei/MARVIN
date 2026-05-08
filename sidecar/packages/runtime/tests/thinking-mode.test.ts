import { describe, expect, it } from "vitest";

import { effortForThinkingMode } from "../src/sdk-runner";

// Pin the user-facing thinking-mode → SDK `effort` mapper. The
// user-facing surface is three modes (Fast / Thinking / Max); the SDK
// has five effort levels. The load-bearing rule is that `max` only
// works on Opus 4.6/4.7 — on Sonnet executors the mapper must
// silently downgrade to `high` so the SDK doesn't refuse the turn.
//
// If you change the mapping, also update the picker UI in MARVIN so
// the disabled/visible options match the runtime contract.

describe("effortForThinkingMode", () => {
  it("Fast → low (model-agnostic)", () => {
    expect(effortForThinkingMode("fast", "claude-opus-4-7")).toBe("low");
    expect(effortForThinkingMode("fast", "claude-sonnet-4-6")).toBe("low");
  });

  it("Thinking → high (model-agnostic; matches the prior default)", () => {
    expect(effortForThinkingMode("thinking", "claude-opus-4-7")).toBe("high");
    expect(effortForThinkingMode("thinking", "claude-sonnet-4-6")).toBe("high");
  });

  it("Max → max on Opus 4.7", () => {
    expect(effortForThinkingMode("max", "claude-opus-4-7")).toBe("max");
  });

  it("Max → max on Opus 4.6", () => {
    expect(effortForThinkingMode("max", "claude-opus-4-6")).toBe("max");
  });

  it("Max downgrades to high on Sonnet (load-bearing)", () => {
    // Sonnet doesn't support the `max` effort rung. Without the
    // downgrade, the SDK would refuse the turn — the UI also
    // disables Max when the executor is Sonnet, but a stale
    // pref or out-of-sync client must still produce a valid SDK
    // call. The downgrade is the runtime safety net.
    expect(effortForThinkingMode("max", "claude-sonnet-4-6")).toBe("high");
  });

  it("Max downgrades to high on Haiku", () => {
    expect(effortForThinkingMode("max", "claude-haiku-4-5-20251001")).toBe("high");
  });

  it("Opus detection is case-insensitive", () => {
    expect(effortForThinkingMode("max", "CLAUDE-OPUS-4-7")).toBe("max");
    expect(effortForThinkingMode("max", "Claude-Opus-4-7")).toBe("max");
  });
});

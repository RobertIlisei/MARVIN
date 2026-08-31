import { describe, expect, it } from "vitest";

import { fallbackNewestOfTier, type ModelInfo, newestOfTier } from "../src/models";

// Pin the tier-resolution logic that replaced the hardcoded model ids
// (ADR-0029). The load-bearing rules:
//   1. Newest live model of a tier wins (by createdAt desc).
//   2. A live model always beats a `live: false` fallback entry, even
//      if the fallback has a (null) createdAt that would otherwise sort
//      ahead — a stale pin must never shadow a freshly-shipped model.
//   3. fallbackNewestOfTier is the sync, network-free last resort.

function m(id: string, tier: ModelInfo["tier"], createdAt: string | null, live: boolean): ModelInfo {
  return { id, displayName: id, tier, createdAt, live };
}

describe("newestOfTier", () => {
  it("picks the newest live model of a tier by createdAt", () => {
    const models = [
      m("claude-opus-4-7", "opus", "2026-02-01T00:00:00Z", true),
      m("claude-opus-4-8", "opus", "2026-05-01T00:00:00Z", true),
      m("claude-sonnet-4-6", "sonnet", "2026-01-01T00:00:00Z", true),
    ];
    expect(newestOfTier(models, "opus")).toBe("claude-opus-4-8");
    expect(newestOfTier(models, "sonnet")).toBe("claude-sonnet-4-6");
  });

  it("a live model beats a fallback entry of the same tier", () => {
    const models = [
      m("claude-opus-4-8", "opus", null, false), // fallback, null date
      m("claude-opus-4-7", "opus", "2026-02-01T00:00:00Z", true), // live
    ];
    // Live wins even though both could sort by date — the live flag is
    // the primary key.
    expect(newestOfTier(models, "opus")).toBe("claude-opus-4-7");
  });

  it("returns null when the tier is absent", () => {
    const models = [m("claude-sonnet-4-6", "sonnet", null, true)];
    expect(newestOfTier(models, "haiku")).toBeNull();
  });

  it("falls back to a fallback entry when no live model of the tier exists", () => {
    const models = [
      m("claude-opus-4-8", "opus", null, false), // only a fallback
      m("claude-sonnet-4-6", "sonnet", "2026-01-01T00:00:00Z", true),
    ];
    expect(newestOfTier(models, "opus")).toBe("claude-opus-4-8");
  });
});

describe("fallbackNewestOfTier", () => {
  // Deliberately NOT pinned to literal ids. The previous version asserted
  // `claude-opus-4-8`, which is exactly what let the list rot: the About
  // panel reported that model for months while turns ran on Sonnet 5, and
  // the test passed the whole time because it agreed with the stale value
  // (2026-08-30). Assert the CONTRACT — one resolvable entry per tier, of
  // the right tier — so a version bump is a one-line source edit and a
  // missing tier is still a failure.
  it("resolves every tier from the static list, without network", () => {
    for (const tier of ["opus", "sonnet", "haiku"] as const) {
      const id = fallbackNewestOfTier(tier);
      expect(id, tier).toBeTruthy();
      expect(id, tier).toContain(tier);
    }
  });

  it("has no entry for an unknown tier", () => {
    expect(fallbackNewestOfTier("other")).toBeNull();
  });
});

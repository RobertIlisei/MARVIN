import { describe, expect, it } from "vitest";

import {
  activePreset,
  PRESETS,
  pickTierId,
  resolvePreset,
} from "../src/components/settings/model-picker-presets";
import type { ModelInfo } from "../src/components/settings/model-picker-types";

// These tests pin the three invariants the picker UI depends on:
// what "solo" / "advisor" / custom mean for the collapsed-button
// label + preset highlight state. Regressions here break the whole
// user-visible "what mode am I in?" surface.

const LIVE_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    tier: "opus",
    createdAt: "2026-03-10T00:00:00Z",
    live: true,
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    tier: "opus",
    createdAt: "2026-01-01T00:00:00Z",
    live: true,
  },
  {
    id: "claude-sonnet-4-7",
    displayName: "Claude Sonnet 4.7",
    tier: "sonnet",
    createdAt: "2026-03-05T00:00:00Z",
    live: true,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    tier: "sonnet",
    createdAt: "2025-12-01T00:00:00Z",
    live: true,
  },
];

describe("pickTierId", () => {
  it("picks the most recent live model in the tier", () => {
    // Invariant: presets track model upgrades automatically. If a new
    // Sonnet ships, the "advisor" preset should start using it without
    // a code change.
    expect(pickTierId("opus", LIVE_MODELS, null)).toBe(
      "claude-opus-4-7",
    );
    expect(pickTierId("sonnet", LIVE_MODELS, null)).toBe(
      "claude-sonnet-4-7",
    );
  });

  it("falls back to the hardcoded id when the tier is empty", () => {
    // Happens when /api/models returns the fallback list (no
    // credentials) or when the tier genuinely has no live models.
    expect(pickTierId("haiku", LIVE_MODELS, "claude-haiku-default")).toBe(
      "claude-haiku-default",
    );
    expect(pickTierId("opus", [], "claude-opus-4-6")).toBe(
      "claude-opus-4-6",
    );
  });

  it("ignores non-live models even if they're in the list", () => {
    const withStale: ModelInfo[] = [
      ...LIVE_MODELS,
      {
        id: "claude-sonnet-future",
        displayName: "Future Sonnet",
        tier: "sonnet",
        createdAt: "2099-01-01T00:00:00Z",
        live: false,
      },
    ];
    // Future Sonnet is deprecated-but-listed (live: false); the resolver
    // must skip it even though its createdAt sorts first.
    expect(pickTierId("sonnet", withStale, null)).toBe(
      "claude-sonnet-4-7",
    );
  });
});

describe("resolvePreset", () => {
  it("Solo Opus clears advisor and nulls executor for server default", () => {
    const preset = PRESETS.find((p) => p.id === "solo");
    if (!preset) throw new Error("solo preset missing");
    // executor: null means "server picks its default" — lets the
    // default (currently Opus 4.7) track Anthropic's release cycle
    // without editing this file.
    expect(resolvePreset(preset, LIVE_MODELS)).toEqual({
      executor: null,
      advisor: null,
    });
  });

  it("Advisor picks the latest live Sonnet + Opus", () => {
    const preset = PRESETS.find((p) => p.id === "advisor");
    if (!preset) throw new Error("advisor preset missing");
    expect(resolvePreset(preset, LIVE_MODELS)).toEqual({
      executor: "claude-sonnet-4-7",
      advisor: "claude-opus-4-7",
    });
  });

  it("Advisor falls back to hardcoded ids when the model list is empty", () => {
    // Simulates the fallback-list case — no credentials, /api/models
    // returns a stub. The preset must still resolve to something usable.
    const preset = PRESETS.find((p) => p.id === "advisor");
    if (!preset) throw new Error("advisor preset missing");
    expect(resolvePreset(preset, [])).toEqual({
      executor: "claude-sonnet-4-6",
      advisor: "claude-opus-4-6",
    });
  });
});

describe("activePreset", () => {
  it("null/null is Solo Opus", () => {
    // Default state. The collapsed button should read "opus" and the
    // Solo preset should highlight.
    expect(activePreset(null, null, LIVE_MODELS)).toBe("solo");
  });

  it("latest Opus executor with no advisor is Solo Opus", () => {
    expect(activePreset("claude-opus-4-7", null, LIVE_MODELS)).toBe(
      "solo",
    );
  });

  it("Sonnet-tier executor + Opus-tier advisor is Advisor", () => {
    expect(
      activePreset("claude-sonnet-4-7", "claude-opus-4-7", LIVE_MODELS),
    ).toBe("advisor");
    // Older pair still counts — tier match is what defines the mode,
    // not exact ids. A user who intentionally pinned Sonnet 4.6 should
    // still see "advisor" highlighted.
    expect(
      activePreset("claude-sonnet-4-6", "claude-opus-4-6", LIVE_MODELS),
    ).toBe("advisor");
  });

  it("Haiku executor + Opus advisor is custom (no preset match)", () => {
    const models: ModelInfo[] = [
      ...LIVE_MODELS,
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        tier: "haiku",
        createdAt: "2025-11-01T00:00:00Z",
        live: true,
      },
    ];
    // Cost-optimised power-user setup. Neither preset matches; the
    // "custom pair" hint should show in the UI.
    expect(
      activePreset("claude-haiku-4-5", "claude-opus-4-7", models),
    ).toBeNull();
  });

  it("Sonnet executor without advisor is custom (not advisor mode)", () => {
    // Without an advisor model set, the server runs Sonnet solo — no
    // Opus escalation. That's not the advisor carve-out even though
    // the executor is Sonnet-tier.
    expect(
      activePreset("claude-sonnet-4-7", null, LIVE_MODELS),
    ).toBeNull();
  });

  it("fallback-list hardcoded ids still classify as advisor", () => {
    // The /api/models fallback list case: the client has no live
    // models yet but the user's localStorage carries the hardcoded
    // advisor-mode ids. Keep the preset highlighted so the UI doesn't
    // falsely report "custom" during the loading moment.
    expect(
      activePreset("claude-sonnet-4-6", "claude-opus-4-6", []),
    ).toBe("advisor");
  });
});

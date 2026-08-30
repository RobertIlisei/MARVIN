import { describe, expect, it } from "vitest";

import {
  ensureProviderModelId,
  fallbackModelsForProvider,
  isBareAnthropicId,
  type ModelInfo,
} from "../src/models";

// ADR-0096 — OpenRouter addresses models by vendor-prefixed slug
// (`anthropic/claude-sonnet-4.5`); Anthropic's API uses a bare id
// (`claude-sonnet-5`). The live catalogue already produces the right shape on
// each provider; every FALLBACK path returned bare Anthropic ids regardless,
// so a transient catalogue failure silently swapped a working OpenRouter
// session onto ids OpenRouter cannot resolve — for the executor, the advisor,
// the graph-extractor, the session auditor, and skill discovery.

function m(id: string, tier: ModelInfo["tier"], createdAt: string | null, live: boolean): ModelInfo {
  return { id, displayName: id, tier, createdAt, live };
}

describe("fallbackModelsForProvider", () => {
  it("returns ids the receiving provider can actually resolve", () => {
    for (const model of fallbackModelsForProvider("openrouter")) {
      expect(model.id).toContain("/");
      expect(isBareAnthropicId(model.id)).toBe(false);
    }
    for (const model of fallbackModelsForProvider("anthropic")) {
      expect(model.id).not.toContain("/");
    }
  });

  it("covers all three tiers on both providers, so no tier resolves to null", () => {
    for (const provider of ["anthropic", "openrouter"] as const) {
      const tiers = fallbackModelsForProvider(provider).map((x) => x.tier);
      expect(tiers).toContain("opus");
      expect(tiers).toContain("sonnet");
      expect(tiers).toContain("haiku");
    }
  });

  it("marks fallbacks as not live, so a stale pin never shadows a fresh model", () => {
    expect(fallbackModelsForProvider("openrouter").every((x) => !x.live)).toBe(true);
  });
});

describe("isBareAnthropicId", () => {
  it("identifies the shape that breaks OpenRouter and nothing else", () => {
    expect(isBareAnthropicId("claude-opus-5")).toBe(true);
    expect(isBareAnthropicId("claude-sonnet-4-6")).toBe(true);
    expect(isBareAnthropicId("anthropic/claude-sonnet-4.5")).toBe(false);
    expect(isBareAnthropicId("openai/gpt-5")).toBe(false);
    expect(isBareAnthropicId("google/gemini-2.5-pro")).toBe(false);
  });
});

describe("ensureProviderModelId", () => {
  const catalogue = [
    m("anthropic/claude-opus-4.1", "opus", "2026-05-01T00:00:00Z", true),
    m("anthropic/claude-sonnet-4.5", "sonnet", "2026-04-01T00:00:00Z", true),
    m("openai/gpt-5", "other", "2026-06-01T00:00:00Z", true),
  ];

  it("rewrites a bare Anthropic id to the live OpenRouter slug of the same tier", () => {
    expect(ensureProviderModelId("claude-sonnet-5", catalogue, "openrouter")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(ensureProviderModelId("claude-opus-5", catalogue, "openrouter")).toBe(
      "anthropic/claude-opus-4.1",
    );
  });

  it("falls back to the static slug list when the catalogue is empty", () => {
    // The catalogue failing is exactly when this guard matters — a rewrite
    // that only works when discovery works would protect nothing.
    const out = ensureProviderModelId("claude-haiku-4-5-20251001", [], "openrouter");
    expect(out).toBe("anthropic/claude-haiku-4.5");
  });

  it("is a no-op on Anthropic — the guard must not touch the normal path", () => {
    expect(ensureProviderModelId("claude-opus-5", catalogue, "anthropic")).toBe("claude-opus-5");
  });

  it("leaves an already-prefixed id alone on either provider", () => {
    expect(ensureProviderModelId("anthropic/claude-opus-4.1", catalogue, "openrouter")).toBe(
      "anthropic/claude-opus-4.1",
    );
    expect(ensureProviderModelId("openai/gpt-5", catalogue, "openrouter")).toBe("openai/gpt-5");
  });

  it("passes null and undefined straight through", () => {
    expect(ensureProviderModelId(null, catalogue, "openrouter")).toBeNull();
    expect(ensureProviderModelId(undefined, catalogue, "openrouter")).toBeNull();
  });

  it("ignores bare ids in the catalogue when picking a replacement", () => {
    // A catalogue polluted with bare ids must not yield another bare id —
    // that would rewrite one broken value into a different broken value.
    const polluted = [m("claude-sonnet-5", "sonnet", "2027-01-01T00:00:00Z", true)];
    expect(ensureProviderModelId("claude-sonnet-5", polluted, "openrouter")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });
});

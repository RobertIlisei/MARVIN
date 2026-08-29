import { describe, expect, it } from "vitest";

import { contextWindowFor } from "../src/models";

// Pins the model→window lookup that powers the /context panel's percentage
// and colour bands. The only free signal is the extended-window marker the
// runtime appends to a model id; everything else is the standard 200K window.
// `contextWindowFor` went async when OpenRouter discovery landed (the live
// list reports `context_length`, so the lookup can await a real answer).
describe("contextWindowFor", () => {
  it("resolves the 1M extended window from the [1m] marker", async () => {
    expect(await contextWindowFor("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(await contextWindowFor("claude-opus-4-8-1m")).toBe(1_000_000);
    expect(await contextWindowFor("CLAUDE-OPUS-4-8[1M]")).toBe(1_000_000);
  });

  it("defaults to the 200K window for standard model ids", async () => {
    expect(await contextWindowFor("claude-opus-4-8")).toBe(200_000);
    expect(await contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(await contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("defaults to 200K for null/undefined/empty", async () => {
    expect(await contextWindowFor(null)).toBe(200_000);
    expect(await contextWindowFor(undefined)).toBe(200_000);
    expect(await contextWindowFor("")).toBe(200_000);
  });
});

import { describe, expect, it } from "vitest";

import { estimateCostFromPricing } from "../src/models";

// Pin the per-turn cost estimator against OpenRouter's real pricing shape.
// The 2026-08-28 incident: cache tokens were billed at the full prompt
// price, and unknown models fell back to the SDK's total_cost_usd, which
// prices everything off Claude's rate card (~10× over). Fixtures below are
// the actual pricing strings OpenRouter serves for the two models involved.

const GLM = {
  prompt: "0.000000075",
  completion: "0.00000025",
  input_cache_read: "0.000000015",
};

const QWEN = {
  prompt: "0.00000015",
  completion: "0.00000047",
  input_cache_read: "0.000000016",
  input_cache_write: "0.0000002",
};

describe("estimateCostFromPricing", () => {
  it("bills cache-read tokens at the discounted cache price, not the prompt price", () => {
    // The 11:32 glm turn: 4.19M cached tokens. At prompt price this
    // prices ~$0.33; at OpenRouter's input_cache_read it is ~$0.081.
    const cost = estimateCostFromPricing(GLM, {
      input_tokens: 115_770,
      output_tokens: 36_688,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4_192_896,
    });
    expect(cost).toBeCloseTo(0.0807, 4);
  });

  it("bills cache-write tokens at input_cache_write when reported", () => {
    // The 11:01 qwen turn: 52,739 written at $0.2/M — a premium over the
    // $0.15/M prompt price, so the write price must be read, not assumed.
    const cost = estimateCostFromPricing(QWEN, {
      input_tokens: 44_047,
      output_tokens: 4_155,
      cache_creation_input_tokens: 52_739,
      cache_read_input_tokens: 263_265,
    });
    expect(cost).toBeCloseTo(0.0233, 4);
  });

  it("falls back to the prompt price when the pricing object has no cache fields", () => {
    const cost = estimateCostFromPricing(
      { prompt: "0.000001", completion: "0.000003" },
      {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 100_000,
        cache_read_input_tokens: 100_000,
      },
    );
    // Everything at prompt price: 1.2M × $1/M = $1.20.
    expect(cost).toBeCloseTo(1.2, 6);
  });

  it("returns null when the priced usage is zero", () => {
    expect(
      estimateCostFromPricing(GLM, {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBeNull();
  });
});

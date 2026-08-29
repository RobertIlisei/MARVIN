import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// ADR-0082 — Claude plan usage from `rate_limit_event`.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-rl-"));
const { rateLimitPayload, recordClaudeRateLimit, summarizeCost } = await import("../src/cost-tracker");

describe("claude rate limits", () => {
  beforeEach(() => { process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-rl-")); });

  it("keeps the newest snapshot per window and lists them in the summary", () => {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_800_000_000 });
    recordClaudeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 });
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5 });
    const s = summarizeCost();
    expect(s.claudeRateLimits.map((w) => [w.type, w.utilization, w.status])).toEqual([
      ["five_hour", 0.5, "allowed"],
      ["seven_day", 0.9, "allowed_warning"],
    ]);
    expect(s.claudeRateLimits[0]?.resetsAt).toBeUndefined(); // newest snapshot wins, fields are not merged
  });

  it("a bare status with no window type never overwrites a typed window", () => {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 });
    expect(recordClaudeRateLimit({ status: "allowed" })).toBeNull();
    expect(summarizeCost().claudeRateLimits.map((w) => w.type)).toEqual(["five_hour"]);
  });

  it("is empty — not fabricated — before the first event", () => {
    expect(summarizeCost().claudeRateLimits).toEqual([]);
  });

  it("narrows only rate_limit_event messages", () => {
    expect(rateLimitPayload({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } })).toEqual({ status: "allowed", rateLimitType: "five_hour" });
    expect(rateLimitPayload({ type: "result" })).toBeNull();
    expect(recordClaudeRateLimit({ status: "weird" as never })).toBeNull();
  });
});

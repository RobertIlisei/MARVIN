// Cost accounting per auth mode (2026-10-31). Measured before this: the SDK's
// `total_cost_usd` and `modelUsage` are CUMULATIVE across a resumed session,
// and the tracker filed each as one turn's cost — a real session's turns
// recorded 8.53, 11.73, 11.83, 28.70, 32.32 and summed to $93 against $32.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-cost-acct-"));
const {
  accountSignals,
  classifyAuthMode,
  recordAccountInfo,
  cumulativeDelta,
  recordClaudeRateLimit,
  recordTurnCost,
  summarizeCost,
  visibleWindows,
  windowLabel,
} = await import("../src/cost-tracker");

const opus = (cost: number, out: number) => ({
  "claude-opus-5-5": { inputTokens: 10, outputTokens: out, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100, costUSD: cost, costBasis: "list" },
});

beforeEach(() => {
  process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-cost-acct-"));
});

describe("per-turn cost from the SDK's cumulative totals", () => {
  it("cumulativeDelta: first turn, growth, and a reset", () => {
    expect(cumulativeDelta(4.73, undefined)).toBeCloseTo(4.73);
    expect(cumulativeDelta(11.83, 11.73)).toBeCloseTo(0.1);
    expect(cumulativeDelta(0.4, 32.3)).toBeCloseTo(0.4); // a reset session: the total is the turn
  });

  it("records each turn's share, not the running total, per session and per model", () => {
    const totals = [8.53, 11.73, 11.83, 28.7, 32.32];
    for (const t of totals) {
      recordTurnCost({
        projectId: "p", marvinSessionId: "m1", authMode: "subscription", model: "claude-opus-5-5",
        tokenUsage: { input_tokens: 1, output_tokens: 1 },
        sdk: { sessionId: "sdk-1", totalCostUsd: t, modelUsage: opus(t, Math.round(t * 1000)) },
      });
    }
    const s = summarizeCost({ projectId: "p" });
    expect(s.lifetime.costUsd).toBeCloseTo(32.32, 6);
    expect(s.lifetime.turns).toBe(5);
    expect(s.byModel.today).toHaveLength(1);
    expect(s.byModel.today[0]).toMatchObject({ model: "claude-opus-5-5", authMode: "subscription", turns: 5, outputTokens: 32320 });
    expect(s.byModel.today[0]!.costUsd).toBeCloseTo(32.32, 6);
  });

  it("a zeroed total (a crash result) never becomes the baseline", () => {
    recordTurnCost({ projectId: "p", authMode: "subscription", sdk: { sessionId: "z", totalCostUsd: 5 } });
    recordTurnCost({ projectId: "p", authMode: "subscription", tokenUsage: { input_tokens: 1 }, sdk: { sessionId: "z", totalCostUsd: 0 } });
    recordTurnCost({ projectId: "p", authMode: "subscription", sdk: { sessionId: "z", totalCostUsd: 5.5 } });
    expect(summarizeCost().lifetime.costUsd).toBeCloseTo(5.5, 6);
  });

  it("two SDK sessions keep separate baselines", () => {
    recordTurnCost({ projectId: "p", authMode: "anthropic-api", sdk: { sessionId: "a", totalCostUsd: 1 } });
    recordTurnCost({ projectId: "p", authMode: "anthropic-api", sdk: { sessionId: "b", totalCostUsd: 5 } });
    recordTurnCost({ projectId: "p", authMode: "anthropic-api", sdk: { sessionId: "a", totalCostUsd: 1.5 } });
    expect(summarizeCost().lifetime.costUsd).toBeCloseTo(6.5, 6);
  });

  it("a session already running when this landed starts its chain as unknown, not as its whole history", () => {
    // A legacy entry (no `v`) for the same MARVIN session.
    const file = join(process.env.MARVIN_DATA_DIR!, "cost-tracker.json");
    writeFileSync(file, JSON.stringify({ entries: [{ at: new Date().toISOString(), projectId: "p", marvinSessionId: "m1", costUsd: 28.7, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }] }));
    const first = recordTurnCost({ projectId: "p", marvinSessionId: "m1", authMode: "subscription", sdk: { sessionId: "sdk-1", totalCostUsd: 32.32 } });
    expect(first).toMatchObject({ costUsd: 0, costKind: "unknown" });
    const second = recordTurnCost({ projectId: "p", marvinSessionId: "m1", authMode: "subscription", sdk: { sessionId: "sdk-1", totalCostUsd: 33 } });
    expect(second!.costUsd).toBeCloseTo(0.68, 6);
    const s = summarizeCost();
    expect(s.lifetime.costUsd).toBeCloseTo(0.68, 6);
    expect(s.lifetime.unpricedTurns).toBe(1);
    expect(s.legacy).toMatchObject({ costUsd: 28.7, turns: 1 });
  });
});

describe("what is recorded per turn", () => {
  it("model, advisor model, auth mode, SDK session, cache-write TTL, an id and the v2 marker", () => {
    const e = recordTurnCost({
      projectId: "p", marvinSessionId: "m", authMode: "subscription",
      model: "claude-opus-5-5", advisorModel: "claude-fable-5-1",
      tokenUsage: {
        input_tokens: 46, output_tokens: 12058, cache_creation_input_tokens: 79837, cache_read_input_tokens: 3363298,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 79837 },
      },
      sdk: { sessionId: "s", totalCostUsd: 1.555, modelUsage: opus(1.553, 12058) },
    })!;
    expect(e).toMatchObject({
      v: 2, model: "claude-opus-5-5", advisorModel: "claude-fable-5-1", authMode: "subscription",
      sdkSessionId: "s", cacheWrite5mTokens: 0, cacheWrite1hTokens: 79837, costKind: "api-equivalent",
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.costUsd).toBeCloseTo(1.555);
    const t = summarizeCost().today;
    expect([t.inputTokens, t.cacheReadTokens, t.cacheCreationTokens, t.cacheWrite1hTokens]).toEqual([46, 3363298, 79837, 79837]);
  });

  it("an entry without a model reads as 'unknown model' in the breakdown", () => {
    recordTurnCost({ projectId: "p", costUsd: 0.2, tokenUsage: { input_tokens: 1 } });
    expect(summarizeCost().byModel.today[0]).toMatchObject({ model: "unknown model", authMode: "unknown" });
  });
});

describe("cost by auth mode", () => {
  it("subscription = api-equivalent, Anthropic key = billed, and they are never one unlabelled total", () => {
    recordTurnCost({ projectId: "p", authMode: "subscription", sdk: { sessionId: "a", totalCostUsd: 2 } });
    recordTurnCost({ projectId: "p", authMode: "anthropic-api", sdk: { sessionId: "b", totalCostUsd: 0.5 } });
    const t = summarizeCost().today;
    expect(t.byAuthMode.subscription?.costUsd).toBeCloseTo(2);
    expect(t.byAuthMode["anthropic-api"]?.costUsd).toBeCloseTo(0.5);
    expect(Object.keys(t.byAuthMode).sort()).toEqual(["anthropic-api", "subscription"]);
  });

  it("an Anthropic-key turn the CLI could not price (costBasis unknown) is an estimate, not a bill", () => {
    const e = recordTurnCost({
      projectId: "p", authMode: "anthropic-api",
      sdk: { sessionId: "a", totalCostUsd: 1, modelUsage: { "claude-new": { costUSD: 1, outputTokens: 5, costBasis: "unknown" } } },
    });
    expect(e?.costKind).toBe("estimate");
  });

  it("OpenRouter uses MARVIN's OpenRouter-price estimate and keeps the SDK's rate-card figure aside", () => {
    const e = recordTurnCost({
      projectId: "p", authMode: "openrouter", model: "z-ai/glm-5", estimateUsd: 0.33,
      sdk: { sessionId: "o", totalCostUsd: 4.21, modelUsage: { "z-ai/glm-5": { costUSD: 4.21, outputTokens: 900 } } },
    })!;
    expect(e).toMatchObject({ costUsd: 0.33, costKind: "estimate", sdkCostUsd: 4.21 });
    const row = summarizeCost().byModel.today[0]!;
    expect(row).toMatchObject({ model: "z-ai/glm-5", authMode: "openrouter", estimated: true });
    expect(row.costUsd).toBeCloseTo(0.33); // not the 4.21 rate-card figure
  });

  it("OpenRouter with no price for the model records the cost as unknown — never the ~10× SDK figure", () => {
    const e = recordTurnCost({ projectId: "p", authMode: "openrouter", model: "x/y", estimateUsd: null, sdk: { sessionId: "o", totalCostUsd: 4.21 } })!;
    expect(e).toMatchObject({ costUsd: 0, costKind: "unknown", sdkCostUsd: 4.21 });
    expect(summarizeCost().today.byAuthMode.openrouter).toMatchObject({ costUsd: 0, unpricedTurns: 1 });
  });
});

describe("classifyAuthMode", () => {
  // From MARVIN's own auth status alone — the fallback when the SDK reported nothing.
  it.each([
    [{ mode: "api-key", provider: "openrouter" }, undefined, "openrouter"],
    [{ mode: "api-key", provider: "anthropic" }, undefined, "anthropic-api"],
    [{ mode: "oauth" }, undefined, "subscription"],
    [{ mode: "host-credentials" }, { apiKeySource: "none" }, "subscription"],
    [{ mode: "host-credentials" }, undefined, "subscription"],
    [{ mode: "host-credentials" }, { apiKeySource: "/login managed key" }, "anthropic-api"],
    [{ mode: "host-credentials" }, { apiKeySource: "ANTHROPIC_API_KEY" }, "anthropic-api"],
    [{ mode: "host-credentials" }, { apiKeySource: "something-new" }, "other"],
    [{ mode: "none" }, undefined, "other"],
  ] as const)("%o + %o → %s", (auth, sig, want) => {
    expect(classifyAuthMode(auth, sig)).toBe(want);
  });

  // The SDK's accountInfo() beats inference from the environment.
  it("a non-firstParty apiProvider is a gateway or a cloud provider, whatever the env says", () => {
    expect(classifyAuthMode({ mode: "host-credentials" }, { apiProvider: "gateway" })).toBe("gateway");
    for (const p of ["bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle"]) {
      expect(classifyAuthMode({ mode: "api-key", provider: "anthropic" }, { apiProvider: p })).toBe("cloud-provider");
    }
  });

  it("a plan login reported by the SDK is a subscription even when the env looked like a key", () => {
    expect(classifyAuthMode({ mode: "api-key", provider: "anthropic" }, { apiProvider: "firstParty", subscriptionType: "ultra", apiKeySource: "none" })).toBe("subscription");
  });

  it("a key the CLI is actually using beats a plan it is also logged into", () => {
    expect(classifyAuthMode({ mode: "host-credentials" }, { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" })).toBe("anthropic-api");
  });

  it("MARVIN's own OpenRouter routing wins: the CLI behind the proxy believes it is firstParty", () => {
    expect(classifyAuthMode({ mode: "api-key", provider: "openrouter" }, { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" })).toBe("openrouter");
  });
});

describe("account info from the SDK", () => {
  it("accountSignals keeps what classifies the account and drops email and organization", () => {
    const sig = accountSignals({ email: "someone@example.com", organization: "Org", subscriptionType: "ultra", tokenSource: "claude.ai", apiKeySource: "none", apiProvider: "firstParty" });
    expect(sig).toEqual({ subscriptionType: "ultra", tokenSource: "claude.ai", apiKeySource: "none", apiProvider: "firstParty" });
    expect(accountSignals(null)).toEqual({});
    expect(accountSignals({ subscriptionType: 7 })).toEqual({});
  });

  it("persists the latest account per project, never the email, and the summary reports it", () => {
    recordAccountInfo("p", { email: "someone@example.com", subscriptionType: "max", apiProvider: "firstParty" });
    recordAccountInfo("p", { email: "someone@example.com", subscriptionType: "ultra", apiProvider: "firstParty" });
    recordAccountInfo("q", { apiProvider: "gateway" });
    const raw = readFileSync(join(process.env.MARVIN_DATA_DIR!, "cost-tracker.json"), "utf-8");
    expect(raw).not.toContain("someone@example.com");
    expect(summarizeCost({ projectId: "p" }).account).toMatchObject({ subscriptionType: "ultra", apiProvider: "firstParty" });
    expect(summarizeCost({ projectId: "q" }).account).toMatchObject({ apiProvider: "gateway" });
    expect(summarizeCost({ projectId: "nobody" }).account).toBeNull();
  });
});

describe("the cost file survives a bad write", () => {
  it("a corrupt file is moved aside, not silently replaced by an empty ledger", () => {
    const dir = process.env.MARVIN_DATA_DIR!;
    writeFileSync(join(dir, "cost-tracker.json"), '{"entries":[{"at":"2026-');
    recordTurnCost({ projectId: "p", costUsd: 1, tokenUsage: { input_tokens: 1 } });
    const aside = readdirSync(dir).filter((f) => f.startsWith("cost-tracker.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf-8")).toBe('{"entries":[{"at":"2026-');
    expect(JSON.parse(readFileSync(join(dir, "cost-tracker.json"), "utf-8")).entries).toHaveLength(1);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(existsSync(join(dir, "cost-tracker.json"))).toBe(true);
  });
});

describe("plan windows", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const sec = (iso: string) => Date.parse(iso) / 1000;

  it("drops a window whose refill time passed and that was not reported since", () => {
    const views = visibleWindows(
      [
        { type: "five_hour", status: "allowed", utilization: 0.3, resetsAt: sec("2026-10-31T09:00:00Z"), at: "2026-10-31T08:00:00Z" },
        { type: "seven_day", status: "allowed", utilization: 0.5, resetsAt: sec("2026-11-03T00:00:00Z"), at: "2026-10-31T08:00:00Z" },
      ],
      undefined,
      now,
    );
    expect(views.map((w) => w.type)).toEqual(["seven_day"]);
  });

  it("keeps a past-reset window the server re-reported after the reset, and one with no reset time", () => {
    const views = visibleWindows(
      [
        { type: "five_hour", status: "allowed", resetsAt: sec("2026-10-31T09:00:00Z"), at: "2026-10-31T11:00:00Z" },
        { type: "overage", status: "allowed", at: "2026-10-01T00:00:00Z" },
      ],
      undefined,
      now,
    );
    expect(views.map((w) => w.type)).toEqual(["five_hour", "overage"]);
  });

  it("marks — does not hide — a window absent from the newest sized report (verified Ultra's five_hour)", () => {
    recordClaudeRateLimit({
      status: "allowed", rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 4_000_000_000 }, seven_day: { utilization: 0.4, resetsAt: 4_000_000_000 } },
    });
    // The server stops sizing five_hour; the headline may still name it.
    recordClaudeRateLimit({
      status: "allowed", rateLimitType: "five_hour",
      unifiedWindows: { seven_day: { utilization: 0.41, resetsAt: 4_000_000_000 }, seven_day_overage_included: { utilization: 0.1 } },
    });
    const w = summarizeCost().claudeRateLimits;
    expect(w.map((x) => [x.type, x.inLatestReport])).toEqual([
      ["five_hour", false],
      ["seven_day", true],
      ["seven_day_overage_included", true],
    ]);
  });

  it("a headline-only event (older CLI) never marks anything absent", () => {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 });
    expect(summarizeCost().claudeRateLimits[0]?.inLatestReport).toBeNull();
  });

  it("every window carries its last-reported time", () => {
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4 });
    expect(Date.parse(summarizeCost().claudeRateLimits[0]!.at)).toBeGreaterThan(0);
  });
});

describe("window labels", () => {
  it.each([
    ["five_hour", "current session"],
    ["seven_day", "current week (all models)"],
    ["seven_day_overage_included", "current week (incl. overage)"],
    ["seven_day_opus", "current week (Opus)"],
    ["seven_day_sonnet", "current week (Sonnet)"],
    ["seven_day_fable", "current week (Fable)"],
    ["thirty_day", "30-day window"],
    ["five_hour_opus", "current session (Opus)"],
    ["14_days", "14-day window"],
    ["some_new_thing", "some new thing"],
  ])("%s → %s", (type, label) => {
    expect(windowLabel(type)).toBe(label);
  });
});

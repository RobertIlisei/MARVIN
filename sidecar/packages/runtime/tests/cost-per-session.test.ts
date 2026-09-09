// ADR-0107 — cost is attributable per session. Entries recorded before
// sessions were tagged still count for the project; they are simply not any
// session's.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordTurnCost, sessionCostTotals, summarizeCost } from "../src/cost-tracker";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-cost-session-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("per-session cost", () => {
  it("sums turns and cost per session, ignores untagged legacy entries per session", () => {
    recordTurnCost({ projectId: "p", marvinSessionId: "a", costUsd: 0.1, tokenUsage: { input_tokens: 1 } });
    recordTurnCost({ projectId: "p", marvinSessionId: "a", costUsd: 0.2, tokenUsage: { input_tokens: 1 } });
    recordTurnCost({ projectId: "p", marvinSessionId: "b", costUsd: 1, tokenUsage: { input_tokens: 1 } });
    recordTurnCost({ projectId: "p", costUsd: 5, tokenUsage: { input_tokens: 1 } }); // pre-0107 shape
    recordTurnCost({ projectId: "other", marvinSessionId: "a", costUsd: 9, tokenUsage: { input_tokens: 1 } });

    const totals = sessionCostTotals("p");
    expect(totals.get("a")).toEqual({ turns: 2, costUsd: expect.closeTo(0.3, 6) });
    expect(totals.get("b")).toEqual({ turns: 1, costUsd: 1 });
    expect(totals.size).toBe(2);
  });

  it("summarizeCost narrows to one session, and still to the whole project", () => {
    expect(summarizeCost({ projectId: "p", marvinSessionId: "a" }).lifetime.turns).toBe(2);
    expect(summarizeCost({ projectId: "p" }).lifetime.turns).toBe(4);
    expect(summarizeCost({ projectId: "p" }).lifetime.costUsd).toBeCloseTo(6.3, 6);
  });
});

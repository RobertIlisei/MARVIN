import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0127 §6 — a tab turn the supervisor started spends against its daily
// cap whether it completes or not. A supervisor-started turn that errors after
// the SDK priced it spent real money; before this, only completed turns were
// charged, so a tab whose supervisor-nudged turns kept failing spent outside
// the cap. Through the real orchestrator with only the SDK turn stubbed.

type Result = { ok: boolean; error?: string; costUsd?: number; sessionId?: string; tokenUsage?: Record<string, number> };
let results: Result[];
let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const base = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sv-spend-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sv-spend-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  results = [];
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return { ...orig, runAgent: async () => results.shift() ?? { ok: true, costUsd: 0 } };
  });
});
afterEach(async () => {
  // The supervisor store is pinned on globalThis, so it outlives resetModules.
  (await import("@marvin/runtime/supervisor-state")).resetSupervisorStateForTests();
  vi.doUnmock("@marvin/runtime/sdk-runner");
  vi.resetModules();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function turn(id: string, result: Result, author?: "supervisor") {
  const { registerLiveTurn } = await import("@marvin/runtime/turn-registry");
  const { runDetachedTurn } = await import("../src/lib/turn-orchestrator");
  const { upsertSessionMeta } = await import("@marvin/runtime/session-meta");
  upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: base });
  results.push(result);
  const liveTurn = registerLiveTurn({ turnId: id, marvinSessionId: "tab-s", projectId: "proj", kind: author ? "machine" : "human", ...(author ? { author } : {}) });
  await runDetachedTurn({ liveTurn, projectId: "proj", marvinSessionId: "tab-s", turnId: id, message: "m", cwd: workDir, workDir, model: base.model, permissionStrategy: "auto", mode: "agent", thinkingMode: "high", appendSystemPrompt: "", personality: "ultron" });
}

const tokens = { input_tokens: 10, output_tokens: 5 };

describe("supervisor-started tab turns that fail", () => {
  it("charge what the SDK priced to the supervisor's daily cap", async () => {
    await turn("t1", { ok: false, error: "boom", costUsd: 0.4, sessionId: "sdk-1", tokenUsage: tokens }, "supervisor");
    const { getSupervisorState } = await import("@marvin/runtime/supervisor-state");
    expect(getSupervisorState("proj").spend.tabsUsd).toBeCloseTo(0.4);
  });

  it("are not counted twice when the session's next turn completes", async () => {
    await turn("t1", { ok: false, error: "boom", costUsd: 0.4, sessionId: "sdk-1", tokenUsage: tokens }, "supervisor");
    await turn("t2", { ok: true, costUsd: 0.5, sessionId: "sdk-1", tokenUsage: tokens });
    const { getSupervisorState } = await import("@marvin/runtime/supervisor-state");
    const { sessionCostTotals } = await import("@marvin/runtime/cost-tracker");
    expect(getSupervisorState("proj").spend.tabsUsd).toBeCloseTo(0.4);
    // 0.4 for the failed turn + 0.1 for the completed one: the session's true 0.5.
    expect(sessionCostTotals("proj").get("tab-s")?.costUsd).toBeCloseTo(0.5);
  });

  it("a user's failed turn is not the supervisor's spend", async () => {
    await turn("t1", { ok: false, error: "boom", costUsd: 0.4, sessionId: "sdk-1", tokenUsage: tokens });
    const { getSupervisorState } = await import("@marvin/runtime/supervisor-state");
    expect(getSupervisorState("proj").spend.tabsUsd).toBe(0);
  });
});

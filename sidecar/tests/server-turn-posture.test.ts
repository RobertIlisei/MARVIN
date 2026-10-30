import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0127 §9 — integration through the real orchestrator, with only the SDK
// turn (`runAgent`) stubbed so the test can see the posture each turn starts
// with:
//   - a wakeup / job-completion / resume turn in a Plan tab starts in Plan
//     mode — the mode used to be dropped, so every such turn ran as Agent;
//   - a narrowing set through the posture route while a turn runs survives
//     into the queued turn that follows it.

type RunInput = Record<string, unknown>;
let captured: RunInput[];
let onRun: ((input: RunInput) => void) | null;
let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

const base = {
  model: "claude-opus-5-5",
  advisorModel: null,
  personality: "ultron" as const,
  permissionStrategy: "auto" as const,
  thinkingMode: "high",
  mode: "agent" as const,
};

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-stp-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-stp-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  captured = [];
  onRun = null;
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return {
      ...orig,
      runAgent: async (input: RunInput) => {
        captured.push(input);
        onRun?.(input);
        return { ok: true, costUsd: 0 };
      },
    };
  });
});
afterEach(() => {
  vi.doUnmock("@marvin/runtime/sdk-runner");
  vi.resetModules();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("server-started turns keep the tab's posture", () => {
  it("a Plan tab's wakeup turn starts in Plan mode, and the gate for that turn refuses a write", async () => {
    const { upsertSessionMeta } = await import("@marvin/runtime/session-meta");
    const { startScheduledTurn } = await import("../src/lib/turn-orchestrator");
    const { makeAutoModeLogger } = await import("@marvin/runtime/sdk-runner");
    upsertSessionMeta("proj", "tab-plan", { workDir, tree: { mode: "shared" }, posture: { ...base, mode: "plan" } });

    await startScheduledTurn({
      id: "w1",
      marvinSessionId: "tab-plan",
      projectId: "proj",
      cwd: workDir,
      workDir,
      model: base.model,
      advisorModel: null,
      personality: "ultron",
      permissionStrategy: "auto",
      thinkingMode: "high",
      prompt: "check the build",
      reason: "test",
      createdAt: new Date().toISOString(),
      fireAt: Date.now(),
      depth: 0,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ mode: "plan", permissionStrategy: "auto" });
    // runAgent builds its gate read-only for plan / ask; that gate refuses a write.
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: "t-plan", readOnly: true, mode: "plan", permissionStrategy: "auto" });
    const r = await gate("Write", { file_path: path.join(workDir, "x.ts"), content: "x" }, { toolUseID: "w", signal: new AbortController().signal } as never);
    expect(r?.behavior).toBe("deny");
  });

  it("a narrowing applied during a turn survives into the queued turn that follows", async () => {
    const { upsertSessionMeta } = await import("@marvin/runtime/session-meta");
    const { registerLiveTurn } = await import("@marvin/runtime/turn-registry");
    const { enqueuePending } = await import("@marvin/runtime/pending-input");
    const { applyPostureChange } = await import("@marvin/runtime/posture");
    const { runDetachedTurn } = await import("../src/lib/turn-orchestrator");
    upsertSessionMeta("proj", "tab-q", { workDir, tree: { mode: "shared" }, posture: base });

    onRun = () => {
      if (captured.length !== 1) return;
      // While the first turn runs: a supervisor narrows the tab, and the user queues a message.
      const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-q", patch: { permissionStrategy: "gated", mode: "ask" }, actor: "supervisor", lookup: () => null });
      expect(r.ok).toBe(true);
      enqueuePending("proj", "tab-q", "and then this");
    };
    const liveTurn = registerLiveTurn({ turnId: "t1", marvinSessionId: "tab-q", projectId: "proj" });
    await runDetachedTurn({
      liveTurn,
      projectId: "proj",
      marvinSessionId: "tab-q",
      turnId: "t1",
      message: "first",
      cwd: workDir,
      workDir,
      model: base.model,
      permissionStrategy: "auto",
      mode: "agent",
      thinkingMode: "high",
      appendSystemPrompt: "",
      personality: "ultron",
    });
    await vi.waitFor(() => expect(captured).toHaveLength(2), { timeout: 5_000 });
    expect(captured[0]).toMatchObject({ permissionStrategy: "auto", mode: "agent" });
    expect(captured[1]).toMatchObject({ permissionStrategy: "gated", mode: "ask" });
  });
});

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

describe("POST /api/chat honours a posture set without a turn", () => {
  async function setup(id: string) {
    const { addProject } = await import("@marvin/runtime/projects");
    const { upsertSessionMeta } = await import("@marvin/runtime/session-meta");
    const project = addProject({ name: "p", workDir });
    upsertSessionMeta(project.id, id, { workDir, tree: { mode: "shared" }, posture: base });
    return project.id;
  }
  async function chat(projectId: string, id: string, extra: Record<string, unknown> = {}) {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(
      new NextRequest("http://localhost:3030/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-marvin-client": "1" },
        body: JSON.stringify({ message: "go", cwd: workDir, projectId, marvinSessionId: id, permissionStrategy: "auto", mode: "agent", ...extra }),
      }),
    );
    expect(res.status).toBeLessThan(300);
  }
  async function turnEnded(id: string) {
    const { getLiveTurn } = await import("@marvin/runtime/turn-registry");
    await vi.waitFor(() => expect(getLiveTurn(id)?.ended ?? true).toBe(true), { timeout: 5_000 });
  }

  it("the next user-sent turn runs under the API-set posture until the client echoes its revision, and the hold is on turn.started", async () => {
    const projectId = await setup("tab-c");
    const { applyPostureChange } = await import("@marvin/runtime/posture");
    const { loadSession } = await import("@marvin/runtime/session");
    const { readSessionMeta } = await import("@marvin/runtime/session-meta");
    expect(applyPostureChange({ projectId, marvinSessionId: "tab-c", patch: { mode: "plan", permissionStrategy: "gated" }, actor: "user", lookup: () => null }).ok).toBe(true);

    await chat(projectId, "tab-c"); // the app posts auto / agent and has not seen revision 1
    await vi.waitFor(() => expect(captured).toHaveLength(1), { timeout: 5_000 });
    expect(captured[0]).toMatchObject({ mode: "plan", permissionStrategy: "gated" });
    const started = loadSession(projectId, "tab-c")?.turns.find((t) => t.type === "turn.started");
    expect(started).toMatchObject({ postureHeld: { mode: "plan", permissionStrategy: "gated" }, postureSource: "user" });
    await turnEnded("tab-c");

    await chat(projectId, "tab-c", { postureRevision: 999 }); // clamped to the issued revision
    await vi.waitFor(() => expect(captured).toHaveLength(2), { timeout: 5_000 });
    expect(captured[1]).toMatchObject({ mode: "agent", permissionStrategy: "auto" });
    expect(readSessionMeta(projectId, "tab-c")?.postureAck).toBe(1);
    await turnEnded("tab-c");
  });

  it("a session that never used the posture route runs exactly the posture the client posts", async () => {
    const projectId = await setup("tab-n");
    await chat(projectId, "tab-n", { permissionStrategy: "gated", mode: "ask" });
    await vi.waitFor(() => expect(captured).toHaveLength(1), { timeout: 5_000 });
    expect(captured[0]).toMatchObject({ mode: "ask", permissionStrategy: "gated" });
    await turnEnded("tab-n");
  });
});

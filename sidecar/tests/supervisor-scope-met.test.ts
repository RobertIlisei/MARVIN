import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0127 milestone 4 — `scopeMetAt`, through the real orchestrator with only
// the SDK turn stubbed. A turn ending with the scope-met marker writes it; a
// user turn or a supervisor-authored turn clears it (new scope); a job
// completion — a machine turn — leaves it, so the completion is recognisably
// superseded by the close. The supervisor reads it to stay away from a tab
// that has finished (stale completions cost $12–57 a turn on 2026-10-30).

let results: Array<{ ok: true; costUsd: number; scopeMet?: boolean }>;
let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const base = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-scope-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-scope-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  results = [];
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return { ...orig, runAgent: async () => results.shift() ?? { ok: true, costUsd: 0 } };
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

async function turn(id: string, o: { kind: "human" | "machine"; author?: "supervisor"; scopeMet?: boolean }) {
  const { registerLiveTurn } = await import("@marvin/runtime/turn-registry");
  const { runDetachedTurn } = await import("../src/lib/turn-orchestrator");
  results.push({ ok: true, costUsd: 0, ...(o.scopeMet ? { scopeMet: true } : {}) });
  const liveTurn = registerLiveTurn({ turnId: id, marvinSessionId: "tab-s", projectId: "proj", kind: o.kind, ...(o.author ? { author: o.author } : {}) });
  await runDetachedTurn({ liveTurn, projectId: "proj", marvinSessionId: "tab-s", turnId: id, message: "m", cwd: workDir, workDir, model: base.model, permissionStrategy: "auto", mode: "agent", thinkingMode: "high", appendSystemPrompt: "", personality: "ultron" });
}

describe("scopeMetAt", () => {
  it("is written by a scope-met close, survives a job completion, and is cleared by the next user turn", async () => {
    const { upsertSessionMeta, readSessionMeta } = await import("@marvin/runtime/session-meta");
    upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: base });

    await turn("t1", { kind: "human", scopeMet: true });
    const closedAt = readSessionMeta("proj", "tab-s")?.scopeMetAt;
    expect(typeof closedAt).toBe("string");

    // A stale background-job completion arrives after the close: superseded, not new scope.
    await turn("t2", { kind: "machine" });
    expect(readSessionMeta("proj", "tab-s")?.scopeMetAt).toBe(closedAt);

    await turn("t3", { kind: "human" });
    expect(readSessionMeta("proj", "tab-s")?.scopeMetAt).toBeUndefined();
  });

  it("a supervisor-authored turn opens new scope too", async () => {
    const { upsertSessionMeta, readSessionMeta } = await import("@marvin/runtime/session-meta");
    upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: base });
    await turn("t1", { kind: "human", scopeMet: true });
    await turn("t2", { kind: "machine", author: "supervisor" });
    expect(readSessionMeta("proj", "tab-s")?.scopeMetAt).toBeUndefined();
  });

  it("the supervisor's send verb reads it: a nudge to that tab is refused", async () => {
    const { upsertSessionMeta } = await import("@marvin/runtime/session-meta");
    const { defaultVerbDeps } = await import("@marvin/runtime/supervisor-loop");
    upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: base });
    await turn("t1", { kind: "human", scopeMet: true });
    expect(defaultVerbDeps("proj", workDir).scopeMet("tab-s")).toBe(true);
    await turn("t2", { kind: "human" });
    expect(defaultVerbDeps("proj", workDir).scopeMet("tab-s")).toBe(false);
  });
});

describe("a scope-met claim the ADR-0057 guard rejects is not scope met", () => {
  it("reportsScopeMet needs the marker and an accepted claim", async () => {
    const { reportsScopeMet } = await import("@marvin/runtime/sdk-runner");
    const closing = "Done.\n\n**Scope met:** all of it.\n<!-- marvin:scope-met -->";
    expect(reportsScopeMet(closing, false)).toBe(true);
    expect(reportsScopeMet(closing, true)).toBe(false);
    expect(reportsScopeMet("Still working on step 3.", false)).toBe(false);
  });
});

// ADR-0127 §5 — a supervisor cancel names its author everywhere it leaves a
// record, and parks the tab for the user rather than reading as their Stop.
describe("a supervisor cancel is the supervisor's, never the user's Stop", () => {
  it("transcript, meta, watch row and send refusal all say so", async () => {
    vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
      const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
      return {
        ...orig,
        runAgent: async (input: { signal?: AbortSignal }) => {
          await new Promise<void>((r) => (input.signal?.aborted ? r() : input.signal?.addEventListener("abort", () => r())));
          return { ok: false, error: "Claude Code process aborted by user" };
        },
      };
    });
    const { upsertSessionMeta, readSessionMeta } = await import("@marvin/runtime/session-meta");
    const { registerLiveTurn, cancelLiveTurn, SUPERVISOR_CANCEL_MESSAGE } = await import("@marvin/runtime/turn-registry");
    const { runDetachedTurn } = await import("../src/lib/turn-orchestrator");
    const { tabSendRefusal } = await import("@marvin/runtime/supervisor-send");
    const { buildSessionWatch } = await import("@marvin/runtime/session-watch");
    const { marvinPaths } = await import("@marvin/runtime/paths");
    const { readFileSync } = await import("node:fs");
    upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: base });
    const liveTurn = registerLiveTurn({ turnId: "tc", marvinSessionId: "tab-s", projectId: "proj", kind: "machine" });
    const running = runDetachedTurn({ liveTurn, projectId: "proj", marvinSessionId: "tab-s", turnId: "tc", message: "m", cwd: workDir, workDir, model: base.model, permissionStrategy: "auto", mode: "agent", thinkingMode: "high", appendSystemPrompt: "", personality: "ultron" });
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelLiveTurn("tab-s", "supervisor")).toBe(true);
    await running;

    const meta = readSessionMeta("proj", "tab-s");
    expect(meta?.lastTurn).toMatchObject({ outcome: "stopped", stoppedBy: "supervisor" });
    const lines = readFileSync(marvinPaths.sessionFile("proj", "tab-s"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; error?: string });
    expect(lines.find((l) => l.type === "turn.error")?.error).toBe(SUPERVISOR_CANCEL_MESSAGE);
    expect(tabSendRefusal("proj", "tab-s")?.reason).toMatch(/supervisor cancelled/);
    const [row] = await buildSessionWatch({ projectId: "proj", workDir, sessionIds: ["tab-s"] });
    expect(row?.supervisor.stoppedByUser).toBe(false);
  });
});

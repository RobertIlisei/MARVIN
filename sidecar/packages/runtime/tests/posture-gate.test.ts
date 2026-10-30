import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPostureChange, clearLiveNarrowing } from "../src/posture";
import { type AgentMode, makeAutoModeLogger, makeGatedCanUseTool, makeLivePostureGate, type PermissionStrategy } from "../src/sdk-runner";
import { type SessionPosture, upsertSessionMeta } from "../src/session-meta";
import { buildResumeRecord } from "../src/session-recovery";
import { buildSessionWatch } from "../src/session-watch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";

// ADR-0127 §9 — a narrowing set through the posture route while a turn runs
// takes effect at that turn's NEXT tool call: to `gated`, a write raises a
// confirm; to `ask`, it is denied. Exercised through the real gates.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const confirms: string[] = [];

const base: SessionPosture = {
  model: "claude-opus-5-5",
  advisorModel: null,
  personality: "ultron",
  permissionStrategy: "auto",
  thinkingMode: "high",
  mode: "agent",
};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-pg-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-pg-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  confirms.length = 0;
});
afterEach(() => {
  clearLiveNarrowing("turn-pg");
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const meta = (id: string) => ({ toolUseID: id, signal: new AbortController().signal }) as never;

function turnGate() {
  const onConfirmRequest = (req: { toolName: string }) => {
    confirms.push(req.toolName);
  };
  // The same construction runAgent uses for a moved-to posture.
  const gateFor = (s: PermissionStrategy, m: AgentMode) => {
    const readOnly = m === "ask" || m === "plan";
    return s === "gated"
      ? makeGatedCanUseTool({ cwd: workDir, workDir, turnId: "turn-pg", onConfirmRequest, readOnly, mode: m })
      : makeAutoModeLogger({ cwd: workDir, workDir, turnId: "turn-pg", readOnly, mode: m, permissionStrategy: s, onConfirmRequest });
  };
  return makeLivePostureGate({ turnId: "turn-pg", permissionStrategy: "auto", mode: "agent", gateFor });
}

describe("a narrowing reaches the live turn at its next tool call", () => {
  it("auto → gated: the next write raises a confirm instead of running", async () => {
    upsertSessionMeta("proj", "tab-pg", { workDir, tree: { mode: "shared" }, posture: base });
    const turn = registerLiveTurn({ turnId: "turn-pg", marvinSessionId: "tab-pg", projectId: "proj" });
    const gate = turnGate();
    const edit = { file_path: path.join(workDir, "a.ts"), old_string: "a", new_string: "b" };

    expect((await gate("Edit", edit, meta("e1")))?.behavior).toBe("allow");

    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-pg", patch: { permissionStrategy: "gated" }, actor: "user", lookup: () => null });
    expect(r.ok && r.liveApplied).toEqual(["permissionStrategy"]);
    let settled = false;
    void gate("Edit", edit, meta("e2")).then(() => {
      settled = true;
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(confirms).toEqual(["Edit"]);
    expect(settled).toBe(false);
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("agent → ask: the next write is denied", async () => {
    upsertSessionMeta("proj", "tab-pg", { workDir, tree: { mode: "shared" }, posture: base });
    const turn = registerLiveTurn({ turnId: "turn-pg", marvinSessionId: "tab-pg", projectId: "proj" });
    const gate = turnGate();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-pg", patch: { mode: "ask" }, actor: "user", lookup: () => null });
    const r = await gate("Write", { file_path: path.join(workDir, "b.ts"), content: "x" }, meta("w1"));
    expect(r?.behavior).toBe("deny");
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("a widening during the turn does not reach it", async () => {
    upsertSessionMeta("proj", "tab-pg", { workDir, tree: { mode: "shared" }, posture: { ...base, permissionStrategy: "gated" } });
    const turn = registerLiveTurn({ turnId: "turn-pg", marvinSessionId: "tab-pg", projectId: "proj" });
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-pg", patch: { permissionStrategy: "full" }, actor: "user", lookup: () => null });
    expect(r.ok && r.liveApplied).toEqual([]);
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("runAgent wires the live gate and clears it when the turn ends (a wiring pin: runAgent needs the SDK)", () => {
    const src = readFileSync(path.join(__dirname, "../src/sdk-runner.ts"), "utf8");
    expect(src).toMatch(/canUseTool: makeLivePostureGate\(\{ turnId, permissionStrategy, mode, gateFor \}\)/);
    expect(src).toMatch(/clearTurnConfirms\(turnId\);\n\s+clearLiveNarrowing\(turnId\);/);
  });
});

describe("server-started turns keep the tab's mode (end to end: sidecar/tests/server-turn-posture.test.ts)", () => {
  it("a resume record carries the mode from the session meta", () => {
    upsertSessionMeta("proj", "tab-plan", { workDir, tree: { mode: "shared" }, posture: { ...base, mode: "plan" } });
    const m = JSON.parse(readFileSync(path.join(dataDir, "sessions", "proj", "tab-plan.meta.json"), "utf8"));
    expect(buildResumeRecord(m).mode).toBe("plan");
  });

});

describe("the watch row carries the posture revision a client echoes", () => {
  it("null for a session that never used the route; the revision after it did", async () => {
    upsertSessionMeta("proj", "tab-w", { workDir, tree: { mode: "shared" }, posture: base });
    let [row] = await buildSessionWatch({ projectId: "proj", workDir, sessionIds: ["tab-w"] });
    expect(row?.postureRevision).toBeNull();
    expect(row?.postureSource).toBeNull();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-w", patch: { mode: "ask" }, actor: "user", lookup: () => null });
    [row] = await buildSessionWatch({ projectId: "proj", workDir, sessionIds: ["tab-w"], fresh: true });
    expect(row?.postureRevision).toBe(1);
    expect(row?.postureSource).toBe("user");
    expect(row?.posture?.mode).toBe("ask");
  });
});

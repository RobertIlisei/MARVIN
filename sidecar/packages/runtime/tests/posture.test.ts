import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ackRevision,
  apiPostureHold,
  applyPostureChange,
  classifyPostureChange,
  getLiveNarrowing,
  isNarrowing,
  type ModelLookup,
  scheduledTurnPosture,
  validatePosturePatch,
} from "../src/posture";
import { readSessionMeta, type SessionPosture, upsertSessionMeta } from "../src/session-meta";
import { readLedger } from "../src/supervisor-ledger";
import { bootSupervisor, resetSupervisorStateForTests } from "../src/supervisor-state";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";

// ADR-0127 §9 / ADR-0108 amendment — a tab's posture can change without a
// turn; the change is versioned so the app's next post does not silently
// undo it; a supervisor may only narrow; and a narrowing reaches a live turn.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-posture-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const lookup: ModelLookup = (id) =>
  (
    ({
      "claude-opus-5-5": { tier: "opus" },
      "claude-sonnet-5-5": { tier: "sonnet" },
      "claude-haiku-4-5": { tier: "haiku" },
      "or/cheap": { tier: "other", pricing: { prompt: "0.000001" } },
      "or/dear": { tier: "other", pricing: { prompt: "0.00002" } },
    }) as Record<string, { tier: string; pricing?: { prompt: string } }>
  )[id] ?? null;

const base: SessionPosture = {
  model: "claude-opus-5-5",
  advisorModel: null,
  personality: "ultron",
  permissionStrategy: "auto",
  thinkingMode: "high",
  mode: "agent",
};

function seedMeta(id = "tab-1", posture: SessionPosture = base) {
  upsertSessionMeta("proj", id, { workDir: dataDir, tree: { mode: "shared" }, posture });
}

describe("validatePosturePatch", () => {
  it("accepts the four API-settable fields", () => {
    expect(validatePosturePatch({ model: "claude-sonnet-5-5", thinkingMode: "low", permissionStrategy: "gated", mode: "ask" })).toEqual({
      ok: true,
      patch: { model: "claude-sonnet-5-5", thinkingMode: "low", permissionStrategy: "gated", mode: "ask" },
    });
  });
  it.each([
    [{}, /at least one/],
    [{ personality: "marvin" }, /personality/],
    [{ thinkingMode: "turbo" }, /thinkingMode/],
    [{ permissionStrategy: "yolo" }, /permissionStrategy/],
    [{ mode: "god" }, /mode/],
    [{ model: "rm -rf /" }, /model/],
    ["nope", /object/],
  ])("refuses %j", (input, error) => {
    const r = validatePosturePatch(input);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(error);
  });
});

describe("narrowing vs widening — explicit orders", () => {
  it.each([
    [{ permissionStrategy: "gated" }, "narrow"],
    [{ permissionStrategy: "full" }, "widen"],
    [{ mode: "plan" }, "narrow"],
    [{ mode: "ask" }, "narrow"],
    [{ thinkingMode: "low" }, "narrow"],
    [{ thinkingMode: "max" }, "widen"],
    [{ model: "claude-sonnet-5-5" }, "narrow"],
    [{ model: "claude-haiku-4-5" }, "narrow"],
    [{ model: "unknown/model" }, "widen"], // unpriced → widening
    [{ model: "claude-opus-5-5" }, "same"],
  ] as const)("from auto/agent/high/opus: %j → %s", (patch, direction) => {
    const [change] = classifyPostureChange(base, patch, lookup);
    expect(change?.direction).toBe(direction);
  });

  it.each([
    [{ ...base, permissionStrategy: "gated" as const }, { permissionStrategy: "auto" as const }, "widen"],
    [{ ...base, permissionStrategy: "full" as const }, { permissionStrategy: "auto" as const }, "narrow"],
    [{ ...base, mode: "plan" as const }, { mode: "agent" as const }, "widen"], // Plan → Agent is how plan approval is expressed
    // Plan and Ask share the read-only gate; Plan runs the advisor model, Ask the executor.
    [{ ...base, mode: "plan" as const }, { mode: "ask" as const }, "same"], // no advisor: same model
    [{ ...base, mode: "ask" as const }, { mode: "plan" as const }, "same"],
    [{ ...base, model: "claude-sonnet-5-5", advisorModel: "claude-opus-5-5", mode: "plan" as const }, { mode: "ask" as const }, "narrow"],
    [{ ...base, model: "claude-sonnet-5-5", advisorModel: "claude-opus-5-5", mode: "ask" as const }, { mode: "plan" as const }, "widen"],
    [{ ...base, model: "claude-opus-5-5", advisorModel: "claude-sonnet-5-5", mode: "plan" as const }, { mode: "ask" as const }, "widen"],
    [{ ...base, model: "claude-haiku-4-5" }, { model: "claude-opus-5-5" }, "widen"],
    [{ ...base, model: "or/dear" }, { model: "or/cheap" }, "narrow"],
    [{ ...base, model: "or/cheap" }, { model: "or/dear" }, "widen"],
    [{ ...base, model: "or/cheap" }, { model: "claude-haiku-4-5" }, "widen"], // no common price scale → unpriced
  ])("%j with %j → %s", (from, patch, direction) => {
    expect(classifyPostureChange(from, patch, lookup)[0]?.direction).toBe(direction);
  });

  it("isNarrowing is true only when no field widens", () => {
    expect(isNarrowing(base, { permissionStrategy: "gated", mode: "ask", thinkingMode: "low" }, lookup)).toBe(true);
    expect(isNarrowing(base, { permissionStrategy: "gated", thinkingMode: "max" }, lookup)).toBe(false);
  });
});

describe("applyPostureChange — no turn sent, versioned, supervisor narrows only", () => {
  it("refuses a session with no meta", () => {
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "nope", patch: { mode: "ask" }, actor: "user", lookup });
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.status).toBe(404);
  });

  it("a user change is stored with a revision and a source, and holds the fields it set", () => {
    seedMeta();
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated", thinkingMode: "low" }, actor: "user", lookup });
    expect(r.ok).toBe(true);
    const meta = readSessionMeta("proj", "tab-1");
    expect(meta?.posture).toMatchObject({ permissionStrategy: "gated", thinkingMode: "low", mode: "agent" });
    expect(meta?.postureRevision).toBe(1);
    expect(meta?.postureSource).toBe("user");
    expect(meta?.postureOverride).toEqual({ permissionStrategy: "gated", thinkingMode: "low" });
  });

  // Until milestone 6 the app does not show an API-set posture, so a widening
  // through the API would run a tab wider than its toolbar says (ADR-0127 §4:
  // widening is human-only, and a hidden widening is the worst case).
  it.each([
    [{ permissionStrategy: "full" as const }, ["permissionStrategy"]],
    [{ thinkingMode: "max" }, ["thinkingMode"]],
    [{ model: "unknown/model" }, ["model"]],
    [{ permissionStrategy: "gated" as const, thinkingMode: "max", mode: "agent" as const }, ["mode", "thinkingMode"]],
  ])("a user widening %j is refused, names %j, and changes nothing", (patch, widened) => {
    seedMeta("tab-1", { ...base, mode: "plan" });
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch, actor: "user", lookup });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    for (const field of widened) expect(r.error).toContain(field);
    expect(r.error).not.toContain("permissionStrategy auto → gated");
    expect(r.changes?.filter((c) => c.direction === "widen").map((c) => c.field)).toEqual(widened);
    expect(readSessionMeta("proj", "tab-1")?.postureRevision).toBeUndefined();
    expect(readSessionMeta("proj", "tab-1")?.posture.mode).toBe("plan");
    expect(readLedger("proj")).toEqual([]); // the user's refusal is not a supervisor act
  });

  it("a supervisor narrowing passes and is ledgered as a performed act, with the caller's grounds", () => {
    seedMeta();
    const r = applyPostureChange({
      projectId: "proj",
      marvinSessionId: "tab-1",
      patch: { mode: "ask" },
      actor: "supervisor",
      lookup,
      ledger: { mode: "autonomous", grounds: [{ kind: "charter", ref: "read-only today", provenance: "unresolved" }] },
    });
    expect(r.ok).toBe(true);
    expect(readSessionMeta("proj", "tab-1")?.posture.mode).toBe("ask");
    expect(readLedger("proj").at(-1)).toMatchObject({
      verb: "set_posture",
      decision: "act",
      mode: "autonomous",
      tab: "tab-1",
      grounds: [{ kind: "charter", ref: "read-only today" }],
    });
  });

  it.each([
    [{ permissionStrategy: "full" as const }],
    [{ thinkingMode: "max" }],
    [{ model: "unknown/model" }],
    [{ mode: "agent" as const }],
  ])("a supervisor widening %j escalates and changes nothing", (patch) => {
    seedMeta("tab-1", { ...base, mode: "plan" });
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch, actor: "supervisor", lookup });
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.status).toBe(409);
    expect(readSessionMeta("proj", "tab-1")?.postureRevision).toBeUndefined();
    expect(readLedger("proj").at(-1)).toMatchObject({ verb: "set_posture", decision: "escalate" });
  });

  it("two changes the app has not yet seen accumulate; once it has, a new change replaces the hold", () => {
    seedMeta();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { model: "claude-sonnet-5-5" }, actor: "user", lookup });
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { mode: "ask" }, actor: "user", lookup });
    expect(readSessionMeta("proj", "tab-1")?.postureOverride).toEqual({ model: "claude-sonnet-5-5", mode: "ask" });
    upsertSessionMeta("proj", "tab-1", { workDir: dataDir, tree: { mode: "shared" }, posture: base }, { postureAck: 2 });
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { thinkingMode: "low" }, actor: "user", lookup });
    expect(readSessionMeta("proj", "tab-1")?.postureOverride).toEqual({ thinkingMode: "low" });
    expect(readSessionMeta("proj", "tab-1")?.postureRevision).toBe(3);
  });

  it("during a live turn only the narrowing strategy/mode fields reach the turn", () => {
    seedMeta();
    const turn = registerLiveTurn({ turnId: "turn-live", marvinSessionId: "tab-1", projectId: "proj" });
    const r = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated", thinkingMode: "low" }, actor: "user", lookup });
    expect(r.ok && r.liveApplied).toEqual(["permissionStrategy"]);
    expect(getLiveNarrowing("turn-live")).toEqual({ permissionStrategy: "gated" });
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });
});

describe("ackRevision — a client cannot acknowledge a revision the server never issued", () => {
  it("clamps to the session's revision, and passes nothing through when nothing was sent", () => {
    seedMeta();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { mode: "ask" }, actor: "user", lookup });
    const meta = readSessionMeta("proj", "tab-1");
    expect(ackRevision(meta, 999)).toBe(1);
    expect(ackRevision(meta, 0)).toBe(0);
    expect(ackRevision(meta, -5)).toBe(0);
    expect(ackRevision(meta, undefined)).toBeUndefined();
    expect(apiPostureHold(meta, ackRevision(meta, 0))).toEqual({ mode: "ask" });
  });
});

describe("apiPostureHold — the chat route keeps an API-set posture until the app has seen it", () => {
  it("a session that never used the route holds nothing", () => {
    seedMeta();
    expect(apiPostureHold(readSessionMeta("proj", "tab-1"), undefined)).toBeNull();
  });

  it("holds the API-set fields over a client that has not echoed the revision, and yields once it has", () => {
    seedMeta();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { mode: "plan", permissionStrategy: "gated" }, actor: "user", lookup });
    const meta = readSessionMeta("proj", "tab-1");
    expect(apiPostureHold(meta, undefined)).toEqual({ mode: "plan", permissionStrategy: "gated" });
    expect(apiPostureHold(meta, 0)).toEqual({ mode: "plan", permissionStrategy: "gated" });
    expect(apiPostureHold(meta, 1)).toBeNull();
  });
});

describe("scheduledTurnPosture — a wakeup, job-completion or resume turn", () => {
  const record = { model: "claude-opus-5-5", permissionStrategy: "auto" as const, thinkingMode: "high" };

  it("runs in the tab's mode: a Plan or Ask tab stays read-only (the mode used to be dropped)", () => {
    expect(scheduledTurnPosture(record, { ...base, mode: "plan" }, undefined).mode).toBe("plan");
    expect(scheduledTurnPosture(record, { ...base, mode: "ask" }, undefined).mode).toBe("ask");
    expect(scheduledTurnPosture(record, null, undefined).mode).toBe("agent");
  });

  it("never runs wider than either the record or the tab — a narrowing applies, a widening does not elevate", () => {
    const narrowedTab = scheduledTurnPosture({ ...record, permissionStrategy: "full" }, { ...base, permissionStrategy: "gated", thinkingMode: "low" }, undefined);
    expect(narrowedTab).toMatchObject({ permissionStrategy: "gated", thinkingMode: "low" });
    const widenedTab = scheduledTurnPosture({ ...record, permissionStrategy: "gated", mode: "ask" }, { ...base, permissionStrategy: "full", mode: "agent" }, undefined);
    expect(widenedTab).toMatchObject({ permissionStrategy: "gated", mode: "ask" });
  });

  it("moves to a cheaper model the tab or the posture route set, never to a pricier one", () => {
    expect(scheduledTurnPosture(record, base, { model: "claude-sonnet-5-5" }, lookup).model).toBe("claude-sonnet-5-5");
    expect(scheduledTurnPosture(record, { ...base, model: "claude-haiku-4-5" }, undefined, lookup).model).toBe("claude-haiku-4-5");
    expect(scheduledTurnPosture({ ...record, model: "claude-sonnet-5-5" }, base, { model: "claude-opus-5-5" }, lookup).model).toBe("claude-sonnet-5-5");
    expect(scheduledTurnPosture(record, base, { model: "unknown/model" }, lookup).model).toBe("claude-opus-5-5");
    expect(scheduledTurnPosture(record, base, undefined).model).toBe("claude-opus-5-5");
  });
});

// ADR-0127 milestone 4 — with posture autonomy, the supervisor can narrow a tab
// while the app still neither echoes revisions nor widens through the API
// (milestone 6). The user's way back: restore a field the supervisor narrowed
// to exactly the value it had before — never anything wider.
describe("the user's escape from a supervisor narrowing", () => {
  it("restores a supervisor-narrowed field to its prior value, and only to that", () => {
    seedMeta();
    expect(applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated", mode: "plan" }, actor: "supervisor", lookup }).ok).toBe(true);
    expect(readSessionMeta("proj", "tab-1")?.postureBeforeSupervisor).toEqual({ permissionStrategy: "auto", mode: "agent" });

    // Wider than before: still refused.
    const wider = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "full" }, actor: "user", lookup });
    expect(wider.ok).toBe(false);
    // Exactly what it was: allowed, and the record of that field is spent.
    const back = applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "auto" }, actor: "user", lookup });
    expect(back.ok).toBe(true);
    const meta = readSessionMeta("proj", "tab-1");
    expect(meta?.posture.permissionStrategy).toBe("auto");
    expect(meta?.postureSource).toBe("user");
    expect(meta?.postureBeforeSupervisor).toEqual({ mode: "agent" });
    // The same widening again has nothing to restore.
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated" }, actor: "user", lookup });
    expect(applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "auto" }, actor: "user", lookup }).ok).toBe(false);
  });

  it("a second supervisor narrowing keeps the first prior value, and the supervisor can never use the escape", () => {
    seedMeta();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { thinkingMode: "medium" }, actor: "supervisor", lookup });
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { thinkingMode: "low" }, actor: "supervisor", lookup });
    expect(readSessionMeta("proj", "tab-1")?.postureBeforeSupervisor).toEqual({ thinkingMode: "high" });
    expect(applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { thinkingMode: "high" }, actor: "supervisor", lookup }).ok).toBe(false);
    expect(applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { thinkingMode: "high" }, actor: "user", lookup }).ok).toBe(true);
  });

  it("a field the user narrowed themselves is theirs: no restore of a supervisor value under it", () => {
    seedMeta();
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated" }, actor: "supervisor", lookup });
    applyPostureChange({ projectId: "proj", marvinSessionId: "tab-1", patch: { permissionStrategy: "gated" }, actor: "user", lookup });
    expect(readSessionMeta("proj", "tab-1")?.postureBeforeSupervisor).toBeUndefined();
  });
});

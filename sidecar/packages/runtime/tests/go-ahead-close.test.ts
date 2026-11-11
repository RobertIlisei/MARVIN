import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any import that reads the data dir: the practice rows live there.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-go-ahead-data-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetBuiltinCacheForTests, ensureBuiltinRules, readRules, updateRule } from "../src/practice";
import { decideGoAheadClose, makeTurnCloseStopHook, type TurnCloseFacts } from "../src/turn-close-hook";

// ADR-0132 decision 1 — the brief is the plan.
const ASK = "Shall I go ahead with step 1?";
const base: TurnCloseFacts = {
  mutations: 0,
  lastTodos: undefined,
  machineTurn: false,
  alreadyFired: false,
  mode: "agent",
  askedUserQuestion: false,
  seededOpenSteps: ["[1] write the migration", "[2] run it"],
  seededStepCount: 2,
};

describe("decideGoAheadClose", () => {
  it("blocks the recorded stall: a go-ahead question over a seeded spine in Agent mode, naming the first open step", () => {
    const d = decideGoAheadClose(`I read the brief. Two steps.\n\n${ASK}`, base);
    expect(d?.kind).toBe("go-ahead");
    expect(d?.reason).toContain("[1] write the migration");
    expect(d?.reason).toContain("stay open");
  });

  it("also blocks on a machine turn", () => {
    expect(decideGoAheadClose(ASK, { ...base, machineTurn: true })?.kind).toBe("go-ahead");
  });

  it("does not block in Plan or Ask mode", () => {
    expect(decideGoAheadClose(ASK, { ...base, mode: "plan" })).toBeNull();
    expect(decideGoAheadClose(ASK, { ...base, mode: "ask" })).toBeNull();
  });

  it("does not block with no seeded spine, or with every seeded step closed", () => {
    expect(decideGoAheadClose(ASK, { ...base, seededOpenSteps: undefined, seededStepCount: 0 })).toBeNull();
    expect(decideGoAheadClose(ASK, { ...base, seededOpenSteps: [] })).toBeNull();
  });

  it("does not block when AskUserQuestion was called", () => {
    expect(decideGoAheadClose(ASK, { ...base, askedUserQuestion: true })).toBeNull();
  });

  it("does not block when the question offers a choice, or is not a go-ahead question", () => {
    expect(decideGoAheadClose("Shall I start with step 1, or do step 3 first?", base)).toBeNull();
    expect(decideGoAheadClose("Which database should the migration target?", base)).toBeNull();
    expect(decideGoAheadClose(`${ASK} Or is the schema wrong?`, base)).toBeNull();
    expect(decideGoAheadClose("Done with step 1. Shall I go ahead with step 2? And should I update the docs?", base)).toBeNull();
  });

  it("does not block when this turn's TodoWrite added a step that does not join the spine", () => {
    const todos = (items: string[]) => items.map((content) => ({ content, status: "pending" }));
    const joined = { ...base, todoWrittenThisTurn: true, lastTodos: todos(["[1] write the migration", "[2] run it"]) };
    expect(decideGoAheadClose(ASK, joined)?.kind).toBe("go-ahead");
    expect(decideGoAheadClose(ASK, { ...joined, lastTodos: todos(["[1] write the migration", "also tidy the logs"]) })).toBeNull();
    expect(decideGoAheadClose(ASK, { ...joined, lastTodos: todos(["[1] write the migration", "[7] a step nobody seeded"]) })).toBeNull();
  });
});

describe("the go-ahead Stop hook", () => {
  const prev = process.env.MARVIN_DESIGN_HOOKS;
  const call = (hook: ReturnType<typeof makeTurnCloseStopHook>, text: string, active = false) =>
    hook(
      { hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: text, session_id: "s", transcript_path: "", cwd: "/" } as never,
      undefined,
      { signal: new AbortController().signal },
    ) as Promise<{ decision?: string; reason?: string }>;
  const make = (fired: string[] = []) =>
    makeTurnCloseStopHook({ turnId: "t", facts: () => ({ ...base }), onFired: (d) => fired.push(d.kind) });

  beforeEach(() => {
    delete process.env.MARVIN_DESIGN_HOOKS;
    ensureBuiltinRules();
    __resetBuiltinCacheForTests();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MARVIN_DESIGN_HOOKS;
    else process.env.MARVIN_DESIGN_HOOKS = prev;
  });

  it("ships at nudge: telemetry only, no block, no onFired", async () => {
    expect(readRules().find((r) => r.id === "builtin:go-ahead")?.tier).toBe("nudge");
    const fired: string[] = [];
    expect(await call(make(fired), ASK)).toEqual({});
    expect(fired).toEqual([]);
  });

  it("at deny blocks once per turn, never under stop_hook_active, and measure mode only records", async () => {
    updateRule("builtin:go-ahead", { tier: "deny" });
    __resetBuiltinCacheForTests();
    const fired: string[] = [];
    const hook = make(fired);
    expect(await call(hook, ASK, true)).toEqual({});
    const first = await call(hook, ASK);
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("ADR-0067");
    expect(await call(hook, ASK)).toEqual({});
    expect(fired).toEqual(["go-ahead"]);

    process.env.MARVIN_DESIGN_HOOKS = "measure";
    expect(await call(make(), ASK)).toEqual({});
  });

  it("a retired row switches it off", async () => {
    updateRule("builtin:go-ahead", { tier: "deny", status: "retired" });
    __resetBuiltinCacheForTests();
    expect(await call(make(), ASK)).toEqual({});
  });
});

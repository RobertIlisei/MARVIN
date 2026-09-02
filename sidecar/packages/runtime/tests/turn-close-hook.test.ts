import { afterEach, describe, expect, it } from "vitest";

import { decideTurnClose, makeTurnCloseStopHook } from "../src/turn-close-hook";

// The two practice-backtest findings about how a turn ENDS, made mechanical
// through the SDK `Stop` event (2026-09-03).
describe("turn-close decision", () => {
  const facts = { mutations: 0, lastTodos: undefined as unknown, machineTurn: false, alreadyFired: false };
  const todos = [
    { content: "[1] write the migration", status: "completed" },
    { content: "[2] run it on staging", status: "in_progress" },
    { content: "[3] update the runbook", status: "pending" },
  ];

  it("blocks a real-work turn that ends without the handoff", () => {
    const d = decideTurnClose("Done, files updated.", { ...facts, mutations: 3 });
    expect(d?.kind).toBe("scope-met-missing");
    expect(d?.reason).toContain("3 files");
    expect(d?.reason).toContain("marvin:scope-met");
  });

  it("lets a real-work turn end when the handoff is present, a question is asked, or a human is named", () => {
    expect(decideTurnClose("**Scope met:** done.\n<!-- marvin:scope-met -->", { ...facts, mutations: 2 })).toBeNull();
    expect(decideTurnClose("Want me to commit?", { ...facts, mutations: 2 })).toBeNull();
    expect(decideTurnClose("Once that's pushed I'll pick it up.", { ...facts, mutations: 2 })).toBeNull();
    expect(decideTurnClose("Polling the pipeline now.", { ...facts, mutations: 2 })).toBeNull();
  });

  it("blocks a stopped turn with plan steps open, and names them", () => {
    const d = decideTurnClose("Migration written.", { ...facts, lastTodos: todos });
    expect(d?.kind).toBe("plan-steps-open");
    expect(d?.reason).toContain("2 steps");
    expect(d?.reason).toContain("run it on staging");
  });

  it("never fires twice, on a machine turn, on a clean plan, or on an empty message", () => {
    expect(decideTurnClose("Migration written.", { ...facts, lastTodos: todos, alreadyFired: true })).toBeNull();
    expect(decideTurnClose("Migration written.", { ...facts, lastTodos: todos, machineTurn: true })).toBeNull();
    expect(decideTurnClose("All done.", { ...facts, lastTodos: todos.map((t) => ({ ...t, status: "completed" })) })).toBeNull();
    expect(decideTurnClose("", { ...facts, mutations: 0, lastTodos: todos })).toBeNull();
  });

  it("prefers the handoff block over the plan block when both apply", () => {
    expect(decideTurnClose("Edited.", { ...facts, mutations: 1, lastTodos: todos })?.kind).toBe("scope-met-missing");
  });
});

describe("the Stop hook", () => {
  const prev = process.env.MARVIN_DESIGN_HOOKS;
  afterEach(() => {
    if (prev === undefined) delete process.env.MARVIN_DESIGN_HOOKS;
    else process.env.MARVIN_DESIGN_HOOKS = prev;
  });

  const stopInput = (last: string, active = false) =>
    ({ hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: last, session_id: "s", transcript_path: "", cwd: "/" }) as never;

  it("blocks once with the reason, then lets the turn end; respects stop_hook_active", async () => {
    delete process.env.MARVIN_DESIGN_HOOKS;
    const fired: string[] = [];
    const hook = makeTurnCloseStopHook({
      turnId: "t",
      facts: () => ({ mutations: 2, lastTodos: undefined, machineTurn: false }),
      onFired: (d) => fired.push(d.kind),
    });
    const first = (await hook(stopInput("Done."), undefined, { signal: new AbortController().signal })) as { decision?: string; reason?: string };
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("Scope met");
    const second = await hook(stopInput("Done."), undefined, { signal: new AbortController().signal });
    expect(second).toEqual({});
    expect(fired).toEqual(["scope-met-missing"]);
    const guarded = makeTurnCloseStopHook({ turnId: "t2", facts: () => ({ mutations: 2, lastTodos: undefined, machineTurn: false }), onFired: () => {} });
    expect(await guarded(stopInput("Done.", true), undefined, { signal: new AbortController().signal })).toEqual({});
  });

  it("measure mode records but does not block; off mode does nothing", async () => {
    process.env.MARVIN_DESIGN_HOOKS = "measure";
    const fired: string[] = [];
    const hook = makeTurnCloseStopHook({ turnId: "t", facts: () => ({ mutations: 1, lastTodos: undefined, machineTurn: false }), onFired: (d) => fired.push(d.kind) });
    expect(await hook(stopInput("Done."), undefined, { signal: new AbortController().signal })).toEqual({});
    expect(fired).toEqual(["scope-met-missing"]);
    process.env.MARVIN_DESIGN_HOOKS = "off";
    const off = makeTurnCloseStopHook({ turnId: "t", facts: () => ({ mutations: 1, lastTodos: undefined, machineTurn: false }), onFired: (d) => fired.push(d.kind) });
    expect(await off(stopInput("Done."), undefined, { signal: new AbortController().signal })).toEqual({});
    expect(fired).toHaveLength(1);
  });
});

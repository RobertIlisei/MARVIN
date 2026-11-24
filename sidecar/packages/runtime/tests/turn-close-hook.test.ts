import { afterEach, describe, expect, it } from "vitest";

import { backlogCloseCandidates, decideBacklogClose, decideTurnClose, makeTurnCloseStopHook } from "../src/turn-close-hook";

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
    // The hook's own alternative: say what remains instead of claiming it.
    expect(decideTurnClose("**Not scope met — verification is still running.** Two steps remain.", { ...facts, mutations: 2 })).toBeNull();
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

  it("plan-stale: three edits under an open plan with no TodoWrite this turn blocks once; a TodoWrite or a small turn does not", () => {
    const withPlan = { ...facts, mutations: 3, planOpenSteps: ["[2] run it on staging"], todoWrittenThisTurn: false };
    const d = decideTurnClose("**Scope met:** done.\n<!-- marvin:scope-met -->", withPlan);
    expect(d?.kind).toBe("plan-stale");
    expect(d?.reason).toContain("run it on staging");
    expect(decideTurnClose("**Scope met:** done.\n<!-- marvin:scope-met -->", { ...withPlan, todoWrittenThisTurn: true })).toBeNull();
    expect(decideTurnClose("**Scope met:** done.\n<!-- marvin:scope-met -->", { ...withPlan, mutations: 2 })).toBeNull();
    expect(decideTurnClose("**Scope met:** done.\n<!-- marvin:scope-met -->", { ...withPlan, planOpenSteps: [] })).toBeNull();
    // The handoff comes first when both apply.
    expect(decideTurnClose("Edited.", withPlan)?.kind).toBe("scope-met-missing");
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

// ADR-0137: a tab that says "scope met" while it still holds a claimed backlog
// item leaves the item `doing` for ever (a backlog audit found dozens), and
// work that plainly finished an open item nobody claimed never closed it.
describe("backlog at the close", () => {
  const MET = "All done.\n\n**Scope met:** shipped. Anything else, or should I stop?\n<!-- marvin:scope-met -->";
  const item = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, title: id.replace(/-/g, " "), body: "", status: "open", claimedBy: "", ...over }) as never;

  it("blocks a scope-met close that still holds claimed items, and names them", () => {
    const d = decideBacklogClose(MET, { claimed: [{ id: "fix-the-fx-date", title: "Fix the FX date" }], related: [] });
    expect(d?.kind).toBe("backlog-claimed-open");
    expect(d?.reason).toContain("fix-the-fx-date");
    expect(d?.reason).toContain("backlog_resolve");
  });

  it("says nothing when the turn does not claim scope met, or holds nothing and nothing matches", () => {
    expect(decideBacklogClose("Still working; the gate is running.", { claimed: [{ id: "a", title: "A" }], related: [] })).toBeNull();
    expect(decideBacklogClose(MET, { claimed: [], related: [] })).toBeNull();
  });

  it("offers unclaimed look-alikes as suggestions, never as an instruction to close", () => {
    const d = decideBacklogClose(MET, { claimed: [], related: [{ id: "invoice-fx-anchor", title: "Invoice FX anchor" }] });
    expect(d?.kind).toBe("backlog-related");
    expect(d?.reason).toContain("invoice-fx-anchor");
    expect(d?.reason).toMatch(/only if|otherwise leave/i);
  });

  it("candidates: mine are the doing items this session claimed; related are open, unclaimed, and name a file this turn edited", () => {
    const items = [
      item("mine", { status: "doing", claimedBy: "sess-1" }),
      item("someone-elses", { status: "doing", claimedBy: "sess-2", body: "see apps/api/src/InvoiceService.java" }),
      item("names-my-file", { body: "the rate is read in apps/api/src/InvoiceService.java:120" }),
      item("names-another-file", { body: "see apps/web/src/Other.tsx" }),
      item("done-already", { status: "done", body: "apps/api/src/InvoiceService.java" }),
    ];
    const c = backlogCloseCandidates(items, "sess-1", ["/proj/wt/apps/api/src/InvoiceService.java"]);
    expect(c.claimed.map((i) => i.id)).toEqual(["mine"]);
    expect(c.related.map((i) => i.id)).toEqual(["names-my-file"]);
  });

  it("the Stop hook blocks twice on claimed items, then lets the close through", async () => {
    delete process.env.MARVIN_DESIGN_HOOKS;
    const stop = { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: MET, session_id: "s", transcript_path: "", cwd: "/" } as never;
    const fired: string[] = [];
    const hook = makeTurnCloseStopHook({
      turnId: "t-bk",
      facts: () => ({ mutations: 1, lastTodos: undefined, machineTurn: true }),
      backlog: async () => ({ claimed: [{ id: "mine", title: "Mine" }], related: [] }),
      onFired: (d) => fired.push(d.kind),
    });
    const sig = { signal: new AbortController().signal };
    expect(((await hook(stop, undefined, sig)) as { decision?: string }).decision).toBe("block");
    expect(((await hook(stop, undefined, sig)) as { decision?: string }).decision).toBe("block");
    expect(await hook(stop, undefined, sig)).toEqual({});
    expect(fired).toEqual(["backlog-claimed-open", "backlog-claimed-open"]);
  });
});

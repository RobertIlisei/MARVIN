import { describe, expect, it } from "vitest";

import {
  buildReconcilePrompt,
  hasScopeMet,
  hasWorkflowGap,
  openPlanSteps,
  openTodos,
  SCOPE_MET_SENTINEL,
  scopeOfDoneEntirelyUnticked,
} from "../src/workflow-guard";

// ADR-0057 — mechanical backstop: a scope-met close with an unreconciled plan
// or ADR fires a corrective turn.

describe("hasScopeMet", () => {
  it("detects the sentinel; ignores ordinary prose", () => {
    expect(hasScopeMet(`**Scope met:** did the thing.\n${SCOPE_MET_SENTINEL}`)).toBe(true);
    expect(hasScopeMet("I think we're basically done here.")).toBe(false);
  });
});

describe("openTodos", () => {
  it("returns non-completed item labels", () => {
    const todos = [
      { content: "Write the loader", status: "completed" },
      { content: "Wire the API", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ];
    expect(openTodos(todos)).toEqual(["Wire the API", "Add tests"]);
  });

  it("is empty when all completed / payload malformed", () => {
    expect(openTodos([{ content: "x", status: "completed" }])).toEqual([]);
    expect(openTodos(undefined)).toEqual([]);
    expect(openTodos("not an array")).toEqual([]);
  });

  it("falls back to activeForm when content is missing", () => {
    expect(openTodos([{ activeForm: "Wiring the API", status: "in_progress" }])).toEqual([
      "Wiring the API",
    ]);
  });
});

describe("openPlanSteps (persisted plan-state fallback)", () => {
  const state = (activePlanId: string | null, plans: unknown[]) => ({
    ...(activePlanId ? { activePlanId } : {}),
    plans,
  });

  it("returns non-completed steps of the ACTIVE plan only", () => {
    const s = state("plan-b", [
      { id: "plan-a", steps: [{ content: "old step", status: "pending" }] },
      {
        id: "plan-b",
        steps: [
          { content: "Build loader", status: "completed" },
          { content: "Wire API", status: "in_progress" },
          { content: "Write tests", status: "pending" },
        ],
      },
    ]);
    expect(openPlanSteps(s)).toEqual(["Wire API", "Write tests"]);
  });

  it("returns [] when the active plan is fully complete", () => {
    const s = state("p", [{ id: "p", steps: [{ content: "x", status: "completed" }] }]);
    expect(openPlanSteps(s)).toEqual([]);
  });

  it("checks all plans when activePlanId names none", () => {
    const s = state(null, [{ id: "p", steps: [{ content: "lonely", status: "pending" }] }]);
    expect(openPlanSteps(s)).toEqual(["lonely"]);
  });

  it("is fully defensive — [] on any shape deviation, never throws", () => {
    expect(openPlanSteps(null)).toEqual([]);
    expect(openPlanSteps({})).toEqual([]);
    expect(openPlanSteps({ plans: "nope" })).toEqual([]);
    expect(openPlanSteps({ plans: [{ steps: "nope" }] })).toEqual([]);
    expect(openPlanSteps("garbage")).toEqual([]);
  });
});

describe("scopeOfDoneEntirelyUnticked", () => {
  const withSection = (bullets: string) =>
    `# ADR-0099 — Something\n\n## Context\nblah\n\n## Scope of Done\n${bullets}\n`;

  it("flags a section that is entirely unticked", () => {
    expect(
      scopeOfDoneEntirelyUnticked(withSection("- [ ] wire it\n- [ ] test it\n- [ ] doc it")),
    ).toBe(true);
  });

  it("does NOT flag a MIX (partial ticks are legitimate — deferred bullets)", () => {
    expect(
      scopeOfDoneEntirelyUnticked(withSection("- [x] wire it\n- [x] test it\n- [ ] migrate later")),
    ).toBe(false);
  });

  it("does NOT flag a fully-ticked section, or a doc with no such section", () => {
    expect(scopeOfDoneEntirelyUnticked(withSection("- [x] wire it\n- [x] test it"))).toBe(false);
    expect(scopeOfDoneEntirelyUnticked("# ADR\n## Decision\ndid stuff")).toBe(false);
  });

  it("stops at the next heading (doesn't bleed into later sections)", () => {
    const md =
      "## Scope of Done\n- [x] done it\n\n## Consequences\n- [ ] this is prose, not a DoD box";
    expect(scopeOfDoneEntirelyUnticked(md)).toBe(false);
  });
});

describe("hasWorkflowGap + buildReconcilePrompt", () => {
  it("no gap when nothing open", () => {
    expect(hasWorkflowGap({ openTodos: [], untickedAdrs: [] })).toBe(false);
  });

  it("builds a prompt that forbids ticking-to-satisfy", () => {
    const { reason, prompt } = buildReconcilePrompt({
      openTodos: ["Add tests"],
      untickedAdrs: ["0099-something.md"],
    });
    expect(reason).toMatch(/ADR-0057/);
    expect(prompt).toContain("Add tests");
    expect(prompt).toContain("0099-something.md");
    expect(prompt).toMatch(/do not mark or tick anything merely to clear/i);
    expect(prompt).toMatch(/retract|do not claim scope met|leave it open/i);
  });
});

describe("advisor conditions at the close (ADR-0100)", () => {
  it("an unanswered condition IS a workflow gap", () => {
    // The whole point of moving caveats off the backlog: they must be
    // answered before the scope they were attached to closes.
    expect(
      hasWorkflowGap({ openTodos: [], untickedAdrs: [], openConditions: ["Add a rollback"] }),
    ).toBe(true);
  });

  it("no conditions is not a gap, and the field is optional", () => {
    expect(hasWorkflowGap({ openTodos: [], untickedAdrs: [], openConditions: [] })).toBe(false);
    // Callers written before ADR-0100 omit the field entirely; that must not
    // read as a gap and fire a corrective turn on every clean close.
    expect(hasWorkflowGap({ openTodos: [], untickedAdrs: [] })).toBe(false);
  });

  it("asks for an outcome per condition and parks only the unmet ones", () => {
    const { reason, prompt } = buildReconcilePrompt({
      openTodos: [],
      untickedAdrs: [],
      openConditions: ["Add a rollback path", "Confirm the index exists"],
    });
    expect(reason).toContain("ADR-0100");
    expect(prompt).toContain("Add a rollback path");
    expect(prompt).toContain("Confirm the index exists");
    // The three legal answers, and the instruction that met ones are NOT parked
    // — parking the satisfied ones is what buried the real items before.
    expect(prompt).toMatch(/`met`/);
    expect(prompt).toMatch(/`not met`/);
    expect(prompt).toMatch(/waived/);
    expect(prompt).toContain("backlog_add");
    expect(prompt).toContain("needs no backlog item");
  });

  it("keeps the plan/ADR reconcile intact alongside conditions", () => {
    // A close can be short on all three at once; none may mask the others.
    const { prompt } = buildReconcilePrompt({
      openTodos: ["Step 3"],
      untickedAdrs: ["0100-x.md"],
      openConditions: ["Add a rollback path"],
    });
    expect(prompt).toContain("Step 3");
    expect(prompt).toContain("0100-x.md");
    expect(prompt).toContain("Add a rollback path");
  });

  it("does not mention conditions when there are none", () => {
    const { reason, prompt } = buildReconcilePrompt({
      openTodos: ["Step 3"],
      untickedAdrs: [],
    });
    expect(reason).not.toContain("ADR-0100");
    expect(prompt).not.toContain("backlog_add");
  });
});

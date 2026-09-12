// ADR-0116 — the server's half of the plan spine. Pins the deterministic
// `[N]` tag join, the conservative re-base refusal, and the shapes it must
// survive without throwing (the spine is the client's model, written by the
// client, and a projection failure must never break hydration).

import { describe, expect, it } from "vitest";

import {
  applyTodosToSpine,
  looksRebased,
  parsePlanTag,
  stepsClosedByBatch,
} from "../src/plan-spine";

const spine = (statuses: string[], activePlanId: string | null = "p") => ({
  activePlanId,
  plans: [
    {
      id: "p",
      title: "A plan",
      text: "# Plan",
      steps: statuses.map((status, i) => ({
        id: `step ${i + 1}`,
        content: `Step ${i + 1}`,
        status,
        subtasks: [],
      })),
    },
  ],
});

const todo = (content: string, status: string) => ({ content, status, activeForm: content });

const AT = "2026-09-11T17:46:42.540Z";

/** The turn-end stamp is the caller's; every case here uses the same one. */
const apply = (state: unknown, todos: unknown) => applyTodosToSpine(state, todos, AT);

const statusesOf = (state: unknown) =>
  ((state as { plans: { steps: { status: string }[] }[] }).plans[0]?.steps ?? []).map(
    (s) => s.status,
  );

const firstStep = (state: unknown) =>
  (state as { plans: { steps: Record<string, unknown>[] }[] }).plans[0]?.steps[0] ?? {};

describe("parsePlanTag", () => {
  it("reads the grammar PlanTag.parseFull accepts", () => {
    expect(parsePlanTag("[3] Do the thing")).toMatchObject({ lo: 3, hi: 3, sub: null });
    expect(parsePlanTag("[3-8] Close several")).toMatchObject({ lo: 3, hi: 8, sub: null });
    expect(parsePlanTag("[8.1] A sub-task")).toMatchObject({ lo: 8, hi: 8, sub: "1" });
    expect(parsePlanTag("[8.1a] A third level")).toMatchObject({ sub: "1a" });
    expect(parsePlanTag("[3] Do the thing")?.text).toBe("Do the thing");
  });

  it("rejects a descending range and a range carrying a sub-key", () => {
    expect(parsePlanTag("[8-3] backwards")).toBeNull();
    expect(parsePlanTag("[3-8.1] nonsense")).toBeNull();
  });

  it("returns null for untagged prose", () => {
    expect(parsePlanTag("Write ADR-0384")).toBeNull();
    expect(parsePlanTag("")).toBeNull();
  });
});

describe("stepsClosedByBatch", () => {
  it("expands ranges and counts only completed rows", () => {
    expect(
      stepsClosedByBatch([
        todo("[1] one", "completed"),
        todo("[2-4] two through four", "completed"),
        todo("[5] five", "in_progress"),
        todo("[6.1] a sub-task", "completed"),
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("is empty for a malformed or untagged batch", () => {
    expect(stepsClosedByBatch(null)).toEqual([]);
    expect(stepsClosedByBatch([todo("Write ADR-0384", "completed")])).toEqual([]);
  });
});

describe("looksRebased", () => {
  it("fires on a self-contained 1..K list whose size disagrees with the plan", () => {
    expect(looksRebased([1, 2, 3, 4], 9)).toBe(true);
  });

  it("does not fire when K matches the step count — that is a full-plan update", () => {
    expect(looksRebased([1, 2, 3, 4], 4)).toBe(false);
  });

  it("does not fire on a partial batch or one below the minimum size", () => {
    expect(looksRebased([3, 4, 5], 9)).toBe(false);
    expect(looksRebased([1, 2], 9)).toBe(false);
  });
});

describe("applyTodosToSpine", () => {
  it("moves the tagged steps of the ACTIVE plan and leaves the rest alone", () => {
    const before = spine(["completed", "in_progress", "pending", "pending"]);
    const out = apply(before, [
      todo("[1] one", "completed"),
      todo("[2] two", "completed"),
      todo("[3] three", "in_progress"),
      todo("[4] four", "pending"),
    ]);
    expect(out.changed).toBe(true);
    expect(statusesOf(out.state)).toEqual(["completed", "completed", "in_progress", "pending"]);
  });

  it("expands a range tag across every step it names", () => {
    const out = apply(spine(["pending", "pending", "pending"]), [
      todo("[1-3] all of it", "completed"),
    ]);
    expect(statusesOf(out.state)).toEqual(["completed", "completed", "completed"]);
  });

  it("carries every other field through untouched — structure stays the client's", () => {
    const before = spine(["pending"]);
    (before.plans[0]?.steps[0] as { subtasks: unknown[] }).subtasks = [
      { content: "a sub-task", status: "pending" },
    ];
    const out = apply(before, [todo("[1] one", "completed")]);
    const step = firstStep(out.state);
    expect(step.status).toBe("completed");
    expect(step.subtasks).toEqual([{ content: "a sub-task", status: "pending" }]);
    expect(step.content).toBe("Step 1");
    expect(statusesOf(before)).toEqual(["pending"]); // input not mutated
  });

  it("refuses a re-based batch rather than overwriting unrelated steps", () => {
    const before = spine(["completed", "in_progress", "pending", "pending", "pending"]);
    const out = apply(before, [
      todo("[1] unrelated work", "completed"),
      todo("[2] unrelated work", "completed"),
      todo("[3] unrelated work", "completed"),
    ]);
    expect(out.distrusted).toBe(true);
    expect(out.changed).toBe(false);
    expect(statusesOf(out.state)).toEqual([
      "completed",
      "in_progress",
      "pending",
      "pending",
      "pending",
    ]);
  });

  // The 2026-09-11 failure, reproduced. After an auto-compaction the model
  // re-emitted all fourteen rows completed, untagged and reworded from the
  // summary. Nothing joins, so nothing closes — and the guard says why.
  it("applies NOTHING from an untagged batch, however confident it is", () => {
    const before = spine([
      "completed",
      "completed",
      "in_progress",
      "pending",
      "pending",
      "pending",
    ]);
    const out = apply(before, [
      todo("Confirm baseUrl display-only fix", "completed"),
      todo("Write ADR-0384", "completed"),
      todo("Operator PATCH/DELETE endpoints + audit", "completed"),
      todo("Test-connection endpoint on both planes", "completed"),
      todo("Operator SPA modals + regenerate types", "completed"),
      todo("Verify M2, security-audit, pr-review, commit", "completed"),
    ]);
    expect(out.taggedRows).toBe(0);
    expect(out.totalRows).toBe(6);
    expect(out.changed).toBe(false);
    expect(statusesOf(out.state)).toEqual([
      "completed",
      "completed",
      "in_progress",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("does nothing without a named active plan — ordinals have no frame", () => {
    const out = apply(spine(["pending"], null), [todo("[1] one", "completed")]);
    expect(out.changed).toBe(false);
  });

  it("ignores out-of-range ordinals instead of growing the plan", () => {
    const out = apply(spine(["pending"]), [
      todo("[1] one", "completed"),
      todo("[9] nine", "completed"),
    ]);
    expect(statusesOf(out.state)).toEqual(["completed"]);
  });

  it("stamps the watermark whenever the batch was joinable, change or not", () => {
    const settled = spine(["completed", "completed"]);
    const out = apply(settled, [todo("[1] one", "completed"), todo("[2] two", "completed")]);
    expect(out.joined).toBe(true);
    expect(out.changed).toBe(false);
    expect((out.state as { lastTodoAt?: string }).lastTodoAt).toBe(AT);
  });

  it("leaves no watermark when nothing could be joined", () => {
    const out = apply(spine(["pending"]), [todo("Untagged and confident", "completed")]);
    expect(out.joined).toBe(false);
    expect((out.state as { lastTodoAt?: string }).lastTodoAt).toBeUndefined();
  });

  it("survives every malformed shape without throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { plans: "no" }, { plans: [] }]) {
      expect(() => apply(bad, [todo("[1] one", "completed")])).not.toThrow();
      expect(apply(bad, [todo("[1] one", "completed")]).changed).toBe(false);
    }
    expect(apply(spine(["pending"]), null).changed).toBe(false);
    expect(apply(spine(["pending"]), [null, 7, {}]).changed).toBe(false);
  });
});

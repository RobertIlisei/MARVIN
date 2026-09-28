import { describe, expect, it } from "vitest";

import {
  buildReconcilePrompt,
  hasScopeMet,
  hasWorkflowGap,
  mergeOpenItems,
  openPlanSteps,
  openTodos,
  SCOPE_MET_SENTINEL,
  scopeOfDoneEntirelyUnticked,
  ownChangeConsequences,
  ownChangeTokens,
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

// ADR-0116 — the claim no longer checks itself. The spine and the batch are
// read together, and the corrective prompt names an untagged close for what
// it is: a join failure, not a disagreement about the work.

describe("mergeOpenItems (ADR-0116)", () => {
  it("unions both statements, spine first, de-duplicated case-insensitively", () => {
    expect(
      mergeOpenItems(["Operator endpoints", "Verify M2"], ["verify m2", "Park the backlog items"]),
    ).toEqual(["Operator endpoints", "Verify M2", "Park the backlog items"]);
  });

  it("keeps the spine's open steps when the batch claims everything done", () => {
    expect(mergeOpenItems(["Test-connection endpoint"], [])).toEqual(["Test-connection endpoint"]);
  });

  it("keeps the batch's open items when the spine is clear", () => {
    expect(mergeOpenItems([], ["A tier-1 item that was never a plan step"])).toEqual([
      "A tier-1 item that was never a plan step",
    ]);
  });

  it("drops blanks and caps the list", () => {
    expect(mergeOpenItems(["", "   "], [])).toEqual([]);
    expect(mergeOpenItems(Array.from({ length: 30 }, (_, i) => `s${i}`), []).length).toBe(20);
  });
});

describe("untagged close (ADR-0116)", () => {
  it("tells the executor the ordinal is the join key and how to recover", () => {
    const { prompt } = buildReconcilePrompt({
      openTodos: ["Test-connection endpoint on both planes"],
      untickedAdrs: [],
      untaggedClose: true,
    });
    expect(prompt).toContain("no `[N]` step tags");
    expect(prompt).toContain(".marvin/plans/");
  });

  it("says nothing about tags when the batch was tagged", () => {
    const { prompt } = buildReconcilePrompt({
      openTodos: ["Still open"],
      untickedAdrs: [],
    });
    expect(prompt).not.toContain("no `[N]` step tags");
  });
});

// ADR-0121 — the three items agri-saas tabs parked on 2026-09-28 about breaks
// their own commits caused, and the one that was genuinely pre-existing.
describe("own-change consequences at scope-met", () => {
  const docsTab = {
    files: [
      "apps/api/src/main/java/ro/agricore/platform/document/DocumentType.java",
      "apps/api/src/main/java/ro/agricore/platform/document/DocumentService.java",
      "docs/adr/0427-document-access-and-retention.md",
    ],
  };
  const openapiItem = {
    id: "teach-the-document-openapi-enum-spa-labels-dovada-depunere-a",
    title: "Teach the document OpenAPI enum + SPA labels DOVADA_DEPUNERE_AUTORITATE",
    body: "ADR-0427 D3/D4 added DocumentType DOVADA_DEPUNERE_AUTORITATE. Outside that tab's write set: add it to document.openapi.yaml…",
  };
  const unrelated = {
    id: "upgrade-maplibre-gl-from-4-7-1-to-5-x",
    title: "Upgrade maplibre-gl from 4.7.1 to 5.x",
    body: "Plain dependency upgrade; the jsdom isolation test found 5.24 clean.",
  };

  it("flags an item that names an ADR or a class the session changed, and not an unrelated one", () => {
    const hits = ownChangeConsequences([openapiItem, unrelated], docsTab.files);
    expect(hits.map((h) => h.id)).toEqual([openapiItem.id]);
    expect(["ADR-0427", "DocumentType"]).toContain(hits[0]?.because);
    // The ADR alone is enough to tie it to the session.
    expect(ownChangeConsequences([openapiItem], ["docs/adr/0427-document-access-and-retention.md"])[0]?.because).toBe("ADR-0427");
  });

  it("flags the restore-script item by its branch and by the changed config file", () => {
    const item = {
      id: "dr-restore-test-pass-garage-rpc-secret-to-the-scratch-garage",
      title: "DR restore test: pass the Garage RPC secret to the scratch Garage",
      body: "Since 2026-09-28 (branch marvin/tab/docs-and-infrastructure-one-tab-1-from-e) garage.toml reads rpc_secret_file…",
    };
    expect(ownChangeConsequences([item], ["infrastructure/garage/garage.toml"])[0]?.because).toBe("garage.toml");
    expect(ownChangeConsequences([item], ["docs/runbooks/x.md"], "marvin/tab/docs-and-infrastructure-one-tab-1-from-e")[0]?.because).toBe(
      "marvin/tab/docs-and-infrastructure-one-tab-1-from-e",
    );
  });

  it("does not match a class name inside a longer identifier, nor generic basenames", () => {
    const item = { id: "x", title: "x", body: "DocumentServiceFactory and index.ts are unrelated." };
    expect(ownChangeConsequences([item], ["src/DocumentService.java", "web/index.ts"])).toEqual([]);
    expect(ownChangeTokens(["web/index.ts"])).toEqual(["web/index.ts"]);
    expect(ownChangeTokens([".marvin/backlog/a.md"])).toEqual([]);
  });

  it("makes the close a gap and tells the executor to fix, keep with a reason, or not claim scope met", () => {
    const gap = { openTodos: [], untickedAdrs: [], ownConsequences: ownChangeConsequences([openapiItem], docsTab.files) };
    expect(hasWorkflowGap(gap)).toBe(true);
    const { reason, prompt } = buildReconcilePrompt(gap);
    expect(reason).toContain("ADR-0121");
    expect(prompt).toContain(openapiItem.id);
    expect(prompt).toContain("fix it now");
    expect(prompt).toContain("backlog_resolve … keep");
    expect(prompt).toContain("do NOT claim scope met");
  });
});

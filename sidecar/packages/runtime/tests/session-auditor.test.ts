import { describe, expect, it } from "vitest";

import {
  AUDIT_CAPS,
  AUDITOR_DISALLOWED_TOOLS,
  AUDITOR_SYSTEM_PROMPT,
  type AuditPacket,
  computeGraphFreshness,
  countFindings,
  extractMessages,
  findingToBacklogSeverity,
  parseFindings,
  extractPlanSteps,
  readAuditReport,
  renderAuditPrompt,
} from "../src/session-auditor";
import type { ChangedFile } from "../src/change-checkpoints";
import type { SessionTurn } from "../src/session";

// ADR-0059 — the auditor's pure core: packet assembly + prompt rendering.
// The SDK dispatch itself is network-bound and covered manually.

const assistantTurn = (text: string, at = "2026-07-24T10:00:00Z"): SessionTurn =>
  ({
    type: "cli.event",
    at,
    event: { type: "assistant", message: { content: [{ type: "text", text }] } },
  }) as SessionTurn;

describe("extractMessages", () => {
  it("pulls user messages and assistant text, tagging turnId from turn.started", () => {
    const turns: SessionTurn[] = [
      { type: "turn.user", at: "t0", message: "fix the bug" } as SessionTurn,
      { type: "turn.started", at: "t1", turnId: "turn-7" } as unknown as SessionTurn,
      assistantTurn("Fixed it and verified end-to-end."),
    ];
    const out = extractMessages(turns);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "user", text: "fix the bug" });
    expect(out[1]).toMatchObject({ role: "marvin", turnId: "turn-7" });
    expect(out[1]!.text).toContain("verified end-to-end");
  });

  it("drops tool noise, confirms, and empty assistant envelopes", () => {
    const turns: SessionTurn[] = [
      {
        type: "cli.event",
        at: "t",
        event: {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
        },
      } as SessionTurn,
      { type: "confirm.request", at: "t", payload: {} } as unknown as SessionTurn,
      { type: "turn.completed", at: "t" } as unknown as SessionTurn,
    ];
    expect(extractMessages(turns)).toEqual([]);
  });

  it("clips long messages and keeps only the tail", () => {
    const long = "x".repeat(5_000);
    const turns = Array.from({ length: 80 }, (_, i) => assistantTurn(`${i}:${long}`));
    const out = extractMessages(turns);
    expect(out).toHaveLength(AUDIT_CAPS.messages);
    expect(out[0]!.text.length).toBeLessThan(AUDIT_CAPS.messageChars + 40);
    // Tail, not head — the newest message survives.
    expect(out.at(-1)!.text.startsWith("79:")).toBe(true);
  });

  it("never throws on malformed turns", () => {
    const turns = [null, "nope", { type: "cli.event", at: "t" }] as unknown as SessionTurn[];
    expect(() => extractMessages(turns)).not.toThrow();
    expect(extractMessages(turns)).toEqual([]);
  });
});

describe("extractPlanSteps", () => {
  it("returns the active plan's steps with statuses", () => {
    const state = {
      activePlanId: "p2",
      plans: [
        { id: "p1", steps: [{ content: "old", status: "completed" }] },
        {
          id: "p2",
          steps: [
            { content: "build it", status: "completed" },
            { content: "test it", status: "pending" },
          ],
        },
      ],
    };
    expect(extractPlanSteps(state)).toEqual([
      { content: "build it", status: "completed" },
      { content: "test it", status: "pending" },
    ]);
  });

  it("is defensive against any shape deviation", () => {
    expect(extractPlanSteps(null)).toEqual([]);
    expect(extractPlanSteps({ plans: "nope" })).toEqual([]);
    expect(extractPlanSteps({ plans: [{ steps: 5 }] })).toEqual([]);
    expect(extractPlanSteps("garbage")).toEqual([]);
  });
});

describe("computeGraphFreshness (the phantom-finding guard)", () => {
  const change = (lastTouchedAt: string): ChangedFile => ({
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    firstTurnId: "t",
    lastTouchedAt,
  });

  it("is missing when there is no graph on disk", () => {
    expect(computeGraphFreshness(null, [change("2026-07-24T10:00:00Z")])).toEqual({
      state: "missing",
    });
  });

  it("is fresh when the graph is newer than the newest change", () => {
    const graph = Date.parse("2026-07-24T12:00:00Z");
    const r = computeGraphFreshness(graph, [change("2026-07-24T10:00:00Z")]);
    expect(r.state).toBe("fresh");
  });

  it("is STALE when the graph predates a change — the phantom-finding case", () => {
    const graph = Date.parse("2026-07-24T09:00:00Z");
    const r = computeGraphFreshness(graph, [change("2026-07-24T10:00:00Z")]);
    expect(r.state).toBe("stale");
    if (r.state === "stale") {
      expect(r.newestChangeAt).toBe("2026-07-24T10:00:00.000Z");
    }
  });

  it("uses the NEWEST change, not the first", () => {
    const graph = Date.parse("2026-07-24T11:00:00Z");
    // Older change is covered, newer one is not → stale.
    const r = computeGraphFreshness(graph, [
      change("2026-07-24T08:00:00Z"),
      change("2026-07-24T14:00:00Z"),
    ]);
    expect(r.state).toBe("stale");
  });

  it("treats a graph with no dated changes as fresh (nothing to be stale against)", () => {
    expect(computeGraphFreshness(Date.parse("2026-07-24T09:00:00Z"), []).state).toBe("fresh");
    expect(
      computeGraphFreshness(Date.parse("2026-07-24T09:00:00Z"), [change("not-a-date")]).state,
    ).toBe("fresh");
  });
});

describe("renderAuditPrompt", () => {
  const packet: AuditPacket = {
    sessionId: "s1",
    projectId: "p1",
    cwd: "/proj",
    ci: { state: "unknown", reason: "test fixture" },
    messages: [
      { role: "user", at: "t0", text: "ship it" },
      { role: "marvin", at: "t1", turnId: "turn-1", text: "Verified end-to-end and shipped." },
    ],
    planSteps: [{ content: "write tests", status: "pending" }],
    auditLog: [
      {
        at: "t1",
        tool: "Bash",
        reason: "auto",
        descriptor: "npx tsc --noEmit",
        turnId: "turn-1",
        toolUseId: "tu1",
      },
    ],
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        firstTurnId: "turn-1",
        lastTouchedAt: "t1",
      },
    ],
    touchedDocs: ["docs/decisions/0059-x.md"],
    claimedScopeMet: true,
    graph: { state: "fresh", builtAt: "2026-07-24T12:00:00Z" },
  };

  it("puts claims and evidence in the same prompt so the gap is visible", () => {
    const p = renderAuditPrompt(packet);
    // Claim side.
    expect(p).toContain("Verified end-to-end and shipped.");
    // Evidence side — the tool that actually ran contradicts "end-to-end".
    expect(p).toContain("npx tsc --noEmit");
    expect(p).toContain("modified src/a.ts");
    expect(p).toContain("[pending] write tests");
    expect(p).toContain("docs/decisions/0059-x.md");
    expect(p).toMatch(/scope-met .*marker this session: YES/);
    // Section ordering: claims before evidence.
    expect(p.indexOf("## A. CLAIMS")).toBeLessThan(p.indexOf("## C. EVIDENCE"));
  });

  it("renders an empty packet without throwing", () => {
    const empty: AuditPacket = {
      ...packet,
      messages: [],
      planSteps: [],
      auditLog: [],
      changedFiles: [],
      touchedDocs: [],
      claimedScopeMet: false,
      graph: { state: "missing" },
    };
    const p = renderAuditPrompt(empty);
    expect(p).toContain("_(no messages)_");
    expect(p).toContain("_(no persisted plan)_");
  });

  it("licenses structural findings when the graph is FRESH", () => {
    const p = renderAuditPrompt(packet);
    expect(p).toMatch(/Structural findings ARE in scope/);
    expect(p).toContain("mcp__marvin-graph__");
  });

  it("FORBIDS structural findings when the graph is STALE (phantom-finding guard)", () => {
    const p = renderAuditPrompt({
      ...packet,
      graph: {
        state: "stale",
        builtAt: "2026-07-24T09:00:00Z",
        newestChangeAt: "2026-07-24T11:00:00Z",
      },
    });
    expect(p).toMatch(/STALE/);
    expect(p).toMatch(/MUST NOT raise a structural finding/);
    expect(p).toMatch(/recommend a graph refresh/i);
  });

  it("forbids graph use entirely when the graph is MISSING", () => {
    const p = renderAuditPrompt({ ...packet, graph: { state: "missing" } });
    expect(p).toMatch(/Unavailable/);
    expect(p).toMatch(/do NOT\s+attempt graph queries/i);
  });

  it("caps the total prompt size", () => {
    const huge: AuditPacket = {
      ...packet,
      messages: Array.from({ length: 60 }, (_, i) => ({
        role: "marvin" as const,
        at: "t",
        text: `${i} ` + "y".repeat(AUDIT_CAPS.messageChars),
      })),
    };
    expect(renderAuditPrompt(huge).length).toBeLessThanOrEqual(AUDIT_CAPS.promptChars + 40);
  });
});

describe("AUDITOR_SYSTEM_PROMPT — graph guidance", () => {
  it("defines blast-radius and gates it on freshness + coverage caveats", () => {
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/blast-radius/);
    // Freshness gate.
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/STALE or MISSING you\s+MUST NOT/);
    // Asymmetric evidence strength: missing callers strong, no-callers weak.
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/WEAK evidence for dead code/);
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/STRONG evidence/);
  });
});

describe("countFindings", () => {
  it("counts ### headers inside the Findings section only", () => {
    const report = [
      "## Verdict",
      "### not a finding (verdict prose)",
      "## Findings",
      "### claim-gap in the CI claim",
      "- class: claim-gap",
      "### drift from the plan",
      "- class: drift",
      "## Notes",
      "### also not a finding",
    ].join("\n");
    expect(countFindings(report)).toBe(2);
  });

  it("returns 0 for a clean report with no Findings section", () => {
    expect(countFindings("## Verdict\nClaims match the evidence.")).toBe(0);
    expect(countFindings("")).toBe(0);
  });
});

describe("parseFindings (structured view for the interactive panel)", () => {
  // Shape taken from a REAL 2026-07-24 audit of the agri-saas session, so the
  // parser is pinned against output the model actually produced (multi-line
  // fields with backticks, colons, and wrapped text).
  const realReport = `# Session audit — abc

## Verdict
The core engineering claims check out, but two things were never surfaced.

## Findings

### Commit landed on an unrelated feature branch
- class: unreconciled
- severity: warn
- claim: Plan step 8 specifies "commit on feat/… branch per convention"; MARVIN
  then reported "Commit \`36a542a8\` landed clean" with no caveat.
- evidence: \`.git/HEAD\` shows the checked-out branch is
  \`feat/landing-analytics-adr-0269\`, unrelated to billing work.
- suggest: Cherry-pick the commit onto a dedicated branch before pushing.

### Session ends on an unanswered reconciliation nudge
- class: unreconciled
- severity: high
- claim: MARVIN emitted scope-met claiming full completion.
- evidence: A second reconciliation check fired one minute later reporting the
  same plan step still open; the transcript ends with no reply.
- suggest: Re-run the reconciliation pass against the durable plan record.
`;

  it("parses each finding with all five fields, joining wrapped lines", () => {
    const f = parseFindings(realReport);
    expect(f).toHaveLength(2);
    expect(f[0]!.title).toBe("Commit landed on an unrelated feature branch");
    expect(f[0]!.class).toBe("unreconciled");
    expect(f[0]!.severity).toBe("warn");
    // Wrapped continuation lines are joined, and inline backticks/colons survive.
    expect(f[0]!.claim).toContain("commit on feat/… branch per convention");
    expect(f[0]!.claim).toContain("`36a542a8` landed clean");
    expect(f[0]!.evidence).toContain("feat/landing-analytics-adr-0269");
    expect(f[0]!.suggest).toMatch(/^Cherry-pick/);
    expect(f[1]!.severity).toBe("high");
  });

  it("does not swallow the Verdict or trailing sections", () => {
    const f = parseFindings(realReport);
    expect(f.every((x) => !x.title.startsWith("Verdict"))).toBe(true);
    expect(parseFindings(realReport + "\n## Notes\n### not a finding\n")).toHaveLength(2);
  });

  it("returns [] for a clean report (no Findings section)", () => {
    expect(parseFindings("## Verdict\nClaims match the evidence.")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("tolerates a finding with missing fields", () => {
    const f = parseFindings("## Findings\n\n### bare title\n- class: drift\n");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ title: "bare title", class: "drift", severity: "", claim: "" });
  });

  it("agrees with countFindings", () => {
    expect(parseFindings(realReport)).toHaveLength(countFindings(realReport));
  });
});

describe("findingToBacklogSeverity", () => {
  it("maps the auditor scale onto the backlog scale", () => {
    expect(findingToBacklogSeverity("high")).toBe("high");
    expect(findingToBacklogSeverity("warn")).toBe("med");
    expect(findingToBacklogSeverity("info")).toBe("low");
    expect(findingToBacklogSeverity("  HIGH ")).toBe("high");
    expect(findingToBacklogSeverity("nonsense")).toBe("low");
  });
});

describe("readAuditReport (path containment)", () => {
  it("refuses a path outside the project's .marvin/audits/", () => {
    expect(readAuditReport("/proj", "/etc/passwd")).toBeNull();
    expect(readAuditReport("/proj", "/proj/.marvin/memory.md")).toBeNull();
  });
});

describe("AUDITOR_DISALLOWED_TOOLS (read-only contract, ADR-0059 §2)", () => {
  it("refuses every mutator, the web, and agent spawning", () => {
    // "Agent" is the post-v2.1.63 name for "Task"; disallowedTools matches on
    // the literal name the model emits, so both must be listed.
    for (const t of [
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
    ]) {
      expect(AUDITOR_DISALLOWED_TOOLS, t).toContain(t);
    }
  });

  it("keeps the read tools it needs to verify claims against the workspace", () => {
    for (const t of ["Read", "Grep", "Glob"]) {
      expect(AUDITOR_DISALLOWED_TOOLS, t).not.toContain(t);
    }
  });
});

describe("AUDITOR_SYSTEM_PROMPT", () => {
  it("states the three load-bearing invariants (not MARVIN, read-only, no authority)", () => {
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/not marvin/i);
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/read-only/i);
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/no authority to block|report to the USER/i);
    // Must tell the auditor that a clean verdict is acceptable — otherwise it
    // manufactures findings to look useful.
    expect(AUDITOR_SYSTEM_PROMPT).toMatch(/clean is a valid verdict/i);
  });
});

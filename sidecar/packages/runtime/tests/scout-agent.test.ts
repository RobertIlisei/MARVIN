import { describe, expect, it } from "vitest";

import { SCOUT_AGENT } from "../src/sdk-runner";

// ADR-0014: the scout is the sanctioned read-only research subagent.
// These tests pin the guarantees the ADR makes so that a future edit
// to sdk-runner.ts can't silently relax them without a visible
// test failure. The ADR's "Verification" section cites these checks.

describe("SCOUT_AGENT (ADR-0014)", () => {
  it("denies every write-capable tool at the SDK layer", () => {
    // The ADR's promise is that even a misrouted scout can't write.
    // disallowedTools is the structural backstop — tightening it is a
    // deliberate act, loosening it must break a test.
    expect(SCOUT_AGENT.disallowedTools).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash", "NotebookEdit"]),
    );
  });

  it("inherits marvin-graph so graphify-first extends to scouts", () => {
    // If this breaks, golden rule 7 silently stops applying to parallel
    // research — scouts would grep-and-pray their way through the
    // codebase. The reference-by-name form ("marvin-graph") matches
    // the parent's mcpServers registration.
    expect(SCOUT_AGENT.mcpServers).toEqual(["marvin-graph"]);
  });

  it("inherits the parent turn's model (no Opus escalation)", () => {
    // Opus-hint is the advisor's job (ADR-0007), not the scout's.
    // A scout that silently runs on Opus would blow through cost
    // budgets on any breadth-first query.
    expect(SCOUT_AGENT.model).toBe("inherit");
  });

  it("embeds the graph-first rule in the scout's system prompt", () => {
    // Belt-and-braces with the SDK-level constraints: the scout's
    // own prompt must also tell it to graph-first, so that even on
    // models that interpret disallowedTools lazily, the first action
    // is a graph query rather than a speculative file read.
    expect(SCOUT_AGENT.prompt.toLowerCase()).toContain("graph-first");
    expect(SCOUT_AGENT.prompt).toMatch(/marvin-graph/);
  });

  it("tells the scout to synthesise, not forward output to the user", () => {
    // The "user talks to MARVIN, not to a scout" invariant. If this
    // line goes missing, the next subagent refactor risks reintroducing
    // "the scout said X" forwarding, which is the multi-agent failure
    // mode golden rule 1 exists to prevent.
    expect(SCOUT_AGENT.prompt).toMatch(/user does not see you/i);
  });

  it("has a human-readable description suitable for the Task router", () => {
    // The SDK exposes the description to the main session as the cue
    // for when to dispatch. Enforce it's present, substantive, and
    // names the read-only constraint.
    expect(SCOUT_AGENT.description.length).toBeGreaterThan(40);
    expect(SCOUT_AGENT.description.toLowerCase()).toContain("read-only");
  });
});

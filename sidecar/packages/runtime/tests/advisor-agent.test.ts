import { describe, expect, it } from "vitest";

import { buildAdvisorAgent, resolveEffort } from "../src/sdk-runner";

// ADR-0033: the advisor is a registered agent carrying its own model +
// reasoning effort. These tests pin the guarantees the ADR makes — the
// read-only toolset, the model/effort wiring, and the follow-the-executor
// default — so a future edit can't silently relax them.

describe("buildAdvisorAgent (ADR-0033)", () => {
  it("denies every write-capable tool at the SDK layer", () => {
    const agent = buildAdvisorAgent({ model: "claude-opus-4-8", effort: "high" });
    expect(agent.disallowedTools).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash", "NotebookEdit", "WebFetch"]),
    );
  });

  it("carries the advisor model as a full id (the SDK advisorModel Option is unwired)", () => {
    const agent = buildAdvisorAgent({ model: "claude-opus-4-8", effort: "max" });
    expect(agent.model).toBe("claude-opus-4-8");
  });

  it("falls back to inheriting the executor model when none is set", () => {
    const agent = buildAdvisorAgent({ model: undefined, effort: "high" });
    expect(agent.model).toBe("inherit");
  });

  it("carries the per-advisor effort", () => {
    const agent = buildAdvisorAgent({ model: "claude-opus-4-8", effort: "medium" });
    expect(agent.effort).toBe("medium");
  });

  it("embeds the critique structure in the prompt", () => {
    const agent = buildAdvisorAgent({ model: undefined, effort: "high" });
    const p = agent.prompt.toLowerCase();
    expect(p).toContain("risks the plan misses");
    expect(p).toContain("verdict");
  });
});

describe("advisor effort resolution (ADR-0033 default semantics)", () => {
  it("advisorThinkingMode undefined ⇒ executor's effort applies", () => {
    // Mirrors runAgent's wiring: resolveEffort(advisor ?? executor, model).
    const executor = "low";
    const advisor: string | undefined = undefined;
    expect(resolveEffort(advisor ?? executor, "claude-opus-4-8")).toBe("low");
  });

  it("explicit advisor effort wins over the executor's", () => {
    const executor = "low";
    const advisor = "max";
    expect(resolveEffort(advisor ?? executor, "claude-opus-4-8")).toBe("max");
  });

  it("xhigh/max degrade to high on a non-Opus advisor model", () => {
    expect(resolveEffort("max", "claude-sonnet-4-6")).toBe("high");
  });
});

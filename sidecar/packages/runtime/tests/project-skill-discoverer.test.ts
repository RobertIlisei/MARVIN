import { describe, expect, it } from "vitest";

import { oneShotDiscoveryOptions } from "../src/project-skill-discoverer";

// The discoverer is a ONE-SHOT query (maxTurns: 1). 2026-08-30, on OpenRouter,
// every non-Claude model (z-ai/glm-5.3-flash, qwen/...) failed with "Reached
// maximum number of turns (1)": the CLI still OFFERED its built-in tools
// (Bash/Read/Glob…), the model reached for one to explore the project, the CLI
// needed a second turn, and maxTurns: 1 aborted. `allowedTools: []` is a
// PERMISSION list, not availability — the SDK switch that removes built-in
// tools from the model's context entirely is `tools: []`. With no tools
// offered, no model can emit a tool_use, so one turn suffices regardless of
// provider.
//
// Differential evidence (live, against the bundled sidecar): same endpoint,
// same project, same prompt — anthropic/claude-sonnet-4-6 → 200 with
// suggestions; z-ai/glm-5.3-flash and no-model default → 500 max-turns.
//
// This asserts the options directly rather than mocking `query`. The mocked
// version passed locally and, in CI, made a REAL SDK call — it failed with
// "Not logged in · Please run /login" — because the module mock did not bind
// there. A test whose mock can silently miss and fall through to the network
// is not testing an option list. The options are a pure function, so this is
// a pure test: no mocks, no subprocess, nothing to miss.

describe("oneShotDiscoveryOptions — the one-shot query contract", () => {
  const opts = () =>
    oneShotDiscoveryOptions({
      model: "claude-sonnet-4-6",
      cwd: "/tmp/does-not-need-to-exist",
      abort: new AbortController(),
    });

  it("offers NO built-in tools, so no model can spend the single turn on a tool call", () => {
    // THE fix. sdk.d.ts: "[] (empty array) - Disable all built-in tools".
    expect(opts().tools).toEqual([]);
  });

  it("keeps allowedTools: [] as well — permission and availability are different switches", () => {
    // Belt and braces: `tools` removes them from context, `allowedTools`
    // would still deny them if a future SDK reintroduced any by default.
    expect(opts().allowedTools).toEqual([]);
  });

  it("stays one-shot and carries no MCP servers", () => {
    expect(opts().maxTurns).toBe(1);
    expect(opts().mcpServers).toEqual({});
  });

  it("passes the caller's model through untouched — provider resolution happens upstream", () => {
    // ADR-0096: the OpenRouter slug is resolved before this point. If this
    // function ever rewrote the id, a non-Anthropic session would break again.
    const or = oneShotDiscoveryOptions({
      model: "anthropic/claude-sonnet-4.5",
      cwd: "/tmp/x",
      abort: new AbortController(),
    });
    expect(or.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("binds the abort controller it was handed — the 120s cap must be able to fire", () => {
    const abort = new AbortController();
    expect(oneShotDiscoveryOptions({ model: "m", cwd: "/tmp/x", abort }).abortController).toBe(abort);
  });
});

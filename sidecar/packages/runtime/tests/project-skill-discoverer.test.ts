import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// The discoverer is a ONE-SHOT query (maxTurns: 1). 2026-08-30, on OpenRouter,
// every non-Claude model (z-ai/glm-5.3-flash, qwen/...) failed with "Reached
// maximum number of turns (1)": the CLI still OFFERED its built-in tools
// (Bash/Read/Glob…), the model reached for one to explore the project, the
// CLI needed a second turn, and maxTurns: 1 aborted. `allowedTools: []` is a
// PERMISSION list, not availability — the SDK switch that removes built-in
// tools from the model's context entirely is `tools: []`. With no tools
// offered, no model can emit a tool_use, so one turn suffices regardless of
// provider. These tests pin that contract.
//
// Differential evidence (live, against the bundled sidecar): same endpoint,
// same project, same prompt — anthropic/claude-sonnet-4-6 → 200 with
// suggestions; z-ai/glm-5.3-flash and no-model default → 500 max-turns.

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../src/models", () => ({
  latestForTier: vi.fn(async () => "claude-sonnet-4-6"),
  fallbackNewestOfTier: vi.fn(() => null),
  ensureProviderModelId: vi.fn((m: string | null | undefined) => m ?? null),
}));

vi.mock("../src/auth", () => ({
  buildSubprocessEnv: vi.fn(() => ({})),
}));

vi.mock("@marvin/project-context", () => ({
  detectFingerprint: vi.fn(() => ({ tags: [] })),
}));

// `recentCommits` shells out to `git -C <workDir> log` with its own 5s
// timeout, against a tmpdir that is not a repo. Alone that resolves in
// milliseconds; inside the full 63-file suite the spawn races vitest's 5s
// default and the test flakes on load — nothing to do with the contract it
// asserts. Stub the subprocess so this stays a pure options test.
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => cb(new Error("git stubbed in test")),
}));

import { discoverProjectSkills } from "../src/project-skill-discoverer";

// Minimal SDK event stream: one result event, no assistant text. The
// discoverer's parseSuggestions tolerates empty text (0 suggestions).
function successResult(): Array<{ type: string; subtype?: string; usage?: unknown }> {
  return [{ type: "result", subtype: "success", usage: {} }];
}

describe("discoverProjectSkills — one-shot query contract", () => {
  afterEach(() => queryMock.mockReset());

  it("passes tools: [] so the subprocess offers NO built-in tools", async () => {
    queryMock.mockImplementation(() =>
      (async function* () {
        for (const evt of successResult()) yield evt;
      })(),
    );
    const workDir = mkdtempSync(join(tmpdir(), "marvin-discover-"));
    await discoverProjectSkills(workDir);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [firstCall] = queryMock.mock.calls;
    expect(firstCall).toBeDefined();
    const opts = firstCall?.[0].options as Record<string, unknown>;
    // THE fix: tools: [] disables all built-in tools at the SDK level
    // (sdk.d.ts: "[] (empty array) - Disable all built-in tools").
    expect(opts.tools).toEqual([]);
    // One-shot stays one-shot.
    expect(opts.maxTurns).toBe(1);
  });
});

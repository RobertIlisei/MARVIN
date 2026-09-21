import { describe, expect, it } from "vitest";

import { contextBaseline } from "../src/context-baseline";

// ADR-0118 — the fixed load a turn starts with, measured by the SDK rather
// than estimated. A fresh agri-saas-platform tab sent 142,596 tokens before
// doing anything; compaction cannot free that, so it has to be seen.
const usage = {
  categories: [
    { name: "System prompt", tokens: 94158, color: "x", kind: "used" as const },
    { name: "MCP tools", tokens: 12000, color: "x", kind: "used" as const },
    { name: "System tools (deferred)", tokens: 13798, color: "x", kind: "deferred" as const },
    { name: "Autocompact buffer", tokens: 33000, color: "x", kind: "buffer" as const },
    { name: "Free space", tokens: 50000, color: "x", kind: "free" as const },
  ],
  totalTokens: 106158,
  maxTokens: 200000,
  percentage: 53,
  model: "claude-fable-5-1",
  mcpTools: [
    { name: "graph_search", serverName: "marvin-graph", tokens: 700, isLoaded: true },
    { name: "graph_query", serverName: "marvin-graph", tokens: 900, isLoaded: true },
    { name: "recall", serverName: "marvin-memory", tokens: 400, isLoaded: true },
    { name: "browser_click", serverName: "playwright", tokens: 300, isLoaded: false },
  ],
};

describe("contextBaseline", () => {
  it("keeps only the categories that occupy the window, largest first", () => {
    const b = contextBaseline(usage);
    expect(b.used).toEqual([
      { name: "System prompt", tokens: 94158 },
      { name: "MCP tools", tokens: 12000 },
    ]);
  });

  it("reports the fixed load as a share of the model's window", () => {
    const b = contextBaseline(usage);
    expect(b).toMatchObject({ model: "claude-fable-5-1", totalTokens: 106158, maxTokens: 200000 });
    expect(b.share).toBeCloseTo(0.53, 2);
  });

  it("sums loaded MCP tool schemas per server and leaves deferred ones out", () => {
    expect(contextBaseline(usage).mcpServers).toEqual({ "marvin-graph": 1600, "marvin-memory": 400 });
  });

  it("names what fills the load: memory files, prompt sections, skills, attachments, threshold", () => {
    const full = {
      ...usage,
      autoCompactThreshold: 167000,
      memoryFiles: [{ path: "/p/AGENTS.md", type: "Project", tokens: 3200 }, { path: "/p/CLAUDE.md", type: "Project", tokens: 2900 }],
      systemPromptSections: [{ name: "append", tokens: 60000 }, { name: "preset", tokens: 33000 }],
      skills: { totalSkills: 40, includedSkills: 40, tokens: 9934, skillFrontmatter: [] },
      messageBreakdown: { attachmentsByType: [{ name: "deferred_tools", tokens: 20000 }, { name: "hook", tokens: 10 }] },
    };
    const b = contextBaseline(full);
    expect(b.autoCompactThreshold).toBe(167000);
    expect(b.memoryFiles).toEqual([{ path: "/p/AGENTS.md", tokens: 3200 }, { path: "/p/CLAUDE.md", tokens: 2900 }]);
    expect(b.systemPromptSections[0]).toEqual({ name: "append", tokens: 60000 });
    expect(b.skills).toEqual({ total: 40, included: 40, tokens: 9934 });
    expect(b.attachments).toEqual([{ name: "deferred_tools", tokens: 20000 }, { name: "hook", tokens: 10 }]);
  });

  it("tolerates a response without the optional arrays", () => {
    const b = contextBaseline({ categories: [], totalTokens: 0, maxTokens: 0, model: "m" });
    expect(b).toMatchObject({ used: [], mcpServers: {}, share: 0, memoryFiles: [], attachments: [], skills: null });
  });
});

# MCP servers

MARVIN registers two in-process MCP servers on every turn. Both are mounted by [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) via the Agent SDK's `mcpServers` option. Both are transparent to the user — tool calls against them appear in the chat stream as `mcp__<server>__<tool>`.

## `marvin-graph`

In-process stdio MCP server that exposes the active project's knowledge graph. Backed by [`sidecar/packages/graphify-bridge/src/mcp-server.ts`](../../../sidecar/packages/graphify-bridge/src/mcp-server.ts). Reads `<cwd>/graphify-out/graph.json` lazily on first tool call.

### Tools

#### `graph_summary`

Overview of the graph. No arguments.

**Returns:**

```ts
{
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  godNodes: Array<{ label: string; degree: number; sourceFile: string | null }>;
  topCommunities: Array<{ id: number; label: string; size: number; cohesion: number }>;
}
```

Use case: first-turn orientation. "What's in this codebase?"

#### `graph_search`

Fuzzy-search nodes by label.

**Arguments:** `{ query: string, limit?: number = 10 }`

**Returns:** `Array<{ id, label, sourceFile, sourceLocation, score }>`

Use case: "find anything related to `authentication`."

#### `graph_neighbors`

1-hop and 2-hop neighbors of a named node.

**Arguments:** `{ query: string, hops?: 1 | 2 = 1 }`

**Returns:**

```ts
{
  center: { id, label, sourceFile };
  neighbors: Array<{
    id, label, sourceFile,
    relation: string;           // "calls", "imports", etc.
    confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
    hops: 1 | 2;
  }>;
}
```

Use case: blast-radius enumeration in the impact-analysis phase.

#### `graph_path`

Shortest path between two nodes (undirected BFS within one graph).

**Arguments:** `{ from: string, to: string, relations?: string[], scope? }` — `relations` restricts the walk to those edge relations, e.g. `["calls", "imports", "imports_from", "method", "contains"]` for a path code actually takes; without it BFS may thread through a `references` string mention.

**Returns:** `Array<{ id, label, relation, confidence, sourceFile }>` — the chain, head to tail. Each hop carries the relation of the edge it *leaves* by (the last has none) and its file, so the path reads as a touchpoint list.

Use cases: "how does the chat input reach the Agent SDK?" — surface the intermediate hops. And Phase 5 planning (2026-09-07): the structural path from the entry symbol a change touches to the persistence symbol it reaches is milestone 1's touchpoint list — the tracer bullet through every layer.

### Notes

- If `<cwd>/graphify-out/graph.json` doesn't exist, every tool returns an empty result with a hint: "no graph found — run `/graphify .` in this project's root."
- The server is **per-turn**: a fresh instance is created every time `runAgent()` runs. It picks up graph updates between turns automatically.
- Graph queries write Q&A back into the graph on disk so future queries can cite them. See [Graphify — feedback loop](../concepts/graphify-integration.md).

## Browser automation

The Playwright CLI (default) is not an MCP — MARVIN shells out via `Bash` (`npx playwright` is on PATH) for one-shot captures + full `npx playwright test` suites. See [browser tools in `personality.ts`](../../sidecar/packages/runtime/src/personality.ts).

**Opt-in Playwright MCP (ADR-0045).** An external stdio server (`npx @playwright/mcp@latest`, key `playwright` ⇒ `mcp__playwright__browser_*`) for interactive, stateful browsing. **Off by default**; enabled per-turn via the `playwrightEnabled` setting (header Setup popover / macOS Settings ▸ Browser). Unlike the in-process servers above (blanket-allowed), it is **gated** in `classifyToolCall`: observation auto, interaction/navigation confirm, `browser_run_code_unsafe` denied, and the ADR-0030 subagent invariant restricts sub-agents to the observational tools.

One-time setup on a fresh machine:

```bash
npx playwright install chromium
```

Browser binaries aren't shipped via npm; you must install them before MARVIN can drive a browser.

## Adding a new MCP server

To ship a new `marvin-*` MCP:

1. Create a module in `sidecar/packages/runtime/src/` that exports an `McpServerConfig` — prefer in-process servers (like `marvin-graph`) over stdio children, which can leak subprocesses on long sessions.
2. Wire it into [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) in the `mcpServers` object.
3. Document the tools in this file.
4. Write an ADR if the server is material.
5. Update `personality.ts` `CORE_BEHAVIOR` to tell the executor when to prefer it.

## Related

- [Graphify integration](../concepts/graphify-integration.md) — how the knowledge graph feeds MARVIN's reasoning.
- [Tool policy](../security/tool-policy.md) — MCP tools auto-allow; that rule lives in the policy.
- [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) — MCP registration implementation.
- [`sidecar/packages/graphify-bridge/src/mcp-server.ts`](../../../sidecar/packages/graphify-bridge/src/mcp-server.ts) — `marvin-graph` source.

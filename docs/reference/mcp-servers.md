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

Shortest path between two nodes.

**Arguments:** `{ from: string, to: string }`

**Returns:** `Array<{ id, label, relation, confidence }>` — the chain, head to tail.

Use case: "how does the chat input reach the Agent SDK?" — surface the intermediate hops.

### Notes

- If `<cwd>/graphify-out/graph.json` doesn't exist, every tool returns an empty result with a hint: "no graph found — run `/graphify .` in this project's root."
- The server is **per-turn**: a fresh instance is created every time `runAgent()` runs. It picks up graph updates between turns automatically.
- Graph queries write Q&A back into the graph on disk so future queries can cite them. See [Graphify — feedback loop](../concepts/graphify-integration.md).

## Browser automation — no longer an MCP

MARVIN previously shipped a `marvin-playwright` MCP server (`@playwright/mcp` registered as a stdio child) so the executor could screenshot and drive `localhost` / LAN URLs that the host's sandboxed Playwright MCP refused. That integration was retired: the stdio child leaked subprocesses on long sessions (observed: MCP children holding the parent CLI alive past `result`, wedging turns for 20+ min) and made every turn pay subprocess-spawn latency even when no browser work was needed.

The replacement: when MARVIN needs Playwright, it shells out via `Bash` directly — `npx playwright` is on PATH. Same capability, zero per-turn cost, no orphan-process risk. See [browser tools in `personality.ts`](../../sidecar/packages/runtime/src/personality.ts) for the patterns the executor reaches for (one-shot screenshot, scripted `node /tmp/check.mjs`, full `npx playwright test` suite).

One-time setup on a fresh machine:

```bash
npx playwright install chromium
```

Browser binaries aren't shipped via npm; you must install them before MARVIN can use Playwright.

## Adding a new MCP server

To ship a new `marvin-*` MCP:

1. Create a module in `sidecar/packages/runtime/src/` that exports an `McpServerConfig` — typically an in-process server (like `marvin-graph`). Avoid stdio children unless absolutely necessary; the previous Playwright integration is the cautionary tale.
2. Wire it into [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) in the `mcpServers` object.
3. Document the tools in this file.
4. Write an ADR if the server is material.
5. Update `personality.ts` `CORE_BEHAVIOR` to tell the executor when to prefer it.

## Related

- [Graphify integration](../concepts/graphify-integration.md) — how the knowledge graph feeds MARVIN's reasoning.
- [Tool policy](../security/tool-policy.md) — MCP tools auto-allow; that rule lives in the policy.
- [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) — MCP registration implementation.
- [`sidecar/packages/graphify-bridge/src/mcp-server.ts`](../../../sidecar/packages/graphify-bridge/src/mcp-server.ts) — `marvin-graph` source.

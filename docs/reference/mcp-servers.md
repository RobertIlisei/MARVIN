# MCP servers

MARVIN registers two in-process MCP servers on every turn. Both are mounted by [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts) via the Agent SDK's `mcpServers` option. Both are transparent to the user — tool calls against them appear in the chat stream as `mcp__<server>__<tool>`.

## `marvin-graph`

In-process stdio MCP server that exposes the active project's knowledge graph. Backed by [`packages/graphify-bridge/src/mcp-server.ts`](../../../packages/graphify-bridge/src/mcp-server.ts). Reads `<cwd>/graphify-out/graph.json` lazily on first tool call.

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

## `marvin-playwright`

MARVIN's own Playwright MCP server, backed by [`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp). Registered by [`createPlaywrightMcpConfig()`](../../../packages/runtime/src/playwright-mcp.ts) and mounted under the name `marvin-playwright`.

### Why MARVIN ships its own

The host's Playwright MCP — the one registered at the Claude Code level as `playwright-greenstack-local` or similar — **sandboxes localhost/loopback/LAN URLs**. MARVIN couldn't screenshot or drive any local dev server through it. So MARVIN registers its own instance that's unsandboxed by default (trust boundary: you're running it against your own machine).

See the [2026-04-18 entry in the changelog](../history/CHANGELOG.md) for the diagnostic trail.

### Tools exposed

The full Playwright MCP tool set — 21 tools at the version pinned in `packages/runtime/package.json`:

- `browser_navigate`, `browser_navigate_back`
- `browser_click`, `browser_hover`, `browser_drag`
- `browser_type`, `browser_press_key`, `browser_fill_form`
- `browser_take_screenshot`, `browser_snapshot` (accessibility tree)
- `browser_evaluate`, `browser_run_code`
- `browser_network_requests`, `browser_console_messages`
- `browser_tabs`, `browser_resize`
- `browser_select_option`, `browser_file_upload`
- `browser_handle_dialog`
- `browser_wait_for`, `browser_close`

All prefixed `mcp__marvin-playwright__` when they appear in tool calls.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MARVIN_PLAYWRIGHT` | unset = enabled | `0` to skip registering the server |
| `MARVIN_PLAYWRIGHT_HEADED` | `0` (headless) | `1` for a visible window |
| `MARVIN_PLAYWRIGHT_BROWSER` | `chromium` | `chromium` / `firefox` / `webkit` |
| `MARVIN_PLAYWRIGHT_PROFILE` | isolated | path to a persistent user-data-dir |
| `MARVIN_PLAYWRIGHT_VIEWPORT` | default | e.g. `1440,900` |

One-time setup on a fresh machine:

```bash
npx playwright install chromium
```

Browser binaries aren't shipped via npm; you must install them before MARVIN can use Playwright. See [Quickstart](../getting-started/quickstart.md).

### Preferring `marvin-playwright` over the host's

MARVIN's `personality.ts` explicitly instructs the executor: "prefer `marvin-*` MCP servers over any host-level equivalents." So when both the host's Playwright MCP and `marvin-playwright` are available, MARVIN picks the un-sandboxed one.

## Adding a new MCP server

To ship a new `marvin-*` MCP:

1. Create a module in `packages/runtime/src/` that exports an `McpServerConfig` — either stdio-via-npx (like `marvin-playwright`) or in-process (like `marvin-graph`).
2. Wire it into [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts) in the `mcpServers` object.
3. Document the tools in this file.
4. Write an ADR if the server is material.
5. Update `personality.ts` `CORE_BEHAVIOR` to tell the executor when to prefer it.

## Related

- [Graphify integration](../concepts/graphify-integration.md) — how the knowledge graph feeds MARVIN's reasoning.
- [Tool policy](../security/tool-policy.md) — MCP tools auto-allow; that rule lives in the policy.
- [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts) — MCP registration implementation.
- [`packages/graphify-bridge/src/mcp-server.ts`](../../../packages/graphify-bridge/src/mcp-server.ts) — `marvin-graph` source.
- [`packages/runtime/src/playwright-mcp.ts`](../../../packages/runtime/src/playwright-mcp.ts) — `marvin-playwright` source.

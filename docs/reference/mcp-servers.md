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

## `marvin-supervise` (the supervisor session only)

The supervisor's only acting surface ([ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md)). Built by [`supervisor-mcp.ts`](../../../sidecar/packages/runtime/src/supervisor-mcp.ts) and mounted by [`supervisor-dispatch.ts`](../../../sidecar/packages/runtime/src/supervisor-dispatch.ts) in the supervisor's own SDK session — **never** in an executor turn: `sdk-runner.ts` does not register it, and `mcpToolPolicy` denies `mcp__marvin-supervise__*` in every turn it classifies. Inside the supervisor session it is admitted only when the SDK reports the in-process server (`mcpServer.source === "sdk"`, ADR-0117). `alwaysLoad: true`, because the supervisor's closed tool set has no `ToolSearch`.

Tools (shadow mode — nothing is performed):

| Tool | What it does |
|---|---|
| `sessions` | The tabs the user delegated, with their pending questions and confirms (each with its raising rule), plan progress and last turn. Supervisor sessions and undelegated tabs are never listed. |
| `read` | One delegated tab's pending question, transcript tail, plan, or the supervisor's ledger for it. Tab content is wrapped as untrusted data. |
| `answer` | A proposed answer to a pending `AskUserQuestion` (chosen labels / "Other" text) with `grounds`, or an `escalate`. Evaluated by the policy (delegation, grounds with provenance, the question heuristic, rate limits, the per-wake breaker, and — milestone 3 — a secret-shaped "Other" text) and ledgered. Never resolves the confirm. |
| `set_posture` | Milestone 2. A proposed change to a tab's posture with `grounds`. A narrowing is a proposal; any widening — Plan → Agent included — escalates. Needs `answer-questions` delegation. In shadow mode nothing changes. |
| `send` | Milestone 3. A proposed `nudge` or `instruction` to a tab, with `grounds`. Needs `answer-questions`. Refused for a tab the user stopped, one waiting on its own job or wakeup, a shared-checkout tab while another session works there, and secret-shaped text; a third nudge at one plan step without spine progress escalates (counted from the ledger's `planSignature`). In shadow mode nothing is sent. |
| `cancel` | Milestone 3. A proposed cancel of a tab's running turn, with a `reason` and `grounds`. Needs `answer-questions` and a live turn. In shadow mode nothing is cancelled. |
| `confirm` | Milestone 3. A proposed allow / deny on an ordinary permission confirm, with `grounds`. Needs `answer-confirms`. A confirm in a supervisor-touched turn is refused (only the user answers it, ADR-0127 §5); a containment or money confirm, or one whose act is on the §4 list, escalates; a question belongs to `answer`. In shadow mode nothing is answered. |

Because the executor never holds this server, `personality.ts` carries no "prefer `marvin-supervise`" line (step 5 below does not apply); the supervisor's own prompt is `supervisor-prompt.ts`.

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

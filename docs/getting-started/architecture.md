# Architecture at a glance

One page. What runs where, and how data moves.

## Runtime topology

```
╭─────────────────────── your machine ────────────────────────╮
│                                                             │
│  Browser tab          Next.js 16 app              Agent SDK │
│  (localhost:3030)     (also port 3030)                      │
│  ┌────────────┐       ┌─────────────┐     ┌───────────────┐ │
│  │ React UI   │──SSE──│ /api/chat   │────▶│ runAgent()    │ │
│  │ chat      │        │ /api/confirm│     │  ▲ canUseTool │ │
│  │ file tree │        │ /api/…      │     │  │            │ │
│  │ graph     │        └─────────────┘     └──┼────────────┘ │
│  └────────────┘                              │              │
│                                              │ MCP servers  │
│                                              ├─ marvin-graph│
│                                              └─ marvin-play…│
│                                                             │
│  User data                       Per-project data           │
│  ~/.marvin/                      <workDir>/                 │
│    sessions/…                      docs/adr/*.md            │
│    cost-tracker.json               .marvin/memory.md        │
│    projects.json                   graphify-out/            │
│    config.json                                              │
│                                                             │
╰─────────────────────────────────────────────────────────────╯
                              │
                              ▼
                    api.anthropic.com
                    (Opus 4.7 by default)
```

Everything except the Anthropic API call runs on `localhost`. No MARVIN backend exists — your machine *is* the backend.

## The three pieces that do real work

### `sidecar/` — Next.js 16 shell

Three-pane layout on `localhost:3030`. File tree · chat · brain/graph pane. Stackable center-column panes for file viewer, terminal, and browser preview. All state lives in React + `localStorage` — no client-side server, no DB.

- Chat stream: `/api/chat` → SSE → [`useChatStream`](../../sidecar/src/components/chat/use-chat-stream.ts) in the client.
- Confirm gate: `/api/confirm` writes back into an in-process [`confirm-registry`](../../sidecar/packages/runtime/src/confirm-registry.ts) keyed by `(turnId, toolUseId)`.
- Turn lifecycle: [`turn-registry`](../../sidecar/packages/runtime/src/turn-registry.ts) decouples SDK execution from the browser's HTTP request so refresh doesn't kill a running turn.

### `sidecar/packages/runtime/` — Agent SDK wrapper

Owns auth, session persistence, model resolution, cost accounting, tool policy, MCP server registration, and the `canUseTool` structural gate.

- [`sdk-runner.ts`](../../sidecar/packages/runtime/src/sdk-runner.ts) — the `runAgent()` entrypoint that `/api/chat` calls. Registers MCP servers, wires personality + project context, installs the confirm gate when `permissionStrategy === "gated"`.
- [`auth.ts`](../../sidecar/packages/runtime/src/auth.ts) — `getAnthropicAuth()` detects which credential form is available (API key env var, Keychain history, Linux/Win `~/.claude/*.json`).
- [`session.ts`](../../sidecar/packages/runtime/src/session.ts) — appends every event to `~/.marvin/sessions/<projectId>/<sessionId>.jsonl`.
- [`cost-tracker.ts`](../../sidecar/packages/runtime/src/cost-tracker.ts) — appends a row per turn to `~/.marvin/cost-tracker.json`, summarizes today / 7d / lifetime.
- [`projects.ts`](../../sidecar/packages/runtime/src/projects.ts) — registry for `~/.marvin/projects.json` + `active-project.json`.

### `sidecar/packages/graphify-bridge/` — knowledge-graph plumbing

An in-process MCP server the Agent SDK mounts on every turn. Exposes four tools:

- `graph_summary` — overview: god nodes + top communities.
- `graph_search` — find nodes by label.
- `graph_neighbors` — 1-hop / 2-hop blast radius from a node.
- `graph_path` — shortest path between two concepts.

See [Graphify integration](../concepts/graphify-integration.md) for the rationale ("36× cheaper than reading files for structural questions") and [`mcp-server.ts`](../../sidecar/packages/graphify-bridge/src/mcp-server.ts) for the implementation.

## Data flow for a single turn

1. **User submits** chat input. Client POSTs to `/api/chat` with `{ message, cwd, model, advisorModel, personality, permissionStrategy, marvinSessionId }`.
2. **Server resolves** the executor + advisor models (body > `runtimeMode` > `defaultModel()`), builds the project context block (first message only), generates a fresh `turnId`.
3. **Server opens** the SSE response and starts [`runAgent()`](../../sidecar/packages/runtime/src/sdk-runner.ts). The SDK registers the `marvin-graph` MCP server and either installs the `canUseTool` confirm callback (gated) or a no-op one (auto). Browser automation is no longer wired as an MCP server — see [browser tools in personality.ts](../../sidecar/packages/runtime/src/personality.ts) for the `npx playwright` shell-out pattern.
4. **SDK runs** the turn. Every `SDKMessage` is forwarded to the client as a `cli.event` SSE event and appended to the JSONL session file. If the confirm gate fires, a `confirm.request` event goes out, and the SDK waits for `/api/confirm` to resolve.
5. **On completion**, the server emits `turn.completed` with the cost + token + duration + final session id. The cost tracker gets a new row.
6. **Browser reconnect** mid-turn? The `turn-registry` still has the event bus alive. A new SSE subscriber tails it from the reconnect point. See [Session persistence](../operations/sessions.md).

## Storage layout

See [Storage reference](../reference/storage.md) for the full details. Summary:

```
~/.marvin/                         (configurable via MARVIN_DATA_DIR)
├── projects.json                  registered projects
├── active-project.json            currently-selected project id
├── config.json                    user preferences (theme, etc.)
├── cost-tracker.json              append-on-turn spend ledger
└── sessions/<projectId>/
    └── <sessionId>.jsonl          one event per line

<workDir>/                         (per-project; lives in the user's repo)
├── docs/adr/NNNN-*.md             Architecture Decision Records
├── .marvin/memory.md              running decision log
└── graphify-out/                  (gitignored cache + graph.json + HTML)
```

## What crosses network boundaries

- **Anthropic API**: chat completions + tool calls, over HTTPS. Nothing else.
- **Browser ↔ Next.js**: same machine, `localhost` only.
- **Playwright MCP** (optional): MARVIN drives a local Chromium; no external traffic unless your Edit/Bash commands themselves fetch from the internet.

## What MARVIN never does

- **No phone home.** No analytics, no telemetry, no crash reporting.
- **No cross-project memory.** Each `workDir` is its own world.
- **No background agents.** When you close the tab, the current turn continues (via `turn-registry`) until it finishes, but nothing new starts.
- **No multi-tenancy.** One user, one machine.

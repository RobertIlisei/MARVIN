# Graphify — knowledge-graph first

For any architecture or "how does X work" question, MARVIN asks the knowledge graph before it reads files. Empirically ~36× cheaper per question; in practice, often finds connections file reads would miss.

## What graphify is

[graphify](https://github.com/safishamsi/graphify) turns a folder of files (code, docs, papers, tweets, images) into a navigable knowledge graph with:

- **Nodes** — entities. Function, class, module, document, concept.
- **Edges** — relationships. `calls`, `imports`, `references`, `cites`, `conceptually_related_to`, `shares_data_with`, `semantically_similar_to`, `rationale_for`.
- **Confidence tags** — every edge is tagged `EXTRACTED` (explicit in source), `INFERRED` (reasonable inference), or `AMBIGUOUS` (uncertain, surfaced).
- **Communities** — clusters found by community detection. Each one has a cohesion score.
- **God nodes** — most-connected nodes (the "hubs" of the project).

The output is stored in `<workDir>/graphify-out/graph.json` plus an interactive `graph.html` and a plain-language `GRAPH_REPORT.md`.

## Rule enforcement

**Graphify-first is a hard rule, not a default.** The authoritative enforcement lives in two places that MARVIN actually reads at turn time:

1. **`packages/runtime/src/personality.ts`** — cross-phase hard rule 6 (near the top of CORE_BEHAVIOR, alongside the phase-discipline rules): *"Graphify FIRST — never read a file blind."* Read / Grep / Glob on any source file for a structural question ("how does X work?", "who calls Y?", "blast radius of Z?") is forbidden until a `marvin-graph` MCP tool has pointed at a specific `source_file` + `source_location` citation. Explicit exceptions for trivial content reads (version checks, files the user just named) and files under active edit.

2. **`CLAUDE.md`** Golden Rule 7 — the same directive, scoped to Claude Code sessions working on MARVIN itself. References the `/graphify query`, `/graphify path`, `/graphify explain` slash commands rather than the in-session `marvin-graph` MCP tools.

Both rules spell out the failure mode they exist to prevent: "grep and pray." A file sweep without a graph query first is a rule violation.

## How MARVIN uses it

**Two integration points:**

### 1. First-message context injection

On turn 1 of each session, [`buildProjectContext()`](../../packages/project-context/src/index.ts) reads `<workDir>/graphify-out/graph.json` and prepends a compact **graph header** to the system prompt:

```
## Knowledge graph (graphify)

- Nodes: 343 · Edges: 396 · Communities: 68
- God nodes: GET(), POST(), 8-Phase Senior-Engineer Workflow,
  Target Architecture (Repo Layout), getAnthropicAuth(), MARVIN,
  MARVIN Project Instructions (CLAUDE.md), Golden Rules
- Top communities: Chat runtime, Agent SDK wiring, Graph bridge,
  UI shell, Project context, …

Tool: use the graph MCP server (marvin-graph) for structural
questions before reading files.
```

MARVIN orients from this before the first tool call, so it knows what's in the codebase before it grep-sweeps.

### 2. Per-turn MCP server

Every turn, the Agent SDK mounts [`createGraphMcpServer()`](../../packages/graphify-bridge/src/mcp-server.ts) as an **in-process stdio MCP server** named `marvin-graph`. It exposes four tools:

| Tool | Use case |
|---|---|
| `graph_summary` | "Give me an overview of this codebase" — god nodes + top communities. |
| `graph_search` | "Find nodes matching `auth`" — fuzzy-search by label. |
| `graph_neighbors` | "What touches `runAgent()`?" — 1-hop + 2-hop blast radius. |
| `graph_path` | "How does `ChatInput` connect to the Agent SDK?" — shortest path. |

Unknown tool names (which include `mcp__marvin-graph__*`) auto-allow in the [tool policy](../security/tool-policy.md), so the gate doesn't interfere with the graph server.

MARVIN's system prompt explicitly names each tool and its trigger situation, so Sonnet in advisor mode knows when to reach for the graph instead of file reads.

## Why this matters (the 36× claim)

Typical architecture question: "how is auth wired?" Without a graph:

- Grep for `auth` → 47 hits.
- Read 8-10 files.
- Follow imports backward to call sites.
- Each file read is ~2-10k tokens of input.

Total: roughly 20-60k tokens to answer one question.

With the graph:

- `graph_search("auth")` → 5-8 relevant nodes.
- `graph_neighbors("getAnthropicAuth")` → 1-hop + 2-hop deps.
- Answer cites source_file + source_location directly.

Total: usually under 1-2k tokens. The 36× number is graphify's own reported figure from its token-reduction benchmark (see [`graphify-out/GRAPH_REPORT.md`](../../graphify-out/GRAPH_REPORT.md) after a build).

## When to rebuild

Per the [Golden Rules in CLAUDE.md](../../CLAUDE.md):

- **Code-only changes**: `/graphify . --update` — AST-only incremental update, no LLM cost. Run after every milestone.
- **Docs / `personality.ts` changes**: `/graphify . --update` — triggers semantic re-extraction for the changed doc files. Minimal cost at typical corpus sizes.

MARVIN itself runs on a graph of *its own code* (the one under `<workDir>/graphify-out/` when `workDir = ~/marvin`). See [`graphify-out/GRAPH_REPORT.md`](../../graphify-out/GRAPH_REPORT.md) for the current stats.

## Watchdog + automatic refresh

[`packages/graphify-bridge/src/watchdog.ts`](../../packages/graphify-bridge/src/watchdog.ts) debounces AST refresh on file changes (default 10 min). So during an active development session, the graph stays roughly current without manual runs.

Doc/image changes still need a manual `/graphify . --update` because semantic re-extraction requires LLM calls and shouldn't fire on every keystroke.

## Git commit hook (optional)

```bash
graphify hook install
```

Installs a post-commit hook that auto-rebuilds the graph after every commit (AST-only, fast, free). Doc changes are ignored by the hook — run `/graphify --update` manually when you want those re-extracted.

## Sample queries

From the MARVIN repo itself:

```
/graphify query "how does the confirm gate resolve"
/graphify path "ChatInput" "runAgent"
/graphify explain "turn-registry"
```

Each writes the answer back into the graph as a new node (type `query` / `path_query` / `explain`), so future queries get smarter as you use them.

## Related

- [Memory and ADRs](./memory-and-adrs.md) — graph is layer 1 of the three-layer ramification stack.
- [MCP servers reference](../reference/mcp-servers.md) — full `marvin-graph` tool catalog.
- [`packages/graphify-bridge/`](../../packages/graphify-bridge/) — the bridge implementation.
- [graphify SKILL.md](https://github.com/safishamsi/graphify) — upstream documentation for the skill itself.

# MARVIN

![MARVIN](./hero.png)

**M**oderately **A**dvanced **R**obotic **V**irtual **I**ntelligence **N**etwork.

A pair-programming AI assistant. You drive vision and business decisions. MARVIN
drives architecture, infrastructure, code, tests, docs, and security.

You say *"let's build the login page"* — MARVIN dives in: reads the codebase,
proposes the schema + wiring + tests, executes with explicit confirms, commits.

> "Here I am, brain the size of a planet, and they ask me to build a login page."
> — MARVIN, probably

## What makes MARVIN different

- **Single assistant, not an agent team.** Published research on sequential
  coding tasks shows multi-agent autonomy degrades quality up to ~70 % and
  amplifies error rates 17× in flat-topology setups. MARVIN is one assistant
  moving through an 8-phase workflow in one conversation, with the user as
  continuous overwatch.
- **Plan-first, execute-second, verify-third.** Every feature lives in
  [PLAN.md](./PLAN.md) before code lands.
- **Per-project isolation.** MARVIN holds zero cross-session knowledge about
  other projects. Memory, ADRs, and knowledge graph live inside each user
  project, not in MARVIN's own data dir.
- **Built on a knowledge graph.** Queries [graphify](https://github.com/safishamsi/graphify)
  first on architecture/impact questions — ~36× cheaper than reading raw
  files.

## Features

- 🧠 **MARVIN brain** — live animated state indicator (idle / thinking / tool /
  writing / error)
- 📁 **3-pane shell** — file tree · chat · brain/graph, with collapsible
  embedded terminal, file viewer, and browser preview
- 🔀 **Monaco diff viewer** — see exactly what MARVIN is about to do before
  allowing it; structural confirm-before-act gate on Edit/Write/Bash
- 🧰 **Model picker** — executor + advisor slots, live Anthropic model list
  when credentials are readable, fallback when not
- 💸 **Cost tracker** — daily/weekly/lifetime spend per project
- 🔍 **Graph-aware chat** — in-process MCP server exposes the graphify graph
  (`graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`) so MARVIN
  orients before the first tool call
- ⌨️  **Keyboard shortcuts** — `⌘K` picker · `⌘B/G/J/P` pane toggles · `⌘.`
  cancel · `?` help · `Esc` close
- 🌐 **Own Playwright MCP** — MARVIN drives real browsers against
  `localhost` / LAN URLs (host Playwright MCP often sandboxes loopback)
- 🔄 **Refresh-safe turns** — closing the tab no longer kills a running turn;
  reopen and resume

## Prerequisites

- Node.js **>= 22**
- pnpm **10.33** (declared in `packageManager`)
- Claude credentials — one of:
  - `ANTHROPIC_API_KEY` in env
  - Host credentials from a `claude auth login` (auto-detected)
- For browser automation: `npx playwright install chromium`

## Quickstart

```bash
pnpm install
pnpm dev          # http://localhost:3030
```

First boot — MARVIN will pick up the Agent SDK's auth (host Keychain on macOS,
`~/.claude/.credentials.json` on Linux/Windows, or `ANTHROPIC_API_KEY`). Hit
[`/api/health`](http://localhost:3030/api/health) to verify.

Skills bundle (one-time):

```bash
bash scripts/install-skills.sh
```

This mirrors the pinned Anthropic skills (`frontend-design`, `canvas-design`,
`claude-api`, `mcp-builder`, `webapp-testing`, `skill-creator`, etc.) into
`~/.claude/skills/` so MARVIN's SDK sessions can invoke them.

## Stack

- Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui
- pnpm workspaces · Turbo
- `@anthropic-ai/claude-agent-sdk` runtime with a `canUseTool` pre-flight gate
- xterm.js terminal · monaco-editor diff viewer · react-resizable-panels
- In-process MCP servers: `marvin-graph` (graphify) + `marvin-playwright`
  (`@playwright/mcp`)

## Repo layout

```
apps/web/                    # Next.js 16 app, port 3030
packages/
  runtime/                   # Agent SDK runner, auth, session, cost, models, turn registry
  tools/                     # tool policy (auto / confirm / deny)
  project-context/           # spec + ADR + memory + graph-header injection
  graphify-bridge/           # knowledge-graph read + MCP server
  git-watch/                 # per-workDir commit stream
  ui/                        # shadcn primitives + MARVIN brain
data/.marvin/                # session transcripts, cost tracker, graph cache (gitignored)
```

## Status

**v1 shipped.** Phases 1–4 landed 2026-04-17; Phase 5 stretch items (advisor
mode, preview pane, graph-aware chat, keyboard shortcuts + session search,
dual-theme support, BrainLiquid canvas particle brain) shipped 2026-04-18/19.
Honeycomb MCP integration remains explicitly deferred (needs Honeycomb
account + team setup). See [PLAN.md](./PLAN.md) for the phase-by-phase
changelog and [docs/roadmap.md](./docs/roadmap.md) for the narrative view.

## Documentation

Full documentation at [docs/](./docs/). Modeled on Claude Code's docs site.

**Entry points:**
- [Overview](./docs/getting-started/overview.md) — what MARVIN is, who it's for
- [Quickstart](./docs/getting-started/quickstart.md) — install → first session
- [Architecture at a glance](./docs/getting-started/architecture.md)
- [Core concepts](./docs/README.md#core-concepts) — single-assistant, 8-phase workflow, isolation, confirm gate, advisor, graphify, ADRs
- [HTTP API reference](./docs/reference/api.md) — all 17 endpoints
- [Architecture decisions](./docs/decisions/) — six ADRs covering the design choices

## License

Not yet specified. See [docs/business/licensing.md](./docs/business/licensing.md) for the consideration.

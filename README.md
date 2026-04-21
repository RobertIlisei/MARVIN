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

- 🍎 **Installable macOS app** — `bin/marvin install-app` ships a real
  `/Applications/MARVIN.app` plus a launchd user agent that auto-starts
  the server on login. Double-click from Spotlight / Launchpad / Dock.
- 🧠 **MARVIN brain** — live animated state indicator (idle / thinking / tool /
  writing / error)
- 📁 **IDE-style 3-pane shell** — file tree with icons · chat · brain/graph,
  with collapsible embedded terminal, Monaco file editor, and browser preview
- 🌿 **Source control panel** — VSCode-style status tree, stage/unstage,
  commit, branch switcher (local + remote), diff viewer; structural confirm
  gate is enforced across every mutation channel
- 🏷️ **Workspace status bar** — persistent footer under the left column
  shows workspace name + current branch + ahead/behind badges; click to
  jump straight into Source Control
- 🌓 **Light + dark themes** — OKLCH-based token cascade, paper-cream light
  / neutral-dark dark, theme-aware Monaco + xterm + git status colours
- 🔀 **Monaco editor + diff** — see exactly what MARVIN is about to do
  before allowing it; structural confirm-before-act gate on Edit/Write/Bash
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
pnpm install                   # one-time — pulls deps across 7 packages
bash scripts/install-skills.sh # one-time — mirror skills bundle to ~/.claude/skills/
bin/marvin                     # start MARVIN on http://localhost:3030
```

`bin/marvin` runs every preflight check (Node ≥22, pnpm, skills, port
availability, credentials), backgrounds the dev server, polls
`/api/health`, and prints the URL + auth mode + model once it's up.

### Install as a real macOS app _(recommended)_

One command builds `MARVIN.app`, drops it in `/Applications/`, and
installs a launchd user agent so the server auto-starts on every login.
After that, MARVIN behaves like any native app — double-click from
Spotlight, Launchpad, or the Dock and the window opens into the UI:

```bash
bin/marvin install-app         # build → /Applications → launchd agent → health-check
bin/marvin uninstall-app       # unload agent + remove app (source tree untouched)
```

Needs Rust once (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`).
See [`apps/desktop/README.md`](./apps/desktop/README.md) for the full
install contract and [ADR-0010](./docs/decisions/0010-desktop-wrapper-tauri.md)
for the architecture rationale.

### Lifecycle

```
bin/marvin              # alias for start
bin/marvin status       # is it up? auth + model + data dir
bin/marvin logs         # tail .marvin/dev.log
bin/marvin stop         # kill the process group cleanly
bin/marvin restart
bin/marvin doctor       # preflight only — no start
bin/marvin install-app  # build + install native macOS app (see above)
bin/marvin uninstall-app
bin/marvin help
```

### Raw fallback

If you want to drive `pnpm dev` directly (skipping `bin/marvin`'s
preflight + pid tracking):

```bash
pnpm dev          # foreground, Ctrl-C to stop
```

### Skills bundle

The `install-skills.sh` step mirrors the pinned Anthropic skills
(`frontend-design`, `canvas-design`, `claude-api`, `mcp-builder`,
`webapp-testing`, `skill-creator`, etc.) plus MARVIN's own adopted skills
(`test-driven-development`, `systematic-debugging`, `pr-review`,
`security-audit`) into `~/.claude/skills/` so MARVIN's SDK sessions can
invoke them. Idempotent — re-running is safe.

### Credentials

MARVIN uses the Agent SDK's auth detection in priority order: direct
`ANTHROPIC_API_KEY` env var → `~/.claude/.credentials.json` /
`~/.claude/auth.json` (Linux / Windows) → macOS Keychain (state dir
activity). See [docs/security/credentials.md](./docs/security/credentials.md)
for the full detection rules and how to pick between API-key and
host-credentials modes.

## Stack

- Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui
- pnpm workspaces · Turbo
- `@anthropic-ai/claude-agent-sdk` runtime with a `canUseTool` pre-flight gate
- xterm.js terminal · monaco-editor diff viewer · react-resizable-panels
- In-process MCP servers: `marvin-graph` (graphify) + `marvin-playwright`
  (`@playwright/mcp`)

## Repo layout

```
apps/
  web/                       # Next.js 16 app, port 3030
  desktop/                   # Tauri 2 macOS wrapper (ADR-0010)
packages/
  runtime/                   # Agent SDK runner, auth, session, cost, models, turn registry
  tools/                     # tool policy (auto / confirm / deny)
  project-context/           # spec + ADR + memory + graph-header injection
  graphify-bridge/           # knowledge-graph read + MCP server
  git-watch/                 # per-workDir commit stream
  ui/                        # shadcn primitives + MARVIN brain
data/.marvin/                # session transcripts, cost tracker, graph cache (gitignored)
```

### Desktop dev loop

For hot-reloading the native shell against the live dev server:

```bash
bin/marvin                # terminal 1 — start the web server
pnpm desktop:dev          # terminal 2 — opens the Tauri window
```

This is the right loop when you're changing MARVIN's own UI. For
day-to-day use, `bin/marvin install-app` (above) is the pragmatic path —
no terminals, auto-start on login.

See [`apps/desktop/README.md`](./apps/desktop/README.md) + [ADR-0010](./docs/decisions/0010-desktop-wrapper-tauri.md) for the details and what v1 deliberately leaves out.

## Status

**v1.1 shipped.** The app is now fully installable: `bin/marvin install-app`
builds the bundle, copies it to `/Applications/`, and wires a launchd user
agent so the server auto-starts on login. Everything from v1 — advisor
mode, preview pane, graph-aware chat, keyboard shortcuts, session search,
dual-theme support, BrainLiquid brain, graphify-first hard rule — plus
the v1.1 additions: source control panel (stage / unstage / commit /
branch switch, local + remote), user-initiated filesystem writes with
structural confirm, Monaco editor with CAS-guarded save, VSCode-style
workspace status bar, light-theme recolour, Tauri shell polish
(system-font stack, vibrancy materials, traffic-light padding), and the
launchd-agent install flow.

Honeycomb MCP integration remains deferred (needs Honeycomb account +
team setup). See [PLAN.md](./PLAN.md) for the phase-by-phase changelog
and [docs/roadmap.md](./docs/roadmap.md) for the narrative view.

## Documentation

Full documentation at [docs/](./docs/). Modeled on Claude Code's docs site.

**Entry points:**
- [Overview](./docs/getting-started/overview.md) — what MARVIN is, who it's for
- [Quickstart](./docs/getting-started/quickstart.md) — install → first session
- [Architecture at a glance](./docs/getting-started/architecture.md)
- [Core concepts](./docs/README.md#core-concepts) — single-assistant, 8-phase workflow, isolation, confirm gate, advisor, graphify, ADRs
- [HTTP API reference](./docs/reference/api.md) — every endpoint
- [Architecture decisions](./docs/decisions/) — ADRs covering the design choices

## License

[MIT](./LICENSE) · © 2026 Robert Ilisei · See [docs/business/licensing.md](./docs/business/licensing.md) for the rationale vs Apache 2.0 / MPL / GPL.

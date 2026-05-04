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
- **Plan-first, execute-second, verify-third.** Sketch the approach, ship,
  then verify. In-flight + shipped work is tracked in
  [`docs/roadmap.md`](./docs/roadmap.md).
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
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`. The
  Agent SDK spawns the `claude` binary under the hood, so it has to be
  on PATH (or pointed at via `MARVIN_CLAUDE_BIN`). `bin/marvin doctor`
  will warn if it's missing.
- Claude credentials — one of:
  - `ANTHROPIC_API_KEY` in env
  - Host credentials from `claude auth login` (auto-detected). After
    install, also visit https://claude.ai once with the same email to
    accept the latest Consumer Terms — the CLI returns a 400 until you do.
- For browser automation: `npx playwright install chromium`
- For the knowledge graph (Golden Rule 7): `pip install graphifyy` —
  optional, but the brain pane and graph-aware chat are unavailable
  without it.

## Installation

```bash
pnpm install                   # one-time — pulls deps across 7 packages
bash scripts/setup.sh          # one-time — interactive prompts for optional deps
bash scripts/install-skills.sh # one-time — mirror skills bundle to ~/.claude/skills/
bin/marvin                     # start MARVIN on http://localhost:3030
```

`scripts/setup.sh` prompts for the optional / recommended dependencies
(Claude Code CLI, graphify, Playwright Chromium) with Y/n/never. Pick
`never` and the choice is saved to `.marvin/install-prefs.json` so
future `bin/marvin doctor` runs stop nagging. Use `--yes` to install
every missing dep without prompting, or `--skip-all` to record skips
without installing.

`bin/marvin` runs every preflight check (Node ≥22, pnpm, skills, Claude
CLI, port availability, credentials, graphify CLI, graph rooting),
backgrounds the dev server, polls `/api/health`, and prints the URL +
auth mode + model once it's up.

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

## Troubleshooting

Quick reference for the issues that hit most often. Full guide at [docs/guides/troubleshooting.md](./docs/guides/troubleshooting.md).

**First diagnostic — always:**

```bash
curl -s http://localhost:3030/api/health | jq .
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `auth.mode: "none"` in `/api/health` | No credentials detected | Set `ANTHROPIC_API_KEY` in your shell, or run `claude auth login`. See [Credentials](./docs/security/credentials.md) |
| `binaryError: "..."` in `/api/health` | Claude CLI binary missing from PATH | `which claude` — if empty, `npm install -g @anthropic-ai/claude-code` or set `MARVIN_CLAUDE_BIN` |
| Every turn fails with `API Error: 400 ...Consumer Terms...` | Anthropic account hasn't accepted the latest Terms | Open https://claude.ai with the email shown in `claude /status`, accept the banner, retry |
| Graph pane works but `/graphify` says `command not found` | graphify Python package not installed | `pip install graphifyy` (or `pipx install graphifyy`) |
| `EADDRINUSE: address already in use :::3030` | Another MARVIN instance running | `lsof -iTCP:3030 -sTCP:LISTEN` → kill it or point your browser at the existing one |
| Models dropdown shows "fallback list" | `claude auth login` stored the token in the macOS Keychain (Node can't read) | Set `ANTHROPIC_API_KEY` directly for live `/v1/models` listing |
| MARVIN asks for `marvin-playwright` and SDK errors | Chromium binaries missing | `npx playwright install chromium` (one-time) |
| Graph pane shows "no graph found" | graphify hasn't been run on the active project | `cd <workDir> && /graphify .` — or ask MARVIN to build the graph |
| Terminal exits with `[exit 0 · 0.00s]` immediately | No project selected (invalid `cwd`) | Pick a project in the picker (`⌘K`) |
| File tree empty / "Permission denied" | `workDir` not readable by the user running `pnpm dev` | Fix perms (`chmod` / `chown`), or pick a different `workDir` |
| Preview pane blank | Target site sends `X-Frame-Options: DENY` or CSP `frame-ancestors` | Click ↗ to open in a new tab — browsers enforce this for third-party sites |
| Turn costs surprisingly high | Cache-misses on long sessions | Start a new session (`⌘⇧N`), or try advisor mode for ~30-40% savings |

**Lifecycle helpers** for diagnosing without opening a browser:

```bash
bin/marvin status   # auth + model + data dir
bin/marvin doctor   # preflight only
bin/marvin logs     # tail .marvin/dev.log
```

**Still stuck?** Open an issue at [github.com/RobertIlisei/MARVIN/issues](https://github.com/RobertIlisei/MARVIN/issues) with `/api/health` output, browser console errors, the last few lines of the `pnpm dev` terminal, and the last 20 lines of the relevant `~/.marvin/sessions/<projectId>/<sessionId>.jsonl`.

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

**v1.2 shipped.** Audit-driven hardening pass: closed every 🔴 finding
in the [2026-04-26 full audit](./docs/reviews/2026-04-26-full-audit.md)
and most of the 🟠 list. Highlights:

- **Permission gate is now load-bearing in `auto` mode too.** Bare
  `Task` calls and unknown subagent types require a confirm; sanctioned
  types (`scout`, `general-purpose`) auto-allow. `BASH_HARD_DENY` no
  longer leaks `rm -rf $HOME/...`, `rm -rf ~`, `rm -rf ../`, `rm -rf *`,
  `git push -f`, `chmod -R 777`, `curl … | sh`. 26-case Vitest pin at
  `packages/tools/tests/policy.test.ts`.
- **Auto-mode audit log.** Every auto-allowed Edit/Write/Bash now
  appends one JSONL line to `<workDir>/.marvin/auto-audit.jsonl`. New
  `/api/audit/auto` route; first-run banner explaining `auto` =
  bypass.
- **Confirm prompts.** Severity classifier (warn / danger), filled
  accent allow button, blast-radius hint, soft 3-pulse, `(N)`
  `document.title` badge while pending, 5-minute auto-deny via the
  registry timer. Closing the tab no longer hangs the SDK loop.
- **Honeycomb env race fixed.** New pure
  `computeHoneycombTelemetryEnv()` returns the env-diff to merge;
  `runAgent` passes it via `Options.env` per-turn so concurrent turns
  for two projects don't clobber each other.
- **`/api/chat` cwd validation.** Returns 400 + `code: "invalid-cwd"`
  when cwd is missing, non-absolute, or equals MARVIN's own install
  root — closes the self-modification fallback.
- **TopBar collapsed.** 17 controls → 7. Layout + Setup popovers via
  Radix `DropdownMenu`. Models has its own dialog (the picker is too
  tall for a popover). Theme stays a single icon-toggle.
- **Empty-state hero trimmed.** Brain unchanged at `size={340}` per
  user preference; coordinate marks, capability chips, blockquote,
  long tagline moved to a wordmark tooltip. 12 visual elements → 6.
- **Chat surface improvements.** Sticky-bottom scroll with 80 px
  threshold + "↓ jump to latest" pill. Stream-end errors are now
  structured with a Retry button. New `cancelling` state holds the
  UI inert until `/api/chat/cancel` resolves. BrainLiquid pauses on
  `document.hidden` + honours `prefers-reduced-motion` (particle count
  unchanged).
- **`page.tsx` decomposed.** Seven scattered localStorage effects
  collapsed into a single `useMarvinPrefs()` Context with a
  "Reset MARVIN preferences" action. Chat scroller windowed at 200
  messages with a "show earlier" button.
- **`bin/marvin doctor`** gained a graph smoke check that asserts at
  least 5 % of nodes are MARVIN-rooted — catches the audit's
  finding #1 mis-rooting silently in future.

[Definition of Done](./docs/reviews/DEFINITION_OF_DONE.md) for audits and
tasks lives in-tree. Honeycomb MCP integration remains deferred (needs
Honeycomb account + team setup). See [`docs/roadmap.md`](./docs/roadmap.md)
for current state and [`docs/history/CHANGELOG.md`](./docs/history/CHANGELOG.md)
for the chronological record of what shipped.

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

# MARVIN

**M**oderately **A**dvanced **R**obotic **V**irtual **I**ntelligence **N**etwork.

A pair-programming AI assistant. You drive vision and business decisions. MARVIN
drives architecture, infrastructure, code, tests, docs, and security.

You say *"let's build the login page"* — MARVIN dives in: reads the codebase,
proposes the schema + wiring + tests, executes with explicit confirms, commits.

> "Here I am, brain the size of a planet, and they ask me to build a login page."
> — MARVIN, probably

---

## Architecture overview

MARVIN has two components that work together:

| Component | Location | Role |
|---|---|---|
| **macOS app** | `apps/macos/` | Native SwiftUI app — IDE shell, chat, file tree, source control, terminal, diff viewer |
| **Web sidecar** | `apps/web/` | Next.js 16 server on `:3030` — Claude Agent SDK runner, tool policy, git API, file API, session storage |

The Swift app talks to the sidecar over `localhost:3030`. The sidecar starts automatically on login via a launchd user agent installed by `bin/marvin install-macos-app`.

---

## Install (one-liner)

No Apple Developer account required. Builds from source — ad-hoc signed.

```bash
curl -fsSL https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/scripts/install.sh | bash
```

**What it does:**
1. Checks prerequisites (git, Node ≥ 22, pnpm, Xcode / Swift CLT)
2. Clones the repo to `~/.marvin-app`
3. Installs Node dependencies (`pnpm install`)
4. Builds `MARVIN.app` and installs it to `/Applications`
5. Installs a launchd agent so the sidecar starts automatically on login
6. Symlinks `bin/marvin` → `/usr/local/bin/marvin`

**First launch note:** macOS Gatekeeper will warn on the first open because the
app is ad-hoc signed. Right-click → Open, or go to System Settings → Privacy &
Security → "Open Anyway".

**To uninstall:**

```bash
curl -fsSL https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/scripts/uninstall.sh | bash
# or, if marvin is already on PATH:
marvin uninstall-macos-app
```

---

## Install from source (existing clone)

If you already have the repo:

```bash
bin/marvin install-macos-app   # build → /Applications/MARVIN.app + launchd agent
bin/marvin uninstall-macos-app # remove app + agent (source tree untouched)
```

Requires `xcodegen` + Xcode, **or** just the Swift Command Line Tools (`xcode-select --install`).
If xcodegen is missing, `swift build` is used automatically as a fallback — no Developer account needed in either path.

---

## Prerequisites

### macOS app (`apps/macos/`)

| Requirement | How to get it |
|---|---|
| macOS 14+ | System update |
| Xcode ≥ 15 **or** Swift CLT | `xcode-select --install` |
| xcodegen *(optional, preferred)* | `brew install xcodegen` |

### Web sidecar (`apps/web/`)

| Requirement | How to get it |
|---|---|
| Node.js **≥ 22** | [nodejs.org](https://nodejs.org) or `brew install node@22` |
| pnpm | `npm install -g pnpm` |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| Claude credentials | `claude auth login` — or set `ANTHROPIC_API_KEY` in env |

**Optional:**

- `npx playwright install chromium` — needed for `marvin-playwright` MCP (browser automation)
- `pip install graphifyy` — needed for the knowledge graph (`/graphify`, graph-aware chat)

After `claude auth login`, also visit [claude.ai](https://claude.ai) once with the same email to accept the latest Consumer Terms — the CLI returns 400 until you do.

---

## Development setup

### Run the sidecar

```bash
pnpm install                    # once — installs deps across all packages
bash scripts/setup.sh           # once — prompts for optional deps (Playwright, graphify)
bash scripts/install-skills.sh  # once — mirrors skills bundle to ~/.claude/skills/

bin/marvin start                # production mode (builds if stale, then starts)
bin/marvin stop
bin/marvin restart
bin/marvin status               # auth + model + data dir
bin/marvin logs                 # tail .marvin/dev.log
bin/marvin doctor               # preflight checks only, no start
bin/marvin help
```

For raw Next.js (no pid tracking, skips preflight):

```bash
pnpm build && pnpm start
```

### Build the macOS app

```bash
cd apps/macos
xcodegen generate               # regenerate MARVIN.xcodeproj from project.yml
open MARVIN.xcodeproj           # then build + run in Xcode
```

Or with swift build (Command Line Tools only, no Xcode IDE):

```bash
cd apps/macos
swift build -c release
# The install script assembles the .app bundle from the SPM output automatically.
bin/marvin install-macos-app    # build + install + launchd
```

### Dev loop (sidecar + app together)

```bash
# Terminal 1 — sidecar in the foreground
bin/marvin start

# Terminal 2 — open the built app
open /Applications/MARVIN.app
# or for a faster edit-rebuild-run loop while working on the Swift side:
cd apps/macos && xcodebuild -scheme MARVIN -configuration Debug build && open build/...
```

---

## What makes MARVIN different

- **Single assistant, not an agent team.** Published research on sequential
  coding tasks shows multi-agent autonomy degrades quality up to ~70 % and
  amplifies error rates 17× in flat-topology setups. MARVIN is one assistant
  moving through an 8-phase workflow in one conversation, with the user as
  continuous overwatch.
- **Plan-first, execute-second, verify-third.** Sketch the approach, ship,
  then verify. In-flight + shipped work tracked in [`docs/roadmap.md`](./docs/roadmap.md).
- **Per-project isolation.** MARVIN holds zero cross-session knowledge about
  other projects. Memory, ADRs, and knowledge graph live inside each user
  project, not in MARVIN's own data dir.
- **Built on a knowledge graph.** Queries [graphify](https://github.com/safishamsi/graphify)
  first on architecture/impact questions — ~36× cheaper than reading raw files.

---

## Features

**macOS app**
- 🍎 Native SwiftUI IDE shell — 3-pane layout (file tree · chat · brain/graph)
- 📁 File tree with icons, click-to-open, context menu (create / rename / delete / move)
- 🗒️ Syntax-highlighted file viewer (Swift, TS, JS, Go, Rust, JSON, YAML, Markdown, images)
- 🌿 Source control — stage/unstage, commit, push, pull, fetch, diff viewer, branch line
- 🔍 Project-wide search — ripgrep-backed, include glob filter, replace all
- 🔣 Symbol search and file history
- 🏗️ Build task panel — run build tasks, see diagnostics inline
- 🧩 Diagnostics panel — compiler errors and warnings from build output
- ⌨️ Embedded terminal (PTY-backed)
- 🕐 Session history — click any past session in the header to restore it
- 🧠 MARVIN brain — live animated state indicator (idle / thinking / tool / writing / error)
- 📎 Image paste in chat (⌘V, screenshots, dragged images)
- 🌓 Light / dark theme — respects system preference

**Web sidecar**
- 🔒 Structural confirm gate — every Edit/Write/Bash pre-flight, auto-mode audit log
- 💸 Cost tracker — daily/weekly/lifetime spend per project
- 🔀 Monaco diff viewer — see exactly what MARVIN is about to do before allowing
- 🧰 Model picker — executor + advisor slots, live model list from Anthropic
- 🌐 Playwright MCP — MARVIN drives real browsers against `localhost` / LAN URLs
- 🔄 Resume across reloads — closing the window doesn't kill a running turn
- 📊 Graph-aware chat — in-process MCP exposes `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`

---

## Repo layout

```
apps/
  macos/                     # SwiftUI macOS app (Xcode / SPM)
    MARVIN/                  # Swift sources
    project.yml              # xcodegen manifest
    Package.swift            # SPM manifest (swift build fallback)
  web/                       # Next.js 16 sidecar, port 3030
    src/
      app/api/               # REST endpoints (chat, git, files, sessions, health)
      components/            # React UI (web-only surfaces)
packages/
  runtime/                   # Agent SDK runner, auth, session, cost, models, confirm gate
  tools/                     # Tool policy — auto / confirm / deny
  project-context/           # Spec + ADR + memory + graph-header injection
  graphify-bridge/           # Knowledge-graph read + in-process MCP server
  git-watch/                 # Per-workDir commit stream watcher
  ui/                        # shadcn primitives shared by the web app
bin/
  marvin                     # Lifecycle CLI (start/stop/status/logs/doctor/install/uninstall)
scripts/
  install.sh                 # Remote one-liner installer (curl | bash)
  uninstall.sh               # Remote one-liner uninstaller
  setup.sh                   # Interactive optional-dep prompts
  install-skills.sh          # Mirror skills bundle to ~/.claude/skills/
docs/
  decisions/                 # ADRs
  roadmap.md                 # In-flight + shipped features
  history/CHANGELOG.md       # Chronological record
```

---

## Stack

**macOS app**
- Swift 5.10 · SwiftUI · Observation framework
- STTextView (code editor) · SwiftTreeSitter (syntax highlighting)
- URLSession (loopback HTTP to sidecar)

**Web sidecar**
- Next.js 16 · TypeScript · Tailwind 4 · shadcn/ui
- `@anthropic-ai/claude-agent-sdk`
- pnpm workspaces · Turbo
- In-process MCP servers: `marvin-graph` + `marvin-playwright` (`@playwright/mcp`)

---

## Status

**v1.3 — Fully native IDE surface (shipped 2026-05-05).**

The WebView is gone. The macOS app is a pure SwiftUI IDE shell backed by the
Next.js sidecar over loopback. Full feature parity with the web-era UI plus
IDE features the browser couldn't provide:

- **WebView removed** — all UI surfaces are native Swift; no Tauri, no WKWebView
- **Syntax highlighting** — tree-sitter grammars for Swift, TS/TSX, JS/JSX, Go, Rust
- **Image preview** — binary image files (PNG, JPEG, GIF, WebP, HEIC) open inline
- **Image paste** — ⌘V in chat accepts screenshots and dragged images
- **Find in files** — ripgrep-backed with glob filter and replace-all
- **Push / pull / fetch** — full remote ops in the source control panel
- **Session history** — clock menu in chat header restores any past session
- **Right-pane resize** — min-width fixed so brain + chat never overlap other panes
- **App renamed** — `MARVIN-Swift.app` → `MARVIN.app`
- **Install & uninstall** — `bin/marvin install-macos-app` / `uninstall-macos-app` + remote one-liner

See [`docs/roadmap.md`](./docs/roadmap.md) and [`docs/history/CHANGELOG.md`](./docs/history/CHANGELOG.md).

---

## Troubleshooting

**First diagnostic — always:**

```bash
curl -s http://localhost:3030/api/health | jq .
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `auth.mode: "none"` | No credentials detected | `ANTHROPIC_API_KEY` in env, or `claude auth login` |
| `binaryError` in `/api/health` | Claude CLI not on PATH | `npm install -g @anthropic-ai/claude-code` or set `MARVIN_CLAUDE_BIN` |
| Every turn → `400 Consumer Terms` | Anthropic account hasn't accepted latest Terms | Open [claude.ai](https://claude.ai) with the same email, accept banner |
| `EADDRINUSE :::3030` | Another instance running | `lsof -iTCP:3030 -sTCP:LISTEN` → kill it |
| MARVIN.app won't open | Gatekeeper ad-hoc signing warning | Right-click → Open, or System Settings → Privacy & Security → Open Anyway |
| Graph pane → "no graph found" | graphify not run on the project | `cd <workDir> && /graphify .` |
| Sidecar not starting on login | launchd agent not loaded | `launchctl load ~/Library/LaunchAgents/net.marvin.desktop.server.plist` |
| Build fails: `No module 'STTextView'` | SPM not resolved | `cd apps/macos && swift package resolve` |
| Models dropdown → "fallback list" | Node can't read macOS Keychain token | Set `ANTHROPIC_API_KEY` directly |
| Chat sessions not loading | First launch post-install | Open the sessions menu (clock icon) and click a session |

**Lifecycle helpers:**

```bash
bin/marvin status   # auth + model + data dir
bin/marvin doctor   # preflight checks
bin/marvin logs     # tail .marvin/dev.log
```

**Still stuck?** Open an issue at [github.com/RobertIlisei/MARVIN/issues](https://github.com/RobertIlisei/MARVIN/issues) with `/api/health` output, the last 20 lines of `~/.marvin-app/.marvin/launchd-stderr.log`, and your macOS version.

---

## Documentation

- [Overview](./docs/getting-started/overview.md) — what MARVIN is, who it's for
- [Quickstart](./docs/getting-started/quickstart.md) — install → first session
- [Architecture](./docs/getting-started/architecture.md)
- [HTTP API reference](./docs/reference/api.md)
- [ADRs](./docs/decisions/) — design decisions

---

## License

[MIT](./LICENSE) · © 2026 Robert Ilisei

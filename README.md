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
| **macOS app** | `macos/` | Native SwiftUI app — IDE shell, chat, file tree, source control, terminal, diff viewer |
| **Sidecar** | `sidecar/` | Next.js 16 server on `:3030` — Claude Agent SDK runner, tool policy, git API, file API, session storage |

The Swift app talks to the sidecar over `localhost:3030`. In a brew install the sidecar is bundled inside `MARVIN.app/Contents/Resources/` (alongside a pinned Node 22 runtime) and spawned by the SwiftUI process on launch; quitting MARVIN cleans it up. See [ADR-0023](./docs/decisions/0023-brew-distributable-bundled-sidecar.md).

---

## Install

> **Two tracks** — `main` is **stable** (last release: v0.1.13). `development`
> is where multi-graph + future-shaped changes (ADR-0028 onward) land first.
> Brew always installs the stable cask; to try the development branch, clone
> + build from source against `git checkout development`. Switch back to
> stable at any time with `brew install --cask marvin-ai` or `git checkout main`.

### Recommended — Homebrew (no toolchain required, stable track)

```bash
brew tap RobertIlisei/marvin
brew install --cask marvin-ai
```

That's it. MARVIN.app appears in `~/Applications`, the bundled sidecar starts with the app, quitting MARVIN cleans it up. No Swift, Node, pnpm, Xcode, or Apple Developer account required on your machine.

> **First launch — one-time Gatekeeper step (macOS 26+).** MARVIN is ad-hoc signed (no paid Apple Developer Programme membership). On first double-click macOS shows "Apple could not verify…": click **Done**, then open **System Settings → Privacy & Security**, scroll to the **Security** section, find "MARVIN.app was blocked from use…", and click **Open Anyway**. This whitelist persists for the life of the install — you only do it once. ([ADR-0027](./docs/decisions/0027-macos-26-gatekeeper-user-applications.md) has the technical detail.)

**You'll need Anthropic credentials** to use it — either run `claude login` (the Claude CLI handles it) or paste an API key in MARVIN → Settings → Authentication.

**Updates:** `brew upgrade --cask marvin-ai`. **Uninstall:** `brew uninstall --cask marvin-ai` (add `--zap` to also wipe `~/.marvin`).

> Note: the cask token is `marvin-ai`, not `marvin` — the plain token is taken by the unrelated "Amazing Marvin" productivity app in the official homebrew-cask repo.

### From source (developer install)

If you've cloned the repo and want to build locally:

```bash
bin/marvin install-macos-app   # build → ~/Applications/MARVIN.app
bin/marvin uninstall-macos-app # remove app (both ~/Applications and legacy /Applications)
```

Default install mode is **bundled** (per ADR-0023) — same shape as the brew artefact. Pass `--launchd` for the legacy mode that runs the sidecar from the source repo via a user-agent plist.

Requires `xcodegen` + Xcode, **or** just the Swift Command Line Tools (`xcode-select --install`). If `xcodegen` is missing, `swift build` is used automatically as a fallback — no Developer account needed in either path.

### Tracking the development branch

The `development` branch carries multi-graph + features in progress for the next release ([ADR-0028](./docs/decisions/0028-multi-graph-architecture.md)). Use it if you want the latest; fall back to stable any time.

```bash
git clone https://github.com/RobertIlisei/MARVIN.git ~/marvin
cd ~/marvin
git checkout development
bin/marvin install-macos-app
```

**Rollback to stable:**

```bash
git checkout main
bin/marvin install-macos-app   # rebuilds + reinstalls the stable bundle
# or, if you want the signed brew artefact:
brew install --cask marvin-ai
```

`graphify-out/knowledge/` is gitignored and harmless to leave behind on rollback — the stable branch ignores it.

---

## Prerequisites

### macOS app (`macos/`)

| Requirement | How to get it |
|---|---|
| macOS 14+ | System update |
| Xcode ≥ 15 **or** Swift CLT | `xcode-select --install` |
| xcodegen *(optional, preferred)* | `brew install xcodegen` |

### Sidecar (`sidecar/`)

| Requirement | How to get it |
|---|---|
| Node.js **≥ 22** | [nodejs.org](https://nodejs.org) or `brew install node@22` |
| pnpm | `npm install -g pnpm` |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| Claude credentials | `claude auth login` — or set `ANTHROPIC_API_KEY` in env |

**Optional:**

- `npx playwright install chromium` — needed for browser automation (MARVIN shells out to `npx playwright` when a turn needs a browser)
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
cd macos
xcodegen generate               # regenerate MARVIN.xcodeproj from project.yml
open MARVIN.xcodeproj           # then build + run in Xcode
```

Or with swift build (Command Line Tools only, no Xcode IDE):

```bash
cd macos
swift build -c release
# The install script assembles the .app bundle from the SPM output automatically.
bin/marvin install-macos-app    # build + install + launchd
```

### Dev loop (sidecar + app together)

```bash
# Terminal 1 — sidecar in the foreground
bin/marvin start

# Terminal 2 — open the built app
open ~/Applications/MARVIN.app
# or for a faster edit-rebuild-run loop while working on the Swift side:
cd macos && xcodebuild -scheme MARVIN -configuration Debug build && open build/...
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
- ✅ Agent change review — Cursor-style: a live "N files changed" strip while MARVIN edits, then per-hunk accept/reject against pre-agent baselines (rejecting restores *your* uncommitted state, not git HEAD — ADR-0034)
- 🎚️ Per-role reasoning effort — independent Low→Max effort pickers for the executor and the advisor (ADR-0033)

**Web sidecar**
- 🔒 Structural confirm gate — every Edit/Write/Bash pre-flight, auto-mode audit log
- ⏰ Self-scheduled wakeups — MARVIN's "I'll check back in 10 minutes" is real: the `schedule_wakeup` tool arms a bounded server-side timer that starts an actual follow-up turn (ADR-0031); background-and-forget Bash is gate-denied so a build can't finish unreported (ADR-0032)
- 💸 Cost tracker — daily/weekly/lifetime spend per project
- 🔀 Monaco diff viewer — see exactly what MARVIN is about to do before allowing
- 🧰 Model picker — executor + advisor slots, live model list from Anthropic
- 🌐 Playwright via Bash — MARVIN drives real browsers against `localhost` / LAN URLs by shelling out to `npx playwright`
- 🔄 Resume across reloads — closing the window doesn't kill a running turn
- 📊 Graph-aware chat — in-process MCP exposes `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`

---

## Repo layout

```
macos/                         # SwiftUI macOS app (Xcode / SPM)
  MARVIN/                      # Swift sources
  project.yml                  # xcodegen manifest
  Package.swift                # SPM manifest (swift build fallback)
sidecar/                       # Next.js 16 sidecar, port 3030
  src/
    app/api/                   # REST endpoints (chat, git, files, sessions, health)
  packages/
    runtime/                   # Agent SDK runner, auth, session, cost, models, confirm gate
    tools/                     # Tool policy — auto / confirm / deny
    project-context/           # Spec + ADR + memory + graph-header injection
    graphify-bridge/           # Knowledge-graph read + in-process MCP server
    git-watch/                 # Per-workDir commit stream watcher
    ui/                        # shadcn primitives
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
- In-process MCP server: `marvin-graph` (browser automation is via `npx playwright` shell-out, not an MCP)

---

## Status

**v0.1.19 — Agent reliability + change review (current).**

- **Agent change review** — the permission gate snapshots every file's pre-image on first agent touch per session; a live "N files changed" strip opens a review sheet with per-hunk accept/reject. Accept advances the baseline, reject reverse-applies to disk — never `git discard`, which would destroy uncommitted user work. v1 blind spot: Bash-driven mutations aren't pre-imaged. ADR-0034.
- **Per-role reasoning effort** — the advisor is a registered agent definition carrying its own model + effort, settable independently of the executor (the SDK's `advisorModel` option turned out to be unwired; the agents-map registration is what actually works). ADR-0033.
- **Self-scheduled wakeups** — `schedule_wakeup` / `cancel_wakeup` / `list_wakeups` MCP tools backed by a bounded, persistent, boot-re-armed scheduler; a fired wakeup starts a real turn that resumes the session. Bash `run_in_background` is gate-denied (the runtime can't deliver completion notifications, so the capability shouldn't exist). ADRs 0031, 0032.
- **The bundled app owns its port** — launch reclaims `:3030` from any stale sidecar before spawning, and `/api/health` reports the serving process's app version, so "new app on disk, old code in memory" can't recur. ADR-0035.

**v0.1.6 — Brew-installable, project-aware.**

- **Brew cask** — `brew install --cask marvin-ai` produces a working IDE on a fresh Mac with no Swift / Node / pnpm / Xcode required. Bundled Node 22 + Next.js standalone sidecar inside `MARVIN.app/Contents/Resources/` (ADR-0023).
- **Project-aware skill recommendations** — fingerprint detector emits namespaced tags (`framework:next`, `architecture:multi-tenant`, `test:playwright`, …) from a project's manifests + memory file; the suggestion engine maps tags to skills you can either install user-global or build project-local. ADR-0024.
- **Skills pane** — fourth tab in the left pane (Files / Search / Source Control / Skills): suggestions for the current project, your user-global skill catalog, and project-local skills. One-click "park all" closes the audit loop. ADR-0025.

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
| Sidecar didn't spawn with the app | Bundled sidecar crashed | Tail `~/Library/Logs/MARVIN/sidecar.log` for the cause; relaunch MARVIN |
| Build fails: `No module 'STTextView'` | SPM not resolved | `cd macos && swift package resolve` |
| Models dropdown → "fallback list" | Node can't read macOS Keychain token | Set `ANTHROPIC_API_KEY` directly |
| Chat sessions not loading | First launch post-install | Open the sessions menu (clock icon) and click a session |

**Lifecycle helpers:**

```bash
bin/marvin status   # auth + model + data dir
bin/marvin doctor   # preflight checks
bin/marvin logs     # tail .marvin/dev.log
```

**Still stuck?** Open an issue at [github.com/RobertIlisei/MARVIN/issues](https://github.com/RobertIlisei/MARVIN/issues) with `/api/health` output, the last 20 lines of `~/Library/Logs/MARVIN/sidecar.log`, and your macOS version.

---

## Documentation

- [Overview](./docs/getting-started/overview.md) — what MARVIN is, who it's for
- [Quickstart](./docs/getting-started/quickstart.md) — install → first session
- [Architecture](./docs/getting-started/architecture.md)
- [HTTP API reference](./docs/reference/api.md)
- [ADRs](./docs/decisions/) — design decisions

---

## Release signing

Every release zip published since v0.1.x is signed with [minisign](https://jedisct1.github.io/minisign/). The signature lives next to the zip on each GitHub Release as `MARVIN-<version>-arm64.zip.minisig`.

**Public key** (pinned here, in the [`homebrew-marvin`](https://github.com/RobertIlisei/homebrew-marvin#release-signing) tap's README, and in [`Casks/marvin-ai.rb`](https://github.com/RobertIlisei/homebrew-marvin/blob/main/Casks/marvin-ai.rb)):

<!-- Canonical machine-readable copy: .minisign-pubkey (repo root). -->
<!-- This pubkey + the matching private key were generated 2026-05-20 -->
<!-- per ADR-0026 §"Key generation". Rotation cadence: 2 years OR -->
<!-- immediately on suspected secret-store breach. -->

```
untrusted comment: minisign public key 0794CFDFA5E629D5
RWTVKeal38+UBwQ3tC8ETdPZkv8fFLchoXdtwi7UI9XMhaJWuUwx4QAQ
```

The same key is mirrored in [`.minisign-pubkey`](./.minisign-pubkey), in the [`homebrew-marvin`](https://github.com/RobertIlisei/homebrew-marvin#release-signing) tap's README, and in [`Casks/marvin-ai.rb`](https://github.com/RobertIlisei/homebrew-marvin/blob/main/Casks/marvin-ai.rb) as the `MARVIN_MINISIGN_PUBKEY` constant. Three pinned copies across two repos — a tap-repo compromise that swapped the cask's pubkey would be visibly inconsistent with this repo's record.

**Verify a downloaded release:**

```bash
brew install minisign
VERSION=0.1.9   # whichever version you downloaded
curl -fLO "https://github.com/RobertIlisei/MARVIN/releases/download/v${VERSION}/MARVIN-${VERSION}-arm64.zip"
curl -fLO "https://github.com/RobertIlisei/MARVIN/releases/download/v${VERSION}/MARVIN-${VERSION}-arm64.zip.minisig"
curl -fLO https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/.minisign-pubkey
minisign -V -p .minisign-pubkey -m "MARVIN-${VERSION}-arm64.zip"
```

A successful verify prints `Signature and comment signature verified` and exits 0. If the signature doesn't verify, **do not install the artefact** — and please open an issue, because either:

- the tap repo or the release was tampered with, or
- our private key was lost (in which case we'll publish a rotation announcement, also signed)

See [ADR-0026](./docs/decisions/0026-release-artefact-signing-minisign.md) for the full signing model, the threat shapes this defends against, and the key-rotation policy.

The cask install path (`brew install --cask marvin-ai`) does not yet auto-verify the signature — Phase 2 of ADR-0026 will add a `preflight` step. Until then, manual verification is the canonical path for users who care.

---

## License

[MIT](./LICENSE) · © 2026 Robert Ilisei

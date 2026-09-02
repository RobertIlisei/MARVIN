# MARVIN

**M**oderately **A**dvanced **R**obotic **V**irtual **I**ntelligence **N**etwork.

A pair-programming AI assistant. You drive vision and business decisions. MARVIN
drives architecture, infrastructure, code, tests, docs, and security.

You say *"let's build the login page"* — MARVIN dives in: reads the codebase,
proposes the schema + wiring + tests, executes with explicit confirms, commits.

> "Here I am, brain the size of a planet, and they ask me to build a login page."
> — MARVIN, probably

---

## 📄 The white paper

> **[One assistant, enforced discipline — a design for AI pair-programming that survives real projects](./docs/whitepaper/WHITEPAPER.md)**
>
> Why AI coding assistance decays on real projects, and the four bets MARVIN
> makes against the current grain:
>
> 1. **One assistant with enforced phases** — not an agent team; subagents are structurally unable to write
> 2. **The knowledge graph before the file read** — structural answers at ~1/27th the token cost (measured on this repo), with `file:line` citations
> 3. **Deterministic contracts at the tool gate** — enforced, not politely requested in the prompt
> 4. **Local-first, no backend** — inference straight to Anthropic; credentials never leave your machine
>
> With measured results (first-message context: 566K → ~13.4K tokens), five
> architecture diagrams, and anonymized transcripts from real production
> sessions. The exhaustive companion — every subsystem down to the code — is
> the [Technical Reference](./docs/whitepaper/TECHNICAL-REFERENCE.md).
> Both are also available as PDFs:
> [white paper](./docs/whitepaper/WHITEPAPER.pdf) ·
> [technical reference](./docs/whitepaper/TECHNICAL-REFERENCE.pdf).

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

> **Releases.** Homebrew installs the latest tagged release (currently
> **v0.1.102**). `main` and `development` are fast-forwarded together at each
> release; `development` is where in-progress changes land between them. To
> build from source on either branch, `git checkout <branch>` then
> `bin/marvin install-macos-app`.

### Recommended — Homebrew (no toolchain required)

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

### Building from a branch

`main` and `development` track together at each release; `development` carries any work in progress between releases ([ADR-0028](./docs/decisions/0028-multi-graph-architecture.md) multi-graph landed this way). Build either from source:

```bash
git clone https://github.com/RobertIlisei/MARVIN.git ~/marvin
cd ~/marvin
git checkout development   # or: main
bin/marvin install-macos-app
```

**Back to the signed release artefact** at any time:

```bash
brew install --cask marvin-ai
```

`graphify-out/knowledge/` is gitignored and harmless to leave behind when switching branches.

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
bash scripts/install-skills.sh  # once — installs skills to ~/.claude/skills/ (clones upstream on demand)

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
  project, not in MARVIN's own data dir — and the running IDE only ever reads
  or builds the *active project's* graph, never its own source.
- **Built on a knowledge graph it maintains for you.** Queries
  [graphify](https://github.com/safishamsi/graphify) first on
  architecture/impact questions (**27.5× cheaper** than reading raw files —
  measured with `graphify benchmark`, 2026-08-15), and
  builds/refreshes the active project's code + knowledge graphs itself
  (AST-only, free) so they're always current (ADR-0041).
- **Memory is durable facts, not a log.** `.marvin/memory.md` is a curated,
  one-line-per-fact index written only through the `remember` tool — invariants
  and gotchas the next session can't re-derive from ADRs, git, or the changelog
  (ADR-0042).

---

## Features

**macOS app**
- 🍎 Native SwiftUI IDE shell — 3-pane layout (file tree · chat · brain/graph)
- 📁 File tree with icons, click-to-open, context menu (create / rename / delete / move)
- 🗒️ Syntax-highlighted file viewer (Swift, TS, JS, Go, Rust, JSON, YAML, Markdown, images)
- 🔎 Find in file — ⌘F / ⌘G / ⇧⌘G / ⌘E in the editor, plus a header button
- 🌿 Source control — stage/unstage, commit, push, pull, fetch, diff viewer, branch line
- 🔍 Project-wide search — ripgrep-backed, include glob filter, replace all
- 🔣 Symbol search and file history
- 🏗️ Build task panel — run build tasks, see diagnostics inline
- 🧩 Problems panel — diagnostics from a bounded, ignore-aware sweep of the whole tree (tsc · eslint flat + legacy · biome · ruff · go vet · cargo · swift build · maven), project-local wrappers preferred, fast checks automatic and minute-scale builds on demand. Grouped by file, severity chips that filter, rows jump to `file:line:col`, and three distinct empty states — never-run, no-toolchain-found, genuinely-clean
- 🔌 Language server client — diagnostics from the **buffer**, not from disk, so the list describes the file as it is now rather than as it was last saved (ADR-0099). Full-text sync, a three-strike crash budget, and a missing server surfaced *as a diagnostic* rather than as silence
- ⌨️ Command registry — the menu bar, the **⇧⌘P command palette** and the ⌘/ shortcut sheet are three renderings of one array, so a binding cannot drift between them. Save All · Revert · New Text File · Auto Save · Word Wrap · Toggle Line/Block Comment · Move/Copy/Duplicate Line · Expand/Shrink Selection · Go to Bracket · Go to Line · Next/Previous Problem · Next/Previous Change · Back/Forward · Run Active File
- 🧭 Outline · Timeline · Tasks — the sidebar sections VS Code has, built language-agnostically: the outline reads the **knowledge graph** rather than tree-sitter (which covers 12 languages and would silently do nothing in the rest), and Tasks is a generic runner rather than the reference's Java-only Maven panel
- 🛑 Stop Session & All Work (⇧⌘.) — Stop cancels the turn; this cancels the turn **plus** the background jobs and scheduled wakeups it leaves behind, which otherwise outlive it and can start a new turn on their own. Confirmation names the scope by count, and the whole thing is scoped to one session
- ⌨️ Embedded terminal (PTY-backed)
- 🕐 Session history — click any past session in the header to restore it
- 🧠 MARVIN brain — live animated state indicator (idle / thinking / tool / writing / error)
- 📎 Image paste in chat (⌘V, screenshots, dragged images)
- 🌓 Light / dark theme — respects system preference
- ✅ Agent change review — VS Code / Cursor-style: a live "N files changed" strip while MARVIN edits opens its own resizable window with a side-by-side (original │ modified) diff, line numbers, and a Split/Inline toggle. Per-hunk / per-file accept-reject against pre-agent baselines (rejecting restores *your* uncommitted state, not git HEAD); committing a change clears it from the review the way it leaves VS Code's Source Control list (ADR-0034)
- 🎚️ Per-role reasoning effort — independent Low→Max effort pickers for the executor and the advisor (ADR-0033)
- 🧭 Ask · Agent · Plan modes — read-only Ask (enforced at the gate), full-autonomy Agent, and plan-first Plan that drafts a plan + live to-do checklist and waits for your approval before executing (ADR-0036). Cursor-style controls live in the input box; chat tabs open/close and persist per project
- 🗂️ Two-tier to-do / plan — a neutral **Task list** for bare `TodoWrite` runs vs a purple **Plan — <title>** that persists, ticks off in place, and saves to `.marvin/plans/<slug>.md` opened in the editor ("Open plan"); a completed plan collapses instead of re-prompting to approve (ADR-0036 two-tier addendum). The executor tags each `TodoWrite` item `[N]` (plan step) / `[N.M]` (sub-task) so tasks link to the right step by a stable key, sub-tasks roll up to complete their parent (a step is done only when all of its are), and the **active plan + live status is re-injected into the model's context every turn** — so MARVIN never loses the plan across a chat switch or context compaction (ADR-0049 · ADR-0050 · ADR-0051)
- ❓ Clickable decisions — when the model hits a real fork it calls **AskUserQuestion** and you pick from native option buttons (single/multi-select + "Other"); your choice returns to the model as the tool result, in every mode (ADR-0040)
- 🧩 Per-project skill enablement — the fingerprint picks the installed skills relevant to *this* project and tells MARVIN to ignore the rest; per-skill toggles in the Skills pane (ADR-0037)
- ⬇️ Fetch skills from Git — "Add from GitHub" pulls a skill from any repo, a `…/tree/…` sub-path, or a plugin marketplace (ADR-0039); clone-and-copy only, never executes the repo
- 🛰️ Event-based background jobs — `run_background_job` runs a build/test/deploy past the turn and fires a real follow-up turn when it exits (no more orphaned "I'll be notified" promises); shell `&`/`nohup` denied at the gate (ADR-0038). The completion turn now renders in an **idle** session without a switch/relaunch — a per-project announce channel re-attaches the app to any server-initiated turn (ADR-0043), with a "background job running" chip so in-flight is distinct from done
- 📋 Project backlog — a durable parking lot for the "noticed in flight, not in scope" follow-ups that used to evaporate with the chat: `backlog_add` parks them (consent-gated at the scope-met handoff), they resurface in next session's context, and a macOS panel + tray chip lets you browse / Done / Dismiss / **Promote to plan**. A parking lot the user revisits — never a queue agents pull from (ADR-0044)
- 🧹 Backlog review (`/groom` · **Review** button · View ▸ Backlog ⌘⇧B) — a backlog that only grows stops being read, so MARVIN reviews it: near-duplicates the exact-title dedup can't see, auto-captures nobody ever triaged, items untouched for weeks, references to files that no longer exist, HIGH items left sitting. **Read-only by construction** — it reports, you decide; the report carries that instruction *with the data*, not just in the prompt. Findings render as badges on the rows they concern (ADR-0063)
- 🏷️ Backlog classification — `kind` (bug · feature · investigate · test · docs · chore) alongside severity, plus **`blocked`/`blockedOn` as its own axis** — a blocked bug and a blocked feature are both blocked, and an item waiting on an accountant shouldn't look pickable. Both change what the groomer nags about: a bug ages at a lower bar, while `investigate` and `blocked` items are never called stale. No backfill — existing items stay `unspecified` rather than take a guessed label (ADR-0064)

**Web sidecar**
- 🔒 Structural confirm gate — every Edit/Write/Bash pre-flight, auto-mode audit log
- ⏰ Self-scheduled wakeups — MARVIN's "I'll check back in 10 minutes" is real: the `schedule_wakeup` tool arms a bounded server-side timer that starts an actual follow-up turn (ADR-0031); background-and-forget Bash is gate-denied so a build can't finish unreported (ADR-0032)
- 💸 Cost tracker — daily/weekly/lifetime spend per project
- 🔀 Monaco diff viewer — see exactly what MARVIN is about to do before allowing
- 🧰 Model picker — executor + advisor slots, live model list from Anthropic
- 🌐 Browser automation — by default MARVIN drives real browsers against `localhost` / LAN URLs by shelling out to `npx playwright` (one-shot captures + full `playwright test`). Opt-in, **off by default**: a gated Playwright **MCP** server (ADR-0045) for first-class, stateful `browser_*` tools (navigate → snapshot → click → assert) — observation auto-runs, interaction/navigation confirm, and `browser_run_code_unsafe` is denied
- 🔄 Resume across reloads — closing the window doesn't kill a running turn
- 📊 Graph-aware chat — in-process MCP exposes `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`; MARVIN builds + refreshes the active project's code and knowledge graphs itself (AST-only, free) so they stay current (ADR-0041)
- 🧠 Durable-facts memory — a `marvin-memory` MCP (`remember` / `recall`) is the enforced write path for `.marvin/memory.md`: one fact per file + a one-line index, with caps + content-class guards so it can't bloat into a redundant log; `/memory-compact` distills an existing one (ADR-0042)

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
  install-skills.sh          # Install skills to ~/.claude/skills/ (clones upstream on demand)
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
- `@anthropic-ai/claude-agent-sdk` 0.3 — with `TodoWrite` opted back in and in-process MCP servers `alwaysLoad` ([ADR-0073](./docs/decisions/0073-agent-sdk-0-3-upgrade.md))
- pnpm workspaces · Turbo
- In-process MCP server: `marvin-graph` (browser automation is via `npx playwright` shell-out, not an MCP)

---

## Status

**v0.1.87–0.1.98 — IDE parity, and four bugs that only measurement found.** Two halves. The first is parity with the reference IDE (Antigravity, a VS Code fork), audited item by item into a [parity matrix](./docs/reference/ide-parity.md): a **language-server client** ([ADR-0099](./docs/decisions/0099-lsp-client-for-live-diagnostics.md)) so diagnostics come from the buffer rather than from disk — verified against a real `sourcekit-lsp`, which reported a type error on an **unsaved** edit while the file on disk still said otherwise, the exact capability a CLI runner cannot have; a **command registry** making the menus, the ⇧⌘P palette and the ⌘/ sheet three renderings of one array (it immediately surfaced two double-bound keys); **source control** reaching the reference's feature set, including four routes that had shipped with *zero* callers — the branch name was a `Text`, so the feature was complete, tested, documented and unreachable; a **Problems panel** that searches the whole tree rather than the repo root, where "found nothing" had been rendering as "your code is clean"; and a tranche of self-contained editor commands. The second half is a lesson worth more than the features: **four bugs in a row were diagnosed wrongly from reading source, and settled immediately once something was measured.** A file tree drawing over the title bar took three wrong guesses about ScrollView ideal heights before a geometry probe said *container at y=52, tree at y=0* — not too tall, 52pt too high, exactly the title bar, because `VSplitView` does not inherit the safe area. An app frozen at 100 % CPU with two sessions open was a width latch with **no deadband**: collapsing changed the measured width, and one threshold in both directions let it cross back, each cycle re-forming the split view's panes. A Stop-All button was permanently disabled because it gated on a property nothing had set since the WebView was removed. And two sessions that looked "interconnected" had genuinely separate conversations — distinct SDK session ids per transcript — but collided on the **working tree**, which Golden Rule 1 forbids and nothing enforces. Also shipped: `CLAUDE.md` is finally injected into project context (it never had been), chat prose is selectable across lines, and `Stop Session & All Work` cancels the jobs and wakeups a turn leaves behind.

**v0.1.77–0.1.86 — a day of failures that looked like nothing happening.** Ten releases, one recurring shape. **[ADR-0097](./docs/decisions/0097-verify-against-what-runs.md) — verify against what runs.** The Claude-plan usage bars survived two previous fixes because the SDK never resolves `claude` from `PATH`: it spawns the native binary its own package links to, and the bundler picked that with `find | head -n1`, linking **0.2.113** beside a 0.3.251 SDK. Every turn ran a CLI 138 versions behind while the About panel confirmed the right one. The same pass found `Skill` had been called **29 times across every transcript ever recorded, failing every time, with zero successes** — the pane listed skills the loader had skipped, because `description:` is the load-bearing frontmatter key and the registered identity is always the directory. **[ADR-0098](./docs/decisions/0098-the-rail-must-outlive-the-tool-surface.md) — a rail keyed on vendor tool names is only as durable as those names.** That upgrade removed `Grep`/`Glob`; all four graphify-first guards keyed on them with no `Bash` branch, so searching moved where the rail is blind — **15 of 18 Bash calls search-shaped against 2 graph calls**. **And a run of silent failures:** a `ScrollView` under a frame with no `idealHeight` measured the whole transcript (eight 61-second hangs); the bottom panel mounted tabs only on an `activeTab` *change*, so opening it on the selected tab gave an empty pane with no shell; extended thinking rendered as `unhandled block: thinking`; `_ = try await URLSession.data(for:)` treated an HTTP 500 as success, so Discover ran two minutes and showed nothing; `which("tsc")` under a Finder-launched app's bare `PATH` returned `[]`, rendered as "No problems detected"; and the terminal broke on project switch — sessions keyed by `workDir`, SwiftUI keeping the representable's identity, `updateNSView` swapping the session but not the view. Skills work on OpenRouter (`tools: []`, and the proxy answers `count_tokens` with an estimate rather than a fabricated zero).

**v0.1.65 — the SDK catches up, and two things that only *looked* broken.** Agent SDK **0.2.113 → 0.3.245** ([ADR-0073](./docs/decisions/0073-agent-sdk-0-3-upgrade.md)) — MARVIN was behind the end of its own 0.2 line, on a version predating `TodoWrite`'s deprecation. Every 0.3 default that would change behaviour is pinned back with its reason: `TodoWrite` opted in over the Task tools so the plan spine keeps receiving snapshots; all five in-process MCP servers `alwaysLoad`, because 0.3 defers MCP tools behind `ToolSearch` and the graphify-first hooks would deadlock a turn with no `graph_*` tools. Verified live on Sonnet 5. **"I lost all my sessions"** ([ADR-0072](./docs/decisions/0072-session-list-must-not-parse-transcripts.md)) — nothing was lost: the session list `JSON.parse`d 2.6 GB per request (23 s), the client cancelled and restarted it on every layout rebuild, and hydration waited on it. Scan + cache: 36 ms; hydration no longer depends on the list. **"MARVIN is skipping plan steps"** ([ADR-0068](./docs/decisions/0068-plan-dedupe-provenance-and-negative-claims.md) add. 4) — a 10-step plan was tracked as 16 because its `Sources:` bibliography parsed as steps and one URL was `in_progress`; the parser now stops at a reference heading. Skills and plugins can be **updated**, not just installed ([ADR-0071](./docs/decisions/0071-install-provenance-and-update-path.md)); pane actions moved out of the window toolbar, with tooltips.

**v0.1.56–0.1.64 — stability, backlog review, and find-in-file.** Four app-killing crashes traced and fixed. The **file tree** was retired off SwiftUI's `OutlineGroup` entirely ([ADR-0061](./docs/decisions/0061-file-tree-flat-list-not-outlinegroup.md)): four separate fixes each closed one way for its outline coordinator to disagree with AppKit, and the fourth crash was *caused* by the third — so the tree now flattens to a plain row list and the whole failure class is structurally gone. A second crash resisted two fixes aimed at a mechanism inferred from the stack alone, so MARVIN now **captures the exception itself** ([ADR-0062](./docs/decisions/0062-update-constraints-loop-identified-mitigated.md)) — name, reason and symbols to `~/Library/Logs/MARVIN/exceptions.log` — which identified it on the first occurrence as AppKit's non-converging-layout breaker, now survived rather than fatal. The **check-back guard** stopped swallowing timed promises ([ADR-0055](./docs/decisions/0055-checkback-promise-auto-arm-guard.md) addendum): a background dev server counted as follow-through for "I'll check in ~2.5 minutes", though it never exits and so never reports. **Backlog review** ([ADR-0063](./docs/decisions/0063-backlog-groomer-review-not-execute.md)) and **classification** ([ADR-0064](./docs/decisions/0064-backlog-kind-and-blocked.md)) landed read-only: the groomer reports, you decide. **Find in file** returned (⌘F), and `bin/marvin doctor` stopped telling you to kill your own running app.

**v0.1.55 — verify-then-remediate contract: bounded self-fix, gated scope-fix.** MARVIN's Phase 6/7 loop had a "verify, then what?" gap — it walked the Definition of Done but had no explicit contract for what to do when a check failed. Now split by failure class. **Phase 6 (mechanical):** typecheck / test / build failures MUST self-remediate without asking — capped at 3 attempts per milestone with an early **no-progress stop** (identical errors twice = spinning → stop), then an honest failure report; MUST NOT claim landed, weaken the DoD, or skip the failing check. **Phase 7 (scope):** an unmet DoD bullet gets **surface-and-offer** — state the gap plus the one concrete next step, then gate ("one gap, one gate"); MUST NOT loop back into Phase 6 unprompted. A fully autonomous retry-until-DoD mode was deliberately *not* built — it institutionalizes the Golden-Rule-8 "helpful spiral"; revisit only as an explicit opt-in with its own ADR, cost budget, and progress metric. Prompt-only change in `personality.ts`; also fixed 9 pre-existing typecheck errors in `can-use-tool-dispatch.test.ts` (readonly-array fixture vs the SDK's mutable `PermissionUpdate[]`).

**v0.1.54 — the IDE no longer resets on a transient health blip.** The window "kept resetting" mid-work — pane layout, file-tree expansion, terminal, editor, chat scroll all snapping to default. `ContentView.mainContent` switches its whole view tree on `health.state`, and `HealthMonitor.pollOnce` flipped to `.offline` on any single failed `/api/health` poll (3 s timeout, no hysteresis) — a healthy-but-busy sidecar answering slowly tore down and rebuilt the entire IDE. Fix: demote to `.offline` only after **3 consecutive** misses (hold `.online`/`.connecting` through blips), poll fast while misses are pending so a genuine outage still surfaces in seconds, and bump the poll timeout to 5 s.

**v0.1.53 — backlog "Promote to plan" actually plans.** Promoting a backlog item did nothing: `promoteBacklog` sent "Implement this item…" in whatever mode was active and never switched to Plan mode — but the turn-completed ingest only mints a tier-2 Plan + approval chip when `mode == "plan"` — and if a turn was in flight `sendControl`'s `!isSending` guard silently dropped it while the panel closed anyway. Now it switches to Plan mode and asks MARVIN to present a plan inline (read-only first), and queues the request when busy instead of dropping it.

**v0.1.52 — file-tree crash fixed.** The app trapped (`EXC_BREAKPOINT` in `OutlineListCoordinator.recursivelyDiffRows`) during a file-tree row diff: `FileNode.outlineChildren` returned a non-nil empty array `[]` for empty directories, but SwiftUI's `OutlineGroup` expects `nil` (leaf) or a non-empty array — an agent mutating files mid-session flipped a node into the `[]` shape and the next diff crashed. Empty dirs now return `nil` (leaf). A companion build fix: the install smoke-probe now reaps the forked `next-server` worker (it bound the probe port and survived the parent kill) so installs stop leaking orphan sidecars.

**v0.1.51 — plan-in-context: the model is aware of the active plan every turn.** The plan was UI-only state — a strip rehydrated from the transcript, never injected into the model's prompt — so after a chat switch or context compaction the model lost the plan while the strip still showed it ("MARVIN stopped tracking / won't continue it"). The client now sends a compact `planContext` snapshot (title + `[x]/[~]/[ ]` steps + sub-tasks, marked authoritative) every turn, and the runtime appends it as a `<system-reminder>` **suffix on the user message** — the uncached volatile tail, so it's prompt-cache-safe (Anthropic's caching rules) and never persisted to `turn.user`. Mirrors how Claude Code re-injects its todo list. ADR-0051.

**v0.1.49–0.1.50 — plan integrity.** A Plan-mode turn that hit a transient **529 Overloaded** got its error text ingested as a plan (no `# Plan` heading → fallback title "Plan" → `plan.md`), hijacking the active plan; the turn-completed ingest is now gated on `PlanCard.isPlan` (0.1.49). And a step could read "done" while all its sub-tasks were still open — completion is now a hard invariant: a step with sub-tasks completes **iff every sub-task is completed** (0.1.50). ADR-0046 / ADR-0049 addenda.

**v0.1.44–0.1.45 — plan-step join key + Continue anchoring.** Tasks linked to plan steps by *fuzzy text match*, so a reworded `TodoWrite` item landed as an orphan and the plan never advanced. The executor now tags each item `[N]` (plan step) / `[N.M]` (sub-task), giving a stable join key, with upward roll-up (sub-tasks done → parent done) — ADR-0049. And the **Continue** control re-injects the active plan's concrete steps + a "resume only this, don't re-audit the project" guardrail, so a paused plan resumes itself instead of triggering a whole-project re-audit — ADR-0050.

**v0.1.46–0.1.48 — browser/MCP + background-job polish.** The Playwright MCP didn't start under a Finder-launched app (minimal launchd PATH → bare `npx` ENOENT'd); PATH is now enriched at the sidecar launch *and* on the spawned server's env (0.1.46). MCP-vs-CLI browser selection became a deterministic MUST trigger instead of a soft nudge (0.1.47). And a long-running background job (a dev server) SIGTERM'd on app quit no longer fires a spurious "job did NOT succeed" turn that resurfaced on every relaunch — shutdown/stop signals are treated as "stopped, not finished" (0.1.48). ADR-0045 / ADR-0038 addenda.

**v0.1.43 — full session history via incremental paging.** Restoring a session on cold start loaded only the last 200 `cli.event` lines (`hydrate(tail:200)` + the server's `turns.slice(-tail)`) — and since one exchange spans many events, that was just the last few turns, with no signal it had been clipped. The server now reports `truncated`/`totalTurns`; the client paints the last 200 lines instantly, then a top-of-list control loads the **next 200** (or jumps to the **full log**) on demand, with a live "N of M lines" count. Fast first paint plus user-controlled completeness — the full transcript is always reachable, and the 120 MB worst case is never auto-loaded. ADR-0048.

**v0.1.42 — plan persistence + review-window fixes + backlog capture-at-discovery.** Three changes. **(1) Plan persists across chat switches** ([ADR-0046](./docs/decisions/0046-plan-as-durable-spine.md) follow-up): the plan strip was in-memory/session-scoped, so switching chats or relaunching lost it; `replay` now reconstructs the plan + checklist from the transcript on session load (last `# Plan` reply + latest `TodoWrite` for step progress), and a later `TodoWrite` reconciles into the restored plan instead of orphaning as a task list. **(2) Review window** ([ADR-0034](./docs/decisions/0034-agent-change-review-checkpoints.md) bugfix): a newly-written file (one all-added hunk) showed a half-empty side-by-side and hung the window; added/deleted files now render single-column with a banner, the diff flattens to a virtualized row-level `LazyVStack`, and a >1500-line diff is gated behind "Show anyway" (mirrors GitHub/VS Code). **(3) Backlog capture-at-discovery** ([ADR-0047](./docs/decisions/0047-backlog-capture-at-discovery.md)): "noticed in flight" items were lost when a turn ended without a handoff; a new `provisional` status + `backlog_add … provisional:true` auto-park a discovery the instant it's noticed, with a keep/dismiss review at the handoff.

**v0.1.41 — plan as the durable spine.** Two plan-tracking bugs: a `TodoWrite` emitted mid-plan wholesale-replaced the checklist, so sub-tasks erased the plan's steps and a sub-task-only list fired a false "Plan complete"; and a second plan overwrote the single plan slot, making the original untrackable. The active plan now owns hierarchical steps — incoming `TodoWrite`s **reconcile** into them (matched step → status update, unmatched item → nested sub-task) instead of replacing the list, completion is computed over top-level steps only, and plans live in a revision-aware session list with a strip picker so prior plans stay navigable. `personality.ts` + the approve-to-execute instruction now require a full carry-forward `TodoWrite` (never a partial list). ADR-0046, revising ADR-0036.

**v0.1.40 — fix: AskUserQuestion's "Send choice" did nothing.** The interactive decision sheet (ADR-0040) registered its confirm with the default **5-minute** auto-deny timeout — the one meant for permission confirms. A human weighing detailed options for >5 min was silently auto-DENIED (the turn proceeded ignoring the choice; the registry entry was deleted), so a later "Send choice" click hit a dead confirm and did nothing. AskUserQuestion is the model explicitly blocking on a human decision, so it now registers with NO auto-deny timer — it waits for you; the turn's `finally` (`clearTurnConfirms`) + Stop unwind an abandoned one. Regression test in `confirm-registry-timeout.test.ts`.

**v0.1.39 — Playwright MCP, opt-in + gated.** MARVIN's first EXTERNAL (stdio) MCP server (`npx @playwright/mcp@latest`), off by default. The gate previously blanket-allowed every MCP tool — safe for the in-process graph/memory/backlog servers, unsafe for Playwright's code-exec/egress tools. A `mcpToolPolicy` now classifies the `playwright` tools (observation auto · interaction/navigation confirm · `browser_run_code_unsafe` deny), the subagent read-only invariant restricts scouts to observation, and a `playwrightEnabled` toggle is threaded to the web Setup popover + macOS Settings ▸ Browser (ADR-0045).

**v0.1.38 — Project backlog.** A durable, per-project parking lot for *actionable* "noticed in flight, not in scope" follow-ups that used to evaporate with the chat. A `marvin-backlog` MCP (`backlog_add` / `list` / `resolve`, content-class enforced) + `GET/POST/PATCH /api/backlog` share one store (file-per-item + index, mirroring memory); open items re-inject into next session's context; a macOS panel + tray chip gives Done / Dismiss / Promote-to-plan. Consent-gated capture; a parking lot, never a queue agents pull from (ADR-0044).

**v0.1.37 — server-initiated turns reach an idle client.** Background-job completion (ADR-0038) and timed wakeups (ADR-0031) fire a real turn server-side, but the idle app only attached to a turn's stream on session hydrate — so the completion turn ran into the bus with no listener and was invisible until a session switch. A per-project always-on SSE (`/api/chat/announce`) now re-attaches the idle app to any server-started turn, with a "background job running" chip (ADR-0043).

**v0.1.33–0.1.36 — turn-lifecycle hardening + context panel.** One live turn per session (`POST /api/chat` returns `409` instead of evicting a running turn, and eviction aborts the displaced agent — v0.1.33); **Stop** is authoritative (`cancelLiveTurn` force-ends a wedged turn so the session can't lock — v0.1.34); a click-to-open **context-usage panel** on the status-bar `ctx` chip with a per-category breakdown from live SDK usage (v0.1.35); and a fired wakeup yields to a live interactive turn instead of evicting it (v0.1.36). (v0.1.34 also ended a stray-tag version divergence, resetting the line to 0.1.x.)

**v0.1.32 — memory as a curated durable-facts layer.** A real project's `.marvin/memory.md` had bloated to 419 KB / ~99 % redundant with ADRs, git, and the changelog (the model mirrored its Ship summaries into it). memory now holds ONLY what the next session can't re-derive from those — invariants, gotchas, constraints, external facts. A new in-process **`marvin-memory`** MCP (`remember` / `recall`) is the *enforced* write path: one fact → `.marvin/memory/<slug>.md` + a one-line index, supersede-by-name, with length caps + content-class guards that reject activity/status. `personality.ts` carries a MUST/MUST-NOT firm surface; a **`/memory-compact`** command distills an existing log. The Scope-met chip is retargeted to `.marvin/session-notes.md` so it can't pollute the index. ADR-0042.

**v0.1.31 — "Prompt is too long" fixed.** On a mature project the first message overflowed the model's 200 K window — `buildProjectContext` injected every ADR in full + the whole memory.md (~566 K tokens measured). Two layers (ADR-0041): MARVIN now **builds/maintains the active project's graphs** (code + knowledge, AST-only/free, scoped to the project — never its own repo), and the first-message context is **budgeted** — ADRs as a titles index (details via the knowledge graph + targeted reads), memory as a recent tail, curated docs whole. Measured 566 K → ~13 K tokens.

**v0.1.30 — interactive AskUserQuestion + Node-24 CI.** When the model hits a real decision it calls **AskUserQuestion** and MARVIN renders the options as clickable buttons (single/multi-select + "Other"), returning your pick to the model as the tool result — instead of prose "(a)/(b)" you could only answer by typing. Routed through the existing confirm channel in every mode (ADR-0040). Also bumped every release-workflow action to its Node-24 major ahead of GitHub's cutoff.

**v0.1.27–29 — two-tier to-do / plan polish.** The checklist strip splits into a neutral **"Task list"** (bare `TodoWrite`, no plan) and a purple **"Plan — <title>"** (plan-backed, ticks off in place); a presented plan is auto-written to `.marvin/plans/<slug>.md` and opened in the editor pane ("Open plan"); the plan title/filename derive from the `# Plan` heading wherever it sits (no more garbage slugs); and a completed plan no longer shows a contradictory "Approve & execute" chip. ADR-0036 (two-tier addendum). Plus the Homebrew "MARVIN.app is damaged" fix — the cask now strips `com.apple.quarantine` in a `postflight` (modern Homebrew quarantines casks by default; ad-hoc bundle + quarantine reads as "damaged" on macOS 26).

**v0.1.26 — The plan card.** Plan-mode plans render as a structured, collapsible Cursor-style **plan card** (title, step count, styled headings/steps/code) instead of a plain-text bubble — the plan-mode prompt mandates a `# Plan — <title>` opening heading, detected live and on transcript replay. Approving seeds the To-dos checklist from the plan's steps, and the paused chip now names the next step and what there concretely is to review (the stopping error, or the changed-file count).

**v0.1.25 — Plan-mode UX polish.** Session-scoped strips (no stale plan in a new chat); Approve/Continue as hidden control actions (no fake user message in the chat); **Save plan** to a Markdown file you can follow alongside the chat; collapse/dismiss the checklist (auto-collapses when done); and the checklist relabeled **"To-dos"** — it's the task tracker (used in any mode), while the plan stays a distinct inline message + file.

**v0.1.24 — Plan mode decoupled, chat strip tray.**

- **Plan mode** (ADR-0036 rev) — a read-only planning turn on your chosen **advisor** model presents a numbered plan **inline** in the chat (no modal); an **"Approve & execute"** chip then runs it in a separate **Agent** turn on your **executor** model. Models routed by role; no re-planning.
- **Chat strip tray** — the plan checklist, changed-files Review, and session controls now live in one opaque, divider-separated tray that no longer overlaps the message log.

**v0.1.23 — Background jobs, fetch skills from Git, Plan follow-through.**

- **Background jobs** (ADR-0038) — `run_background_job` runs a long command past the turn and fires a real follow-up turn on exit with the result; shell backgrounding is denied at the gate.
- **Fetch skills from Git** (ADR-0039) — "Add from GitHub" installs a skill from any repo, a `…/tree/…` sub-path, or a plugin marketplace (clone + copy only).
- **Plan-mode follow-through** (ADR-0036) — the plan persists in the chat and becomes the tracked to-do checklist (○→◌→✓); the prompt requires live `TodoWrite` updates.
- **Skills pane** reorganised by state: active here · installed-off-here · recommended to add.

**v0.1.22 — Modes, Cursor-style chat surface, skill enablement.**

- **Ask · Agent · Plan modes** (ADR-0036) — a `mode` axis orthogonal to the auto/gated strategy. Ask is read-only (hard-denied at the gate); Plan runs under the SDK's plan mode and surfaces an approval card before executing; Agent is the unchanged default. The model's `TodoWrite` renders as a live checklist.
- **Cursor-style chat surface** — mode + reasoning controls moved into the input box; chat tabs you can open and close, persisted per project.
- **Per-project skill enablement** (ADR-0037) — installed ≠ active: a core/domain catalog + fingerprint default names the skills relevant to this project and tells the model to ignore the rest (20→7 on this repo). Skills-pane toggles + `.marvin/skills.json`.

**v0.1.21 — Change-review diff editor.**

- **VS Code / Cursor-style diff editor** — the review surface is its own resizable window: side-by-side original │ modified, line numbers, and a Split/Inline toggle (v0.1.20). The editor's diff gutter now tracks lines exactly on scroll — markers come from STTextView's real layout geometry, cached, instead of a line-height guess that drifted (v0.1.21). And **committing a change clears it from the review** the way it leaves VS Code's Source Control list — a committed change is an accepted one (`reconcileCommitted`, drops only, never rewrites a baseline). ADR-0034.
- **Agent change review** — the permission gate snapshots every file's pre-image on first agent touch per session; accept advances the baseline, reject reverse-applies to disk — never `git discard`, which would destroy uncommitted user work. v1 blind spot: Bash-driven mutations aren't pre-imaged. ADR-0034.
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

- [White paper](./docs/whitepaper/WHITEPAPER.md) — the design position, the evidence, and the results; [Technical Reference](./docs/whitepaper/TECHNICAL-REFERENCE.md) is the exhaustive companion (both also as [PDF](./docs/whitepaper/WHITEPAPER.pdf) / [PDF](./docs/whitepaper/TECHNICAL-REFERENCE.pdf))
- [Overview](./docs/getting-started/overview.md) — what MARVIN is, who it's for
- [Quickstart](./docs/getting-started/quickstart.md) — install → first session
- [Modes & workflows](./docs/guides/workflows.md) — Ask / Agent / Plan with worked examples, and how MARVIN takes decisions
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

# Roadmap

The canonical view of where MARVIN stands: what's in flight, what shipped, what's deferred, what's deliberately out of scope. v1.2 (audit-driven hardening pass) closed out 2026-04-26.

For the chronological history with diagnostic trails per entry, see [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). For material design decisions, see [`docs/decisions/`](./decisions/). For dated audit reports, see [`docs/reviews/`](./reviews/).

## In flight

_Active work. Add a one-line entry when a piece of work starts; move it to `## Shipped` (with the date) when it lands. Keep entries terse — link out to a PR, ADR, or roadmap note for detail._

_(nothing in flight — all feature work landed in v1.3 below)_

## Shipped

### v1.3 — Fully-native IDE surface · shipped 2026-05-05

WebView removed end-to-end (ADR-0021); native SwiftUI replaces every web-rendered panel. IDE feature set shipped across 8 milestones on `feat/swift-migration`:

- **WebView removal (M5)** — WKScriptMessageHandler bridge, injected JS, WebView.swift, and marvin-shell.ts deleted. NativePrefs + ProjectsService own all pref/project state. NSOpenPanel replaces the web picker.
- **MRU file picker (M1)** — QuickOpenSheet tracks recently-opened files per project; shows RECENT / ALL FILES sections. Persisted via UserDefaults.
- **Find in Files (M2)** — Ripgrep-backed `/api/files/search` route + FindInFilesView sidebar tab. Debounced search, case/word/regex toggles, match highlighting, collapsible file groups, include glob filter, Replace field.
- **Symbol Search (M3)** — ⌘T Go to Symbol sheet reads `graphify-out/graph.json` from disk; fuzzy-filters by label + file path.
- **Diff gutter (M4)** — `git diff HEAD --unified=0` parsed into `[Int: DiffLineStatus]`; `DiffGutterBar` NSView overlaid on the STLineNumberRulerView right edge. Green/orange/red pip per line.
- **File history (M5)** — `git log --follow` in `GitHistoryService`; click-to-copy SHA popover in the editor header.
- **Build task palette (M6)** — ⌘⇧B discovers tasks from `package.json`, `Makefile`, `Package.swift`, `Cargo.toml`; injects selected command into the terminal pane.
- **Diagnostics panel (M7/M8)** — `DiagnosticsService` auto-detects tsc/eslint/swift build; `DiagnosticsPanelView` Problems tab in the bottom panel; clickable ⊗N/⚠N badge in `AppStatusBar`.
- **Source control push/pull/fetch** — `FilesService` + `SourceControlView` header buttons; calls `/api/git/push`, `/api/git/pull`, `/api/git/fetch`.

### Phase 1 — Foundations · shipped 2026-04-17

- `~/marvin/` monorepo scaffold, pnpm workspaces + Turbo.
- `sidecar/` Next.js 16 on port 3030.
- `sidecar/packages/runtime/` — Claude CLI + Agent SDK wrappers, auth, session, cost, personality.
- `sidecar/packages/project-context/` — first-message injection (docs + ADRs + memory + graph header + workflow audit).
- `sidecar/packages/graphify-bridge/` — watchdog, read-graph, in-process MCP server.
- `sidecar/packages/git-watch/`, `sidecar/packages/tools/`, `sidecar/packages/ui/` — supporting packages.
- Baseline `/api/chat` SSE streaming, JSONL session persistence.

**Milestone:** `curl http://localhost:3030/api/health` returns 200; `/api/chat` SSE-streams a MARVIN-voiced reply.

### Phase 2 — Chat + tools · shipped 2026-04-17

- Type system: Geist Sans + Instrument Serif + JetBrains Mono.
- `<MarvinBrain>` hand-authored SVG component with 5 states.
- Chat stream hook + message rendering + collapsible tool-call cards.
- Status bar (state · duration · tokens · cost · session id).
- **Structural confirm-before-act gate** — migration from raw CLI to `@anthropic-ai/claude-agent-sdk`'s `canUseTool`. See [ADR-0004](./decisions/0004-structural-confirm-gate.md).
- `/api/confirm` + `<ConfirmPrompt>` inline in tool-call cards.
- `personality.ts` enriched — runtime grep in Impact Analysis, ADR template enforcement, Future-MARVIN critique subagent.

**Milestone:** in a throw-away sample project, chat "build a logout route" — MARVIN reads, proposes, applies, verifies, offers to commit.

### Phase 3 — File tree + terminal + diff viewer · shipped 2026-04-17

- `/api/files/tree`, `/api/files/content`, `/api/files/status` — project-scoped fs walker + git status.
- `<FileTree>` with dirty-file badges, branch pill, dirty-ancestor dots.
- `<FileViewer>` with sticky line numbers + language label.
- `<Terminal>` (xterm.js + fit-addon) — SSE command runner, persisted history, Ctrl-C cancellation, Ctrl-L clear.
- `<DiffViewer>` (monaco-editor) — Edit / Write cards + ConfirmPrompt integration.
- Resizable splits via `react-resizable-panels` — horizontal + vertical panels persist to localStorage.

**Milestone:** visual parity with the 3-pane mock-up; editing a file updates the tree badge; terminal reflects chat-driven changes.

### Phase 4 — Persistence, project picker, cost, personality, graph panel · shipped 2026-04-17

- `@marvin/runtime/projects` — registry backed by `~/.marvin/projects.json`.
- `@marvin/runtime/cost-tracker` — append-on-turn ledger + aggregation.
- `<ProjectPicker>`, `<AddProjectDialog>`, `<CostPill>`, `<PersonalityToggle>`, `<GraphPanel>`.
- New API routes: `/api/projects{,active,verify}`, `/api/sessions{,[id]}`, `/api/cost`, `/api/graph/query`.
- `useChatStream.hydrateFromSession()` — rebuilds UI from a JSONL transcript.
- Widened chat frame, header controls, pane-toggle persistence.

**Milestone:** ship MARVIN v1 — dog-food on a fresh Next.js + Prisma starter end-to-end.

### Phase 5 — Stretch · partially shipped 2026-04-18/19

- **[done 2026-04-18]** Advisor strategy. See [ADR-0003](./decisions/0003-advisor-strategy.md).
- **[done 2026-04-18]** Browser preview pane (iframe-based). Stackable beside file viewer + terminal.
- **[done 2026-04-18]** Graph-aware chat via in-process MCP server (`marvin-graph`). `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`.
- **[done 2026-04-18]** Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘⇧N, ⌘., `?`, `Esc`), session search in picker, `<ShortcutsHelp>` overlay.
- **[done 2026-04-18]** Refresh-safe turns (`turn-registry.ts`) — closing the tab doesn't kill a running turn; `/api/chat/resume` tails live event bus; `/api/chat/cancel` as the explicit abort.
- **[done 2026-04-18]** Dynamic model discovery (`/api/models`) + `<ModelPicker>` — two-slot executor + advisor with live-or-fallback list.
- **[done 2026-04-18]** Astronomical-ledger hero pass — orbital rings, constellation drift, staggered `hero-stage` reveals, moon-phase status glyphs.
- **[done 2026-04-18]** `marvin-playwright` MCP — own Playwright stdio server, unsandboxed against localhost.
- **[done 2026-04-18]** Workflow-audit fires on every turn while gaps exist; stack-agnostic detector; Mode A/B/C execution split.
- **[done 2026-04-19]** Dual-theme support. Light baseline + icy-blue-on-black dark override per the Claude Design handoff. See [ADR-0006](./decisions/0006-light-first-theme-cascade.md). Monaco + xterm follow the toggle.
- **[done 2026-04-19]** BrainLiquid canvas particle brain — curl-noise flow, roaming attractors, per-state profiles, theme-aware painting.
- **[done 2026-04-19]** Clickable wordmark as "return to hero" nav. Hydration warning suppression.
- **[done 2026-04-19]** Full documentation pass — `docs/` with 30 files (this page).

### v1.1 — install-app + scout subagents · shipped 2026-04-21

- `bin/marvin install-app` ships a real `/Applications/MARVIN.app` plus a launchd user agent that auto-starts the server on login. (The original Tauri-based wrapper from [ADR-0010](./decisions/0010-desktop-wrapper-tauri.md) was retired by [ADR-0016](./decisions/0016-swift-migration.md) — current install path is `bin/marvin install-macos-app`.)
- Scout subagents (`subagent_type: "scout"`) — read-only research carve-out via the SDK's `agents:` option. SDK-level `disallowedTools` is the structural backstop. See [ADR-0014](./decisions/0014-scout-subagents-read-only.md).
- File tree toolbar, source control panel polish, model-picker presets.

### v1.2 — audit-driven hardening pass · shipped 2026-04-26

Closed every 🔴 finding in the [2026-04-26 full audit](./reviews/2026-04-26-full-audit.md). Highlights:

- **Permission gate is now load-bearing in `auto` mode too** — bare `Task` calls require confirm; sanctioned subagent types (`scout`, `general-purpose`) auto-allow. `BASH_HARD_DENY` no longer leaks `rm -rf $HOME`, `git push -f`, `chmod -R 777`, `curl … | sh`. See [ADR-0015](./decisions/0015-auto-mode-policy-floor-and-audit-log.md).
- **Auto-mode audit log** — every auto-allowed Edit/Write/Bash appends one JSONL line to `<workDir>/.marvin/auto-audit.jsonl`. New [`/api/audit/auto`](./reference/api.md) route.
- **Confirm prompt redesign** — severity classifier (warn/danger), filled accent allow button, blast-radius hint, `(N)` `document.title` badge while pending, 5-minute auto-deny via the registry timer.
- **Honeycomb env race fixed** — `computeHoneycombTelemetryEnv()` returns the env-diff to merge; per-turn `Options.env` so concurrent turns for two projects don't clobber each other.
- **`/api/chat` cwd validation** — returns `400 invalid-cwd` when cwd is missing, non-absolute, or equals MARVIN's own install root.
- TopBar collapsed (17 controls → 7), empty-state hero trimmed, sticky-bottom chat scroll, single `useMarvinPrefs()` Context, `bin/marvin doctor` graph smoke check.

## Deferred (blockers, not capacity)

### Long-term memory / recall MCP

A `recall(query)` MCP tool over embed-indexed session transcripts (and, on top of that, an optional extension of the graphify graph with conversation-derived nodes). Researched + planned 2026-05-05; parked, not shipping. Full plan, advisor critique, eval-first DoD, and 6 milestones live in [`roadmap/long-term-memory-recall.md`](./roadmap/long-term-memory-recall.md). Pick up when an eval-driven need surfaces.

### Honeycomb MCP integration for observability

Registered as `marvin-honeycomb`. Would expose trace querying as tools the executor could invoke while debugging production issues.

**Blocker:** requires a Honeycomb account + team-specific configuration. Violates [isolation contract](./concepts/isolation-contract.md) if baked into MARVIN's source; belongs in `<workDir>/.marvin/` config. No shipping ETA until a user has a Honeycomb environment to be the first to try.

### Automated tests for surfaces beyond the write-channel security layer

**Partial shipment 2026-04-21** — Vitest harness + 61 tests cover
`fs-sandbox` / `fs-write-policy` / `fs-constants` /
`fs-write-confirm-registry`. The Agent SDK interaction loop,
streaming UI, and individual API routes remain uncovered — still
opportunistic. See [Testing](./development/testing.md).

### `/api/health` `model` field rename

Old response has `model: claude-opus-4-7` which users mistake for "the live model." Renamed to `defaultModel` on 2026-04-19 — some docs or scripts may still reference the old name. Update callers.

### Light-theme recolour _(landed 2026-04-21)_

The pre-landing light theme based on `oklch(0.985 0.003 80)` — effectively pure warm white. User feedback: too bright, especially over long sessions. Recoloured to:

- `--color-bg` → `oklch(0.95 0.006 80)` (was `0.985`)
- `--color-bg-elev` → `oklch(0.935 0.005 80)` (was `0.975`; elevation gap widened from `0.010` to `0.015`)

Chroma nudged from `0.003` → `0.006` so the surfaces read as warm paper rather than flat grey. Monaco `marvin-light` theme updated in lockstep (`editor.background` `#faf8f3` → `#f1ece1`; line-highlight matched a half-step below). Dark theme untouched. Touches `sidecar/src/app/globals.css` + `sidecar/src/components/settings/monaco-themes.ts`.

## Not planned

Things MARVIN deliberately won't do. See [Vision](./business/vision.md) for the reasoning.

- Multi-agent orchestration ([ADR-0001](./decisions/0001-single-assistant.md)).
- Hosted SaaS with shared state.
- Cross-project memory.
- Broad "auto-mode heuristics" that switch models based on guessed complexity ([ADR-0002](./decisions/0002-default-to-opus-4-7.md)).

## Related

- [Changelog](./history/CHANGELOG.md) — chronological record of what shipped, when, and why.
- [Vision](./business/vision.md) — what MARVIN is trying to be.
- [ADRs](./decisions/) — material decisions.

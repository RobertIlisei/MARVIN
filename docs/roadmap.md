# Roadmap

What's in flight, what's deferred, and what MARVIN deliberately won't do. The chronological record of what shipped, when, and why lives in [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). Material decisions live in [`docs/decisions/`](./decisions/).

## In flight

_Active work. Add a one-line entry when a piece of work starts; move it out (to CHANGELOG, with the date) when it lands._

- **Multi-graph architecture — code + knowledge** ([ADR-0028](./decisions/0028-multi-graph-architecture.md), development branch only). Two graphs per project: `graphify-out/graph.json` (code, auto-rebuild on commit, unchanged) and `graphify-out/knowledge/graph.json` (docs / ADRs / memory, manual rebuild via `bin/marvin knowledge-graph`, AST-only, no LLM cost). All six MCP graph tools accept a new `scope: "code" | "knowledge" | "all"` parameter, default `"code"` for backwards compatibility. Stable v0.1.13 cask + main branch unchanged — rollback is `git checkout main` or `brew install --cask marvin-ai`. Cross-graph joins, tool-history graph, semantic doc extraction deferred per the ADR.
- **macOS 26 Gatekeeper fix — install to `~/Applications`** ([ADR-0027](./decisions/0027-macos-26-gatekeeper-user-applications.md)). macOS 26 (Tahoe) kernel-kills ad-hoc-signed bundles in `/Applications` regardless of signature state; the same `.app` runs cleanly from `~/Applications`. `bin/marvin install-macos-app` and the Homebrew cask both retarget to `~/Applications/MARVIN.app`; uninstall cleans up the legacy `/Applications` path. New users still hit the user-space Privacy & Security popup on first Finder launch (one-time whitelist via "Open Anyway"). README + cask `caveats` document the click-through.
- **Syntax-highlighter coverage — YAML.** Add `tree-sitter-yaml` SPM dep + `Resources/Queries/yaml.scm`. Trivial; every project has compose / workflow / kubeconfig files. ~15 min.
- **Syntax-highlighter coverage — Markdown.** Vendor `tree-sitter-markdown` to bypass the upstream `tree-sitter/swift-tree-sitter` binding-conflict documented in `macos/Package.swift`. Half of all docs are `.md`. ~30 min.
- **Syntax-highlighter coverage — Python.** Vendor `tree-sitter-python` with a patched `Package.swift` (the upstream runtime `FileManager.fileExists("src/scanner.c")` check is the documented blocker). Most-asked-for missing language. ~1 hr.
- **Terminal pane — ANSI colour passthrough.** Replace the current `stripANSI(_:)` with a small CSI-colour parser that maps the 16 standard + 8 bright ANSI colours to `NSAttributedString` foreground attributes. `cargo`, `pnpm`, `pytest`, `make`, `gradle` output becomes legible. Contained to `macos/MARVIN/TerminalPaneView.swift`. ~half day.

_When a work item lands, move its line out of this section into a dated `## Recent milestones` entry (with the cask + tag + ADR if any)._

## Current version

**v0.1.27** — Two-tier to-do / plan (Cursor parity): the checklist strip now
forks into a neutral "Task list" for bare `TodoWrite` runs (Agent mode, no
plan behind it) and a purple "Plan — <title>" for plan-backed execution that
ticks off in place — so the two never read as one artifact replacing the
other. A presented plan is auto-written to `<workDir>/.marvin/plans/<slug>.md`
and opened in the editor pane, with an "Open plan" affordance to re-focus it.
Builds on v0.1.26's plan card. Install via
`brew tap RobertIlisei/marvin && brew install --cask marvin-ai`. Earlier
tags v0.1.0–v0.1.5 carried pre-scrub code and have been deleted from
GitHub; stray tags v1.2.0/v1.3.0 have no release. Per-release detail in the
[changelog](./history/CHANGELOG.md).

## Recent milestones

The high-water marks. Diagnostic detail per release in the [changelog](./history/CHANGELOG.md).

- **2026-06-13 — v0.1.27 two-tier to-do / plan + plan file in the editor** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). The plan card (in the chat scroll) and the to-do strip (above the input) read as two artifacts replacing each other; Cursor keeps two distinct tiers that coexist. `TodoListStrip` now forks on `planTitle != nil`: a neutral blue "Task list" for bare `TodoWrite` checklists, a purple titled "Plan — <title>" for plan-backed execution that ticks off in place. A presented plan is auto-written to `<workDir>/.marvin/plans/<slug>.md` and opened in the editor pane (`persistAndOpenPlan` → `setSelectedFile`) with an "Open plan" button. `personality.ts` updated to the inline-`# Plan`/stop contract (stale `ExitPlanMode` wording removed) + a tier-1 task-list trigger for 3+ step Agent work.
- **2026-06-12 — v0.1.26 plan card (Cursor-style structured plan rendering)** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). The decoupled Plan mode had left the plan as a plain-text assistant bubble. The plan-mode prompt now mandates the reply open with `# Plan — <title>`; `ChatMessageRow` detects that heading and renders the message as a collapsible `PlanCardView` (title, step count, line-styled markdown: headings / numbered steps / bullets / code fences) — content-shaped detection, so it also fires on transcript replay. Approving the plan seeds the To-dos strip from the plan's steps so execution starts tracked.
- **2026-06-11 — v0.1.25 Plan-mode UX polish** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Session-scoped plan/changes strips; Approve/Continue as hidden control actions (no fake user message); Save plan to a Markdown file; collapse/dismiss + auto-collapse the checklist; relabel "Plan" → "To-dos" (the task tracker; the plan is a distinct inline message + file).
- **2026-06-11 — v0.1.24 Plan mode decoupled + strip tray** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). Plan mode is a read-only planning turn on the chosen advisor model that presents the plan inline (no modal); an "Approve & execute" chip runs it in a separate Agent turn on the executor — role-routed models, no re-planning. The chat's contextual strips moved into one opaque divider-separated tray so they no longer overlap the message log.
- **2026-06-11 — v0.1.23 background jobs + fetch skills + plan follow-through** ([ADR-0038](./decisions/0038-background-jobs-event-wakeups.md), [ADR-0039](./decisions/0039-fetch-skills-from-git.md)). `run_background_job` fires a real follow-up turn on process exit (event-based wakeup); shell backgrounding denied at the gate. "Add from GitHub" fetches skills from a repo / sub-path / plugin marketplace. Plan mode: the plan persists in the chat + seeds the tracked to-do checklist; prompt requires live `TodoWrite` updates. Skills pane reorganised by state (active / available / recommended).
- **2026-06-11 — v0.1.22 modes + Cursor-style chat surface + skill enablement** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md), [ADR-0037](./decisions/0037-skill-enablement-active-set.md)). Ask/Agent/Plan modes (Ask read-only at the gate; Plan = SDK plan mode + an `ExitPlanMode` approval card; Agent unchanged) + a live `TodoWrite` checklist. Mode/reasoning controls relocated into the input box (`ChatModeToolbar`); open/close chat tabs persisted per project. Per-project skill enablement: a core/domain catalog + fingerprint-defaulted active set, named in the system prompt so MARVIN ignores irrelevant installed skills (20→7 here); Skills-pane toggles + `.marvin/skills.json`.
- **2026-06-10 — v0.1.21 diff-gutter accuracy + commit clears the review** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). `DiffGutterBar` now positions change markers from STTextView's real layout fragments (cached) instead of a font-metric line-height guess that drifted on scroll, and is `isFlipped`. `reconcileCommitted` (on `GET /api/changes`) auto-accepts reviewed files now clean vs HEAD, so committing clears them — drops only, never rewrites a baseline. 15/15 checkpoint tests.
- **2026-06-10 — v0.1.20 change review as a real diff editor** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). The review surface moved off a pane-clamped `.sheet` into its own large resizable `Window` with a side-by-side (original | modified) diff, line numbers, and a Split/Inline toggle — the VS Code / Cursor diff-editor layout. Cross-window strip refresh via `.marvinAgentChangesDidMutate`; checkpoint semantics unchanged.
- **2026-06-10 — v0.1.17–v0.1.19 per-role effort + agent change review + port ownership** ([ADR-0033](./decisions/0033-advisor-registered-agent-per-role-effort.md), [ADR-0034](./decisions/0034-agent-change-review-checkpoints.md), [ADR-0035](./decisions/0035-bundled-app-owns-its-port.md)). Advisor is a registered agent with its own model + effort (`adv` chip, "follow executor" default; SDK `advisorModel` Option found unwired). Cursor-style change review: gate-captured pre-image checkpoints, `/api/changes` family, live "N files changed" strip + per-hunk accept/reject sheet (E2E-verified). v0.1.19 closes the stale-sidecar-adoption bug that had masked two releases: the bundled app reclaims `:3030` before spawning and `/api/health` reports the serving process's `version`.
- **2026-06-04 — v0.1.14–v0.1.16 self-scheduled wakeups** ([ADR-0031](./decisions/0031-self-scheduled-wakeups.md), [ADR-0032](./decisions/0032-deny-background-bash.md)). `schedule_wakeup` / `cancel_wakeup` / `list_wakeups` (`marvin-control` MCP) + bounded persistent scheduler; fired wakeups start real turns via the shared `runDetachedTurn` orchestrator. v0.1.15 hard-denies Bash `run_in_background` at the gate. v0.1.16 fixes the standalone module-isolation bug (globalThis singleton + request-path handler wiring) that made fired wakeups evaporate without a turn.
- **2026-05-20 — v0.1.6 Homebrew cask + scrub.** Brew tap `RobertIlisei/marvin` with cask token `marvin-ai` (avoids collision with the unrelated "Amazing Marvin" cask). Vertical-specific recommendation rules removed (PR #81); domain-agnostic skill recommendations only. Personal-path scrub across docs.
- **2026-05-13 — Project-aware skill recommendations** ([ADR-0024](./decisions/0024-project-aware-skill-recommendations.md), [ADR-0025](./decisions/0025-skills-pane-ui.md)). Fingerprint detector at `sidecar/packages/project-context/src/fingerprint.ts` emits ~42 namespaced tags; 25 hand-curated rules in `sidecar/packages/runtime/src/suggestion-rules.ts` map tags → install/build verbs. Skills pane is the 4th tab in `LeftPane.swift`.
- **2026-05-10 — Bundled sidecar + brew-distributable** ([ADR-0023](./decisions/0023-brew-distributable-bundled-sidecar.md)). Sidecar now lives inside `MARVIN.app/Contents/Resources/` (Node 22.11.0 darwin-arm64 + Next standalone tree) and is spawned by the Swift process on launch. The launchd user agent path is opt-in via `bin/marvin install-macos-app --launchd`. Sidecar log path becomes `~/Library/Logs/MARVIN/sidecar.log`.
- **2026-05-05 — Fully-native IDE surface milestone** ([ADR-0021](./decisions/0021-webview-removal-fully-native-swift.md)). WebView removed end-to-end; native SwiftUI replaces every web-rendered panel. 8 sub-milestones: WebView removal, MRU file picker, Find in Files (ripgrep), Symbol Search (graph-backed), diff gutter, file history, build task palette, diagnostics panel + clickable status badge.
- **2026-05-04 — Phase ADRs 0017–0020** lay out the sub-phases that the native-IDE milestone collapsed.
- **2026-04-26 — Audit-driven hardening pass.** Closed every 🔴 finding from the full audit. Permission gate load-bearing in `auto` mode, `BASH_HARD_DENY` plugged ([ADR-0015](./decisions/0015-auto-mode-policy-floor-and-audit-log.md)), confirm-prompt redesign, Honeycomb env race fix, `/api/chat` cwd validation, TopBar collapse.
- **2026-04-21 — install-app + scout subagents.** `bin/marvin install-macos-app` ([ADR-0016](./decisions/0016-swift-migration.md) replaces the original Tauri wrapper from [ADR-0010](./decisions/0010-desktop-wrapper-tauri.md)). Read-only scout subagents ([ADR-0014](./decisions/0014-scout-subagents-read-only.md)).
- **2026-04-17 — initial ship.** Phases 1–4: chat surface, file tree, terminal, diff viewer, project picker, cost tracker, personality toggle, graph panel.

## Deferred (blockers, not capacity)

### Honeycomb MCP integration for observability

Would register as `marvin-honeycomb` and expose trace querying as tools the executor could invoke while debugging production issues. **Blocker:** requires a Honeycomb account + team-specific configuration; baking that into MARVIN's source violates the [isolation contract](./concepts/isolation-contract.md). Belongs in `<workDir>/.marvin/` config; no shipping ETA until a user has a Honeycomb environment to be the first to try.

### Test coverage beyond the write-channel security layer

The Vitest harness covers `fs-sandbox` / `fs-write-policy` / `fs-constants` / `fs-write-confirm-registry` and the new Swift logic targets (`MARVINLogic`, `MARVINTests`). The Agent SDK interaction loop, the React/SwiftUI shells, and individual API routes remain uncovered — still opportunistic. See [Testing](./development/testing.md).

### Real Developer ID + notarization

Today's `bin/marvin install-macos-app` produces an ad-hoc-signed `.app`; first launch needs right-click → Open. Real Developer ID + notarization removes the Gatekeeper warning and unlocks a pre-built signed `.app` distributed via GitHub Releases. **Blocker:** requires an Apple Developer account (~$99/yr) and CI plumbing for notarization.

## Not planned

Things MARVIN deliberately won't do. See [Vision](./business/vision.md) for the reasoning.

- Multi-agent orchestration ([ADR-0001](./decisions/0001-single-assistant.md)).
- Cross-platform desktop (Windows / Linux).
- Hosted SaaS with shared state.
- Cross-project memory.
- Broad "auto-mode heuristics" that switch models based on guessed complexity ([ADR-0002](./decisions/0002-default-to-opus-4-7.md)).

## Related

- [Changelog](./history/CHANGELOG.md) — chronological record of what shipped, when, and why.
- [Vision](./business/vision.md) — what MARVIN is trying to be.
- [ADRs](./decisions/) — material decisions.

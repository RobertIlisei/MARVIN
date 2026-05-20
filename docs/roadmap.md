# Roadmap

What's in flight, what's deferred, and what MARVIN deliberately won't do. The chronological record of what shipped, when, and why lives in [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). Material decisions live in [`docs/decisions/`](./decisions/).

## In flight

_Active work. Add a one-line entry when a piece of work starts; move it out (to CHANGELOG, with the date) when it lands._

- **macOS 26 Gatekeeper fix — install to `~/Applications`** ([ADR-0027](./decisions/0027-macos-26-gatekeeper-user-applications.md)). macOS 26 (Tahoe) kernel-kills ad-hoc-signed bundles in `/Applications` regardless of signature state; the same `.app` runs cleanly from `~/Applications`. `bin/marvin install-macos-app` and the Homebrew cask both retarget to `~/Applications/MARVIN.app`; uninstall cleans up the legacy `/Applications` path. New users still hit the user-space Privacy & Security popup on first Finder launch (one-time whitelist via "Open Anyway"). README + cask `caveats` document the click-through.
- **Syntax-highlighter coverage — YAML.** Add `tree-sitter-yaml` SPM dep + `Resources/Queries/yaml.scm`. Trivial; every project has compose / workflow / kubeconfig files. ~15 min.
- **Syntax-highlighter coverage — Markdown.** Vendor `tree-sitter-markdown` to bypass the upstream `tree-sitter/swift-tree-sitter` binding-conflict documented in `macos/Package.swift`. Half of all docs are `.md`. ~30 min.
- **Syntax-highlighter coverage — Python.** Vendor `tree-sitter-python` with a patched `Package.swift` (the upstream runtime `FileManager.fileExists("src/scanner.c")` check is the documented blocker). Most-asked-for missing language. ~1 hr.
- **Terminal pane — ANSI colour passthrough.** Replace the current `stripANSI(_:)` with a small CSI-colour parser that maps the 16 standard + 8 bright ANSI colours to `NSAttributedString` foreground attributes. `cargo`, `pnpm`, `pytest`, `make`, `gradle` output becomes legible. Contained to `macos/MARVIN/TerminalPaneView.swift`. ~half day.

_When a work item lands, move its line out of this section into a dated `## Recent milestones` entry (with the cask + tag + ADR if any)._

## Current version

**v0.1.6** — Homebrew cask + bundled-sidecar distribution. Install via
`brew tap RobertIlisei/marvin && brew install --cask marvin-ai`. Earlier
tags v0.1.0–v0.1.5 carried pre-scrub code and have been deleted from
GitHub; only v0.1.6 is a valid release.

## Recent milestones

The high-water marks. Diagnostic detail per release in the [changelog](./history/CHANGELOG.md).

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

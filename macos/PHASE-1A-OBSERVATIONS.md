# Phase 1a — daily-use observations

Living notebook for the post-Phase-1a gate from
[ADR-0016 §5](../../docs/decisions/0016-swift-migration.md). Phase 1a
(WebView island) is shipped on the `feat/swift-migration` branch.
Phases 1b–d (native menu bar, window-state restoration, NSToolbar)
are deliberately deferred until there's enough daily-use data to
decide whether they're worth the cost — or whether the WebView
island already feels native enough.

## How to use this file

For ~one week, run **MARVIN-Swift.app** (the SwiftUI build) as the
daily driver instead of the Tauri MARVIN.app. Both are installed in
`/Applications/`. Note anything that's noticeably better, noticeably
worse, or breaks outright. One-line entries are fine.

When the week is up, decide one of:

- **Phase 1a is enough — skip 1b–d.** The web shell is fast enough
  inside SwiftUI that the remaining native-frame work isn't
  load-bearing. Move on to Phase 2 (chat surface), or pause the
  migration entirely if the gain doesn't justify the spend.
- **Phase 1b is the right next step.** Specific friction points
  motivate the native menu bar / NSToolbar / window-state work.
  Those friction points should appear below.
- **Roll back.** Phase 1a regresses something the Tauri build had
  right. Document what, and revert.

## What to compare

The honest pre-Phase-1a guess (from the lag investigation that
motivated the migration) was that the felt-laggy moments are at the
shell layer — drag, resize, menu bar interaction — and that the
React/Next bundle inside is fast enough once it's running. PR #52's
production-build wins should already cover most of it, so the bar
for "Phase 1a was worth it" is high.

Things to actively check, not just notice:

- **Window drag / resize.** Smooth in SwiftUI vs the Tauri build?
- **App launch from cold start.** Time to first paint of the chat UI.
- **Mid-session sidecar drop.** Documented Phase 1a tradeoff: the
  WebView is torn down on online → offline → online, losing scroll /
  form input / focus. Has it actually bitten? Once a week? Daily?
- **Memory footprint over a long session** (`Activity Monitor`).
- **Keyboard shortcuts** that the web app handles (⌘K, ⌘B/G/J/P,
  ⌘⇧N, ⌘., `?`). Do they all still work inside the WebView?
- **Right-click → Inspect Element** in DEBUG builds (Phase 1a wires
  `developerExtrasEnabled`). Useful when something breaks.

## Observations

_Append dated entries below. Older entries stay; this isn't a
changelog, it's a notebook._

<!-- Template:
### YYYY-MM-DD
- {what happened, where, how often}
-->

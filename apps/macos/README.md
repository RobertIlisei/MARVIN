# apps/macos — SwiftUI native macOS target

Native SwiftUI/AppKit macOS app, built incrementally per
[ADR-0016](../../docs/decisions/0016-swift-migration.md). The Node
sidecar at `apps/web` (Next.js + Agent SDK + all `/api/*` routes)
stays unchanged and is accessed via HTTP/SSE on `localhost:3030`.
This is the "shell migrates, brain stays" shape.

**Status:** Phases 1a/1b/1c shipped. Window opens, polls `/api/health`,
and on `online` hands the entire content area to a `WKWebView`
pointed at the Node sidecar. Native menu bar (View → Reload ⌘R /
Force Reload ⇧⌘R, Help → GitHub / Issues) and window-state
restoration via `NSWindow.frameAutosaveName` are wired in. Phase 1d
(NSToolbar — replaces the web-rendered top bar) needs a coordinated
change in `apps/web` and is the next bridge decision; deliberately
held until the daily-use evaluation argues for it. See
[PHASE-1A-OBSERVATIONS.md](./PHASE-1A-OBSERVATIONS.md).

For the dev loop, prerequisites, and `bin/marvin install-macos-app`,
see [BUILD.md](./BUILD.md).

## What this is

A real `.app` written in Swift, replacing the Tauri webview shell
([ADR-0010](../../docs/decisions/0010-desktop-wrapper-tauri.md)) for
the macOS target. The Node sidecar is the trust boundary —
credentials, the Claude CLI spawn, session transcripts, the confirm
gate, all stay in Node. The Swift process is just a window.

## What this is NOT

- **Not a fork of `apps/web`.** Both targets run the same backend.
- **Not a Tauri replacement on Windows / Linux.** SwiftUI is
  macOS-only; `apps/desktop/` (Tauri) continues to be the
  cross-platform answer.
- **Not a from-scratch rewrite of the Anthropic agent loop.** That
  stays in `packages/runtime`.

## File layout

```
apps/macos/
├── README.md             # this file
├── BUILD.md              # dev loop + prereqs + xcodebuild commands
├── Package.swift         # SPM manifest — `swift build` smoke check
├── project.yml           # xcodegen — source of truth for .xcodeproj
├── .gitignore            # ignores generated .xcodeproj + build dirs
└── MARVIN/
    ├── MARVINApp.swift       # @main, scenes, menu bar commands
    ├── ContentView.swift     # connecting / online (WebView) / offline
    ├── AboutView.swift       # About panel — app + live sidecar info
    ├── HealthMonitor.swift   # /api/health poller, state machine
    ├── WebView.swift         # NSViewRepresentable wrapping WKWebView
    ├── Bridge.swift          # JS↔Swift message channel (window.marvinShell)
    └── Info.plist            # bundle metadata, ATS, deployment target
```

`MARVIN.xcodeproj/` is `.gitignore`-d — regenerated cleanly from
`project.yml` via `xcodegen generate` (run once after clone). See
BUILD.md for the rationale.

## Migration phases (overview)

See [ADR-0016 — Migration phases](../../docs/decisions/0016-swift-migration.md#migration-phases)
for the full table. Short version:

- **Phase 0 — Scaffolding** ✅
- **Phase 1a — WebView island** ✅ — full-bleed `WKWebView` for the
  `.online` state; web app renders unchanged.
- **Phase 1b — Native menu bar** ✅ — View / Help with Reload ⌘R,
  Force Reload ⇧⌘R, GitHub / Issues. Web-app shortcuts (⌘K, ⌘B/G/J/P,
  ⌘⇧N, ⌘., `?`) deliberately not claimed here — they pass through to
  the WebView.
- **Phase 1c — Window-state restoration + custom About** ✅ —
  `NSWindow.frameAutosaveName` via a `WindowAccessor` bridge, plus a
  custom About panel that surfaces live sidecar info from
  `HealthMonitor` (auth mode, model, data dir) so the migration
  evaluation makes "which build am I in" obvious at a glance.
- **Phase 1d — NSToolbar (in flight)** — unified title bar now hosts
  a connection-status pip + `connecting/online/offline` label
  (clickable to re-probe), and the native NSWindow title mirrors
  the web app's `document.title` via the bridge (so the v1.2 `(N)`
  pending-confirm badge surfaces in the title bar even when the
  WebView is scrolled or another app is focused). Future 1d work:
  pick which web top-bar controls graduate to native (project
  picker? cost pill? model picker?) and add their bridge messages.

### Bridge groundwork (shipped alongside Phase 1c)

`MarvinBridge` (Swift) + `apps/web/src/lib/marvin-shell.ts` (TS) are
the JS↔Swift message channel that everything from Phase 1d on
needs. Single channel named `marvin`; messages are
`{ type: string, payload?: object }`. The Swift side logs unknown
types and routes known ones in `Bridge.swift`'s `handle(_:)`. The
web side calls `postToShell({ type, payload })` and reads
`isSwiftShell()` for branching. Today it carries one message
(`hello` on mount, for end-to-end verification); future phases
extend the dispatch table.
- **Phase 2 — Chat surface:** native chat list + ChatInput.
- **Phase 3 — File tree + Source Control:** native NSOutlineView +
  diff viewer.
- **Phase 4 — Brain:** port BrainLiquid to MetalKit, off the main
  thread.
- **Phase 5 — Embedded surfaces:** Monaco + xterm + graph go native.
- **Phase 6 — Tauri retire:** single `.app` artefact, ADR-0010
  superseded.

Each phase is independently shippable. The honest expected value of
Phase 1 alone is large — most felt-laggy moments are at the shell
layer (drag / resize / menu bar). Phase 1+ is gated on the
post-PR-#52 perf re-evaluation.

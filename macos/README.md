# macos — SwiftUI native macOS target

Native SwiftUI/AppKit macOS app. The Node sidecar at `sidecar/` (Next.js
+ Agent SDK + all `/api/*` routes) is accessed via HTTP/SSE on
`localhost:3030`. This is the "shell migrates, brain stays" shape from
[ADR-0016](../docs/decisions/0016-swift-migration.md); the WebView
removal that completed it is captured in
[ADR-0021](../docs/decisions/0021-webview-removal-fully-native-swift.md).

**Status:** fully native. Chat, file tree, source-control, embedded
preview surfaces (Monaco, xterm, graph), and the brain visualisation
all run in Swift. There is no `WKWebView` and no `apps/web` shell —
every UI surface is AppKit / SwiftUI / MetalKit.

For the dev loop, prerequisites, and `bin/marvin install-macos-app`, see
[BUILD.md](./BUILD.md). End users install via Homebrew:
`brew tap RobertIlisei/marvin && brew install --cask marvin-ai`.

## What this is

A real `.app` written in Swift. The Node sidecar is the trust boundary —
credentials, the Claude CLI spawn, session transcripts, the confirm
gate, all stay in Node. The Swift process owns the entire UI.

## What this is NOT

- **Not cross-platform.** SwiftUI + AppKit means macOS only. There is
  no Windows or Linux build path — the project deliberately retired its
  Tauri target.
- **Not a from-scratch rewrite of the Anthropic agent loop.** That
  stays in `sidecar/packages/runtime/`.
- **Not a WebView shell.** Earlier phases of the migration ran a
  `WKWebView` against the sidecar's UI; ADR-0021 retired that island.

## File layout

```
macos/
├── README.md                # this file
├── BUILD.md                 # dev loop + prereqs + xcodebuild commands
├── Package.swift            # SPM manifest — `swift build` / `swift test`
├── project.yml              # xcodegen — source of truth for .xcodeproj
├── .gitignore               # ignores generated .xcodeproj + build dirs
├── MARVIN/                  # main app target — views, services, bridges
├── MARVINLogic/             # pure-logic library (testable, no AppKit)
└── MARVINTests/             # swift test target
```

`MARVIN.xcodeproj/` is `.gitignore`-d — regenerated cleanly from
`project.yml` via `xcodegen generate` (run once after clone). See
BUILD.md for the rationale.

## Architecture in one diagram

```
MARVIN.app  ──HTTP/SSE──▶  localhost:3030  (sidecar/, spawned by the SwiftUI process)
        │                         │
        │                         └── packages/runtime  (Claude CLI, sessions, cost,
        │                                                project context, personality)
        │
        └── MARVINLogic         (pure-logic, swift-test-able)
            MARVIN/             (views, services, NativePrefs, bridges)
```

The sidecar is bundled inside `MARVIN.app/Contents/Resources/` (Node 22.11.0
darwin-arm64 + the Next standalone tree) and spawned by the SwiftUI process on
launch — see [ADR-0023](../docs/decisions/0023-brew-distributable-bundled-sidecar.md).
A launchd user agent is still available as an opt-in path via
`bin/marvin install-macos-app --launchd`.

# apps/macos — SwiftUI native macOS target (in progress)

This directory will hold the native SwiftUI/AppKit macOS app, built incrementally per [ADR-0016](../../docs/decisions/0016-swift-migration.md). It currently contains **only this README** — actual Swift code lands once the open questions in the ADR are answered.

## What this is

A real `.app` written in Swift, replacing the Tauri webview shell ([ADR-0010](../../docs/decisions/0010-desktop-wrapper-tauri.md)) for the macOS target. The Node sidecar at `apps/web` (Next.js + Agent SDK + all `/api/*` routes) is kept as-is and accessed via HTTP/SSE on `localhost:3030`. This is the "shell migrates, brain stays" shape.

## What this is NOT

- **Not a fork of `apps/web`.** Both targets run the same backend.
- **Not a Tauri replacement on Windows / Linux.** SwiftUI is macOS-only; `apps/desktop/` (Tauri) continues to be the cross-platform answer.
- **Not a from-scratch rewrite of the Anthropic agent loop.** That stays in `packages/runtime`.

## Status

Phase 0 (scaffolding) is queued. Before it starts, [ADR-0016](../../docs/decisions/0016-swift-migration.md) needs sign-off on:

1. Xcode project vs Swift Package Manager
2. Minimum macOS version (proposed: macOS 14 Sonoma)
3. Code signing / notarization config (Team ID, certificate, notarization profile)
4. SwiftUI vs AppKit boundary for dense surfaces (file tree, chat list)
5. Whether to revisit after PR #52's perf wins land in production — the migration may be unnecessary if Tier 1 + 2 close the gap

Once those are answered, this directory will gain (in order):

- `MARVIN.xcodeproj/` (or `Package.swift` if SPM wins)
- `MARVIN/` — SwiftUI app source
- `MARVINTests/` — XCTest target
- `Resources/` — assets, icons, plist
- A `BUILD.md` documenting `xcodebuild` / `bin/marvin install-macos-app` flow

## Migration phases (overview)

See [ADR-0016 — Migration phases](../../docs/decisions/0016-swift-migration.md#migration-phases) for the full table. Short version:

0. Scaffolding — empty SwiftUI app, builds, opens a window
1. Frame — native `NSSplitView` + toolbar + menu bar; web app loads inside a single WKWebView island
2. Chat surface — native chat list + ChatInput; tool-use cards keep WKWebView for Monaco
3. File tree + Source Control — native `NSOutlineView` + diff viewer
4. Brain — port to MetalKit, off the main thread
5. Embedded surfaces — Monaco + xterm + graph go native
6. Tauri retire — single `.app` artefact, Tauri target removed

Each phase is independently shippable.

## Sidecar contract

The Node process at `apps/web` (port 3030) is the public contract. The Swift app:

- Pings `/api/health` on launch, surfaces a coherent error if it's not up
- Launches the sidecar via `bin/marvin start` if missing (or relies on the launchd agent installed by `bin/marvin install-app`)
- Connects to `/api/chat` (SSE), `/api/sessions/*`, `/api/projects/*`, `/api/git/*`, `/api/files/*`, `/api/graph/*`, `/api/terminal/run` for everything else

Credentials stay where they are (`~/.claude/.credentials.json` / Keychain). The Swift process never reads them — the Node sidecar is the only thing that calls Anthropic.

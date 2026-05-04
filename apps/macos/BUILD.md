# Building the MARVIN macOS app (Phase 0)

This is the dev loop for the SwiftUI native target that lives at
`apps/macos/`. Phase 0 boots a single window, polls the Node sidecar at
`http://localhost:3030/api/health`, and renders connecting / online /
offline. Phase 1+ replaces the placeholder view with a real
`WKWebView` island (and later, native panes).

See [ADR-0016](../../docs/decisions/0016-swift-migration.md) for the
full migration plan + the resolved decisions behind every choice
below.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Xcode 16+** | Builds the `.app` bundle, signs it, runs SwiftUI Previews. macOS 14 Sonoma minimum is set in `project.yml`. | App Store → Xcode |
| **Command Line Tools** | Provides `swift` for the SPM smoke check (no `.app`, just compile). | `xcode-select --install` |
| **xcodegen** | Regenerates `MARVIN.xcodeproj` from `project.yml`. The generated project is gitignored — every contributor produces their own copy. | `brew install xcodegen` |

## First-time setup on a fresh clone

```bash
cd apps/macos
xcodegen generate         # produces MARVIN.xcodeproj from project.yml
open MARVIN.xcodeproj     # opens in Xcode — Build/Run from there (⌘R)
```

The generated `MARVIN.xcodeproj` is `.gitignore`-d. Re-run
`xcodegen generate` whenever `project.yml` changes (file added /
removed / settings tweaked); Xcode picks up the new project on next
open.

## Day-to-day

### Smoke compile (no Xcode required)

```bash
cd apps/macos
swift build               # ~2 s clean, much faster incremental
```

This uses `Package.swift` and only verifies the Swift compiles; it
does NOT produce a runnable `.app`. Useful when you've only got
Command Line Tools, or as a CI gate.

### Run the actual app

```bash
cd apps/macos
xcodegen generate         # if project.yml changed since last time
xcodebuild \
  -project MARVIN.xcodeproj \
  -scheme MARVIN \
  -configuration Debug \
  -derivedDataPath build \
  build
open build/Build/Products/Debug/MARVIN.app
```

Or just open `MARVIN.xcodeproj` in Xcode and hit ⌘R. Xcode is faster
on incremental builds and gives you live SwiftUI previews.

`bin/marvin install-macos-app` (from the repo root) automates the
xcodegen + xcodebuild + install steps for end-users; see below.

### Install as a real Application

```bash
bin/marvin install-macos-app    # builds Release, installs to /Applications/
```

Mirrors the existing Tauri-side `install-app` command. Phase 0 ships
ad-hoc signing — Gatekeeper warns on first open (right-click →
Open). Real Developer ID + notarization gets wired at the end of
Phase 1 once a signing identity is plumbed in.

## Architecture

The Swift app is a pure UI layer. The Node sidecar (`apps/web` +
`packages/runtime`) is the backend, accessed via HTTP on
`localhost:3030`. The `.app` never reads Anthropic credentials,
never spawns the Claude CLI, never persists session transcripts —
all of that stays in Node. See ADR-0016 for the rationale.

```
MARVIN.app  ──HTTP/SSE──▶  localhost:3030  (apps/web, started by bin/marvin)
```

Phase 0 only uses `/api/health` for the connection probe. Phase 1
adds a `WKWebView` that loads the same `localhost:3030` and renders
the existing web UI. Phases 2–6 progressively replace web islands
with native AppKit/SwiftUI views.

## File layout

```
apps/macos/
├── BUILD.md                 # this file
├── README.md                # high-level overview + status
├── Package.swift            # SPM manifest (smoke compile only)
├── project.yml              # xcodegen — source of truth for .xcodeproj
└── MARVIN/
    ├── MARVINApp.swift      # @main entry, Window scene, command bar
    ├── ContentView.swift    # Phase 0 placeholder view (connecting/online/offline)
    ├── HealthMonitor.swift  # /api/health poller, connection state machine
    └── Info.plist           # bundle metadata, ATS config, deployment target
```

`MARVIN.xcodeproj/` (when generated) is `.gitignore`-d.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `swift build` fails with "PreviewsMacros not found" | You're running outside Xcode and added a `#Preview` block | Wrap the preview in a comment block (or run via Xcode); see `ContentView.swift` note. |
| Window stays in "connecting…" forever | `bin/marvin start` isn't running, or it's bound to a different port | `curl http://localhost:3030/api/health` should return JSON. If not, run `bin/marvin start` from the repo root. |
| Gatekeeper "MARVIN is damaged" on first open | Ad-hoc-signed app; macOS doesn't trust it | Right-click → Open → confirm. One-time per build. |
| `xcodebuild` complains "no such file: MARVIN.xcodeproj" | You haven't run `xcodegen generate` yet | Run it from `apps/macos/`. |

## What Phase 0 deliberately does NOT do

- Load the web app — that's Phase 1.
- Replace the Tauri build (`apps/desktop/`) — both targets coexist until Phase 6.
- Bundle Node — the sidecar still runs separately. ADR-0011 territory.
- Cross-platform — macOS only. Windows / Linux stay on Tauri.
- Real signing — ad-hoc only until end of Phase 1.

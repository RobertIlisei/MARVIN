# Building the MARVIN macOS app (Phase 1a)

This is the dev loop for the SwiftUI native target that lives at
`apps/macos/`. Phase 1a boots a window with three states wired to a
sidecar health probe: connecting / online (full-bleed `WKWebView`
pointed at the Node sidecar) / offline. Phases 1b–6 progressively
replace pieces of the WebView with native AppKit / SwiftUI views.

See [ADR-0016](../../docs/decisions/0016-swift-migration.md) for the
full migration plan + the resolved decisions behind every choice
below.

## Prerequisites

There are two viable build paths — pick whichever matches what's
already on your machine.

### Path A — full Xcode (preferred for shipping)

| Tool | Why | Install |
|---|---|---|
| **Xcode 16+** | Builds a real `.app` with full Xcode warnings, scheme support, and the eventual signing/notarization wiring. macOS 14 Sonoma minimum is set in `project.yml`. | App Store → Xcode |
| **xcodegen** | Regenerates `MARVIN.xcodeproj` from `project.yml`. The generated project is gitignored — every contributor produces their own copy. | `brew install xcodegen` |

### Path B — Command Line Tools only (fallback, no Xcode)

| Tool | Why | Install |
|---|---|---|
| **Command Line Tools** | Provides `swift` for the SPM build path. `bin/marvin install-macos-app` falls back to this when Xcode isn't installed; produces an ad-hoc-signed `.app` good enough for daily local use, just no Xcode-side IDE features. | `xcode-select --install` |

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
# 1) Build + install the .app (Release, ad-hoc signed).
bin/marvin install-macos-app

# 2) Start the Node sidecar — the .app polls /api/health and won't
#    leave the "connecting…" screen until the sidecar is up.
bin/marvin start

# 3) Launch the .app.
open /Applications/MARVIN-Swift.app
```

Installs as **MARVIN-Swift.app**, distinct from the Tauri build at
`/Applications/MARVIN.app`. Both coexist during the migration
evaluation period; Phase 6 (Tauri retire) renames this to
`MARVIN.app` and uninstalls the Tauri one.

After step 3 you should see:

- A **Brain Circuit icon** on the Dock and in `/Applications/`
  (`AppIcon.icns`, indigo gradient on rounded corners).
- A **menu-bar status item** with the same Brain Circuit shape (in
  template form — black on light bars, white on dark). Left-click
  brings the window forward; right-click opens Show / About /
  Settings… / Quit.

> **Can't see the menu-bar icon?** On MacBooks with the notch the OS
> sometimes places new status items in the (invisible) overflow
> region to the right of the notch. ⌘-drag the icon along the menu
> bar to a permanent slot and it'll stick — `autosaveName` persists
> the position across launches. If you use Bartender, Hidden Bar, or
> similar, check that MARVIN isn't in the hidden tray.

The script picks its build path automatically:

- If `xcodebuild` and `xcodegen` are both available → xcodegen +
  xcodebuild + copy to /Applications.
- Otherwise → `swift build -c release`, manual bundle assembly
  (executable + substituted `Info.plist` + ad-hoc `codesign`).

Phase 1a uses ad-hoc signing either way — Gatekeeper warns on first
open (right-click → Open). Real Developer ID + notarization gets
wired at the end of Phase 1 once a signing identity is plumbed in.

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
    ├── ContentView.swift    # connecting / online (WebView) / offline states
    ├── HealthMonitor.swift  # /api/health poller, connection state machine
    ├── WebView.swift        # NSViewRepresentable wrapping WKWebView
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

## What Phase 1a deliberately does NOT do

- Render anything natively beyond the connecting/offline shells —
  `.online` is a single full-bleed WebView. Native chat / file tree /
  diff viewer land in Phases 2–5.
- Replace the Tauri build (`apps/desktop/`) — both targets coexist
  until Phase 6.
- Bundle Node — the sidecar still runs separately. ADR-0011 territory.
- Cross-platform — macOS only. Windows / Linux stay on Tauri.
- Real signing — ad-hoc only until end of Phase 1.
- Survive a mid-session sidecar drop without flicker — every online
  → offline → online transition tears down the WebView and loses
  scroll / form / focus. Documented tradeoff (`ContentView.swift`);
  re-evaluate if it bites in practice.

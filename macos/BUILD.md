# Building the MARVIN macOS app

Dev loop for the SwiftUI native target at `macos/`. The app is fully
native (no WebView) and talks to the Next.js sidecar at `sidecar/` over
HTTP/SSE on `localhost:3030`. See
[ADR-0016](../docs/decisions/0016-swift-migration.md) for the migration
rationale and [ADR-0021](../docs/decisions/0021-webview-removal-fully-native-swift.md)
for the WebView-retirement decision.

> **For end users.** The one-liner installer at `scripts/install.sh`
> handles everything in this doc — toolchain bootstrap, build, install
> to `/Applications`, and the launchd sidecar agent. This file is for
> developers building MARVIN from a working clone.

## Prerequisites

Two viable build paths — pick whichever matches what's on your machine.

### Path A — full Xcode (preferred for shipping)

| Tool | Why | Install |
|---|---|---|
| **Xcode 16+** | Builds a real `.app` with full warnings, scheme support, and the eventual signing/notarization wiring. macOS 14 Sonoma minimum is set in `project.yml`. | App Store → Xcode |
| **xcodegen** | Regenerates `MARVIN.xcodeproj` from `project.yml`. The generated project is gitignored — every contributor produces their own copy. | `brew install xcodegen` |

### Path B — Command Line Tools only (fallback, no Xcode)

| Tool | Why | Install |
|---|---|---|
| **Command Line Tools** | Provides `swift` for the SPM build path. `bin/marvin install-macos-app` falls back to this when Xcode isn't installed; produces an ad-hoc-signed `.app` good enough for daily local use, just no Xcode-side IDE features. | `xcode-select --install` |

## First-time setup on a fresh clone

```bash
cd macos
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
cd macos
swift build               # ~2 s clean, much faster incremental
```

Uses `Package.swift` and only verifies the Swift compiles; it does NOT
produce a runnable `.app`. Useful when you've only got Command Line
Tools, or as a CI gate.

### Run the unit tests

```bash
cd macos
swift test                # MARVINLogic + MARVINTests targets
```

### Run the actual app from Xcode

```bash
cd macos
xcodegen generate         # if project.yml changed since last time
xcodebuild \
  -project MARVIN.xcodeproj \
  -scheme MARVIN \
  -configuration Debug \
  -derivedDataPath build \
  build
open build/Build/Products/Debug/MARVIN.app
```

Or just open `MARVIN.xcodeproj` in Xcode and hit ⌘R. Xcode is faster on
incremental builds and gives you live SwiftUI previews.

`bin/marvin install-macos-app` (from the repo root) automates xcodegen +
xcodebuild + install for end users; see below.

### Install as a real Application

```bash
# 1) Build + install the .app (Release, ad-hoc signed).
bin/marvin install-macos-app

# 2) Start the Node sidecar — the .app polls /api/health and won't
#    leave the "connecting…" screen until the sidecar is up.
bin/marvin start

# 3) Launch the .app.
open /Applications/MARVIN.app
```

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
  xcodebuild + copy to `/Applications`.
- Otherwise → `swift build -c release`, manual bundle assembly
  (executable + substituted `Info.plist` + ad-hoc `codesign`).

Ad-hoc signing means Gatekeeper warns on first open (right-click →
Open). Real Developer ID + notarization is a separate body of work; not
required for daily local use.

## Architecture

The Swift app is the entire UI. The Node sidecar (`sidecar/`) is the
backend, accessed via HTTP/SSE on `localhost:3030`. The `.app` never
reads Anthropic credentials, never spawns the Claude CLI, never persists
session transcripts — all of that stays in Node. See ADR-0016 for the
rationale.

```
MARVIN.app  ──HTTP/SSE──▶  localhost:3030  (sidecar/, started by bin/marvin)
```

## File layout

```
macos/
├── BUILD.md                 # this file
├── README.md                # high-level overview + status
├── Package.swift            # SPM manifest (smoke compile + swift test)
├── project.yml              # xcodegen — source of truth for .xcodeproj
├── MARVIN/                  # main app target (SwiftUI / AppKit views,
│                            # services, native bridges)
├── MARVINLogic/             # pure-logic library (no UIKit, no AppKit)
└── MARVINTests/             # swift test target
```

`MARVIN.xcodeproj/` (when generated) is `.gitignore`-d.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `swift build` fails with "PreviewsMacros not found" | You're running outside Xcode and added a `#Preview` block | Wrap the preview in a comment block (or run via Xcode); see `ContentView.swift` note. |
| Window stays in "connecting…" forever | `bin/marvin start` isn't running, or it's bound to a different port | `curl http://localhost:3030/api/health` should return JSON. If not, run `bin/marvin start` from the repo root. |
| Gatekeeper "MARVIN is damaged" on first open | Ad-hoc-signed app; macOS doesn't trust it | Right-click → Open → confirm. One-time per build. |
| `xcodebuild` complains "no such file: MARVIN.xcodeproj" | You haven't run `xcodegen generate` yet | Run it from `macos/`. |

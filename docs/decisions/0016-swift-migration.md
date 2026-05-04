# ADR-0016 — Native macOS app via SwiftUI (incremental migration)

**Status:** Proposed
**Date:** 2026-05-04
**Deciders:** @robertilisei, MARVIN

## Context

[ADR-0010](./0010-desktop-wrapper-tauri.md) shipped a Tauri 2 wrapper around the existing `localhost:3030` web shell. That gave us a real `.app`, dock icon, menu bar, and `.dmg` build pipeline at zero cost to feature parity — every UI surface stayed in one place (Next.js).

Field experience after ~2 weeks of daily use surfaced friction the wrapper can't fix from inside the WebView:

- **Drag and resize feel laggy.** `react-resizable-panels` drag triggers re-renders down the React tree. Even with the Tier 2 fixes from PR #52 (memoize `BrainLiquid` / `VirtualMessageList`, pause the brain rAF during drag), it's still web-grade smoothness, not AppKit-grade.
- **The brain animation eats main-thread time.** 12 000 particles per frame on a 510×510 canvas, in a single-threaded JS context, on the same thread as React reconciliation. OffscreenCanvas + Worker would help but adds complexity and still isn't free.
- **Window chrome.** Title bar styling, traffic-light positioning, transparent vibrancy effects, NSWindow restoration, native menu bar shortcuts — the WebView fakes most of these and doesn't always nail it.
- **Per-process memory.** A WKWebView instance running React + Monaco + Three.js-class canvas + xterm carries ~250–400 MB of RSS. Native AppKit views measure in tens of MB.
- **System integration.** Quick Look, Spotlight indexing of session transcripts, Continuity Camera, drop-target metadata, Touch ID auth for confirm-gate — possible from web only via narrow Tauri capabilities; first-class in AppKit.

Tier 1 of the perf work (production build by default, [PR #52](https://github.com/RobertIlisei/MARVIN/pull/52)) restored most of the dev-mode-induced lag. Tier 2 (memoization + drag-time rAF gating) cleaned up the rest of the visible jitter. Tier 3 (battery / `saveData` gating) is deferred. **If the app feels native-grade after Tier 1 + 2 land in production**, the SwiftUI migration is unnecessary cost; the right move is to revisit this ADR rather than accelerate it. **If it doesn't**, this ADR scopes the answer.

## Decision (Proposed)

Add a SwiftUI macOS target at `apps/macos/` and migrate the app to it incrementally, in phases — not as a Big Bang rewrite. The Node runtime (`packages/runtime` + Next.js API routes at `apps/web/src/app/api/*`) stays unchanged: it remains the brain of the operation, accessed via HTTP from the SwiftUI process. The web frontend at `apps/web` stays alive for as long as we have surfaces that haven't been ported yet — `apps/macos` and `apps/web` co-exist.

This is the "ship of Theseus" migration shape, not a fork.

### Architectural shape

```
┌─────────────────────────────────────────────────────────┐
│                   SwiftUI App (apps/macos)              │
│                                                         │
│   • NSWindow / Split views / Toolbar / Menu bar         │
│   • Native chat surface, file tree, diff viewer         │
│   • SceneKit/MetalKit BrainLiquid (or WKWebView island) │
│   • WKWebView islands for Monaco, xterm, graph iframe   │
│     until those have native equivalents                 │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP / SSE on localhost:3030
                   ▼
┌─────────────────────────────────────────────────────────┐
│         Existing Next.js sidecar (apps/web)             │
│         (started by `bin/marvin start`)                 │
│                                                         │
│   • All /api/* routes — chat, sessions, git, graph,     │
│     terminal, file tree, models, projects, honeycomb    │
│   • Agent SDK runner, confirm registry, cost tracker,   │
│     project context injection, graphify bridge          │
│   • Stays exactly as-is during migration                │
└─────────────────────────────────────────────────────────┘
```

The sidecar already exists, fully tested, and is the trust boundary for the Agent SDK. No reason to rewrite it in Swift; the boundary HTTP/SSE is already its public contract.

### Migration phases

Each phase ships independently. The user can keep using the Tauri build until the SwiftUI app reaches phase parity for their workflow.

| Phase | Scope | Definition of Done |
|---|---|---|
| **0 — Scaffolding** | Empty SwiftUI app at `apps/macos/`. Xcode project. Boots, shows an empty NSWindow with the right title, menu bar, dock icon. CI builds the `.app`. Dev loop documented. | `xcodebuild` produces a runnable `.app`; `bin/marvin install-macos-app` (new) installs it; window opens to a "connecting…" placeholder that pings `/api/health`. |
| **1 — Frame** | Native NSWindow, `NSSplitView`-based 3-pane layout (left files / center work / right side), toolbar, menu bar with native shortcuts (⌘B/G/J/P pane toggles, ⌘K command palette, ⌘. cancel, ⌘N new session). Whole shell native; the chat / file tree / brain still load in **a single WKWebView island** filling the center. | Drag/resize feels native; menu bar shortcuts work; window state persists across launches. The web app still renders inside the WKWebView for everything below the shell. |
| **2 — Chat surface** | Native chat list (`NSCollectionView` + diffable data source), native ChatInput (multi-line `NSTextView` with proper IME), SSE consumer in Swift driving the data source. Tool-use cards still embed WKWebView islands for Monaco diffs and code blocks. | Streaming a turn is glassy at 60 fps with 0 dropped frames during chat append. The brain (still WKWebView island) is unaffected. |
| **3 — File tree + Source Control** | Native `NSOutlineView` for files; native diff viewer ([`Difference`](https://developer.apple.com/documentation/foundation/) or a small custom view); native source-control panel. The git mutation API (`/api/git/*`) is unchanged. | DnD into Finder works; Quick Look on tree rows works; staging / unstaging / commit feel like Xcode's source-control UI. |
| **4 — Brain animation** | Port `BrainLiquid` to MetalKit. Same `PROFILES` table, same lerp logic, same `pulseResize` signal, but the render runs on the GPU off the main thread. Lab refresh procedure stays the same: drive `Brain Lab _standalone_.html`, extract values, paste into Swift's `Profile` struct. | Brain runs at 60 fps with N=12000 + RENDER_SCALE=1.5 with no visible main-thread interaction. The WKWebView island is removed from the center pane. |
| **5 — Embedded surfaces** | Monaco → native ([`STTextView`](https://github.com/krzyzanowskim/STTextView) or AppKit text view + tree-sitter-swift). Terminal → native (`NSTerminalView` via [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)). Graph → SwiftUI/SceneKit (or stay WKWebView; lower priority). | Tool-use cards no longer instantiate WKWebView; xterm.js no longer ships in the bundle. |
| **6 — Tauri retire** | Once Phase 5 lands, the Tauri target at `apps/desktop/` can be retired. `bin/marvin install-app` repointed to the SwiftUI build. ADR-0010 superseded. | Single `.app` artefact; `apps/web` still exists but only serves the API routes (it's a sidecar, not a UI). |

Phases are independent enough that we can stop after any of them and still have a usable product. The honest expected value of Phase 1 alone is large — most of the felt-laggy moments are at the shell layer (drag / resize / menu bar). The deeper phases gain less per phase.

### Cross-cutting concerns

- **Sidecar lifecycle.** The Swift app launches `bin/marvin start` if `localhost:3030` isn't responding, mirrors `bin/marvin status` checks, surfaces a coherent error if Node / pnpm aren't installed. The launchd agent installed by `bin/marvin install-app` continues to manage the sidecar; the Swift app just connects to it.
- **Auth + credentials.** Credentials stay where they are (`~/.claude/.credentials.json` / Keychain). The Swift app doesn't need them — the Node sidecar is the only thing that calls Anthropic.
- **Theme.** OKLCH tokens stay in `apps/web/src/app/globals.css` as long as WKWebView islands exist; the Swift app reads NSAppearance and maps to the same palette via a tiny shared JSON.
- **Cross-platform.** SwiftUI is macOS-only. Tauri continues to be the answer on Windows / Linux for as long as those targets matter. ADR-0010's Tauri build stays in the repo until Phase 6.

### Open questions (decisions blocked behind these)

1. **Xcode project vs Swift Package Manager.** Xcode project is the path of least resistance for AppKit + SwiftUI macOS apps and gives us the entitlements / signing / notarization plumbing for free. SPM gives a cleaner CI story and version-control-friendly project files but needs a separate Xcode-shim for app bundles. **Default:** Xcode project under `apps/macos/MARVIN.xcodeproj`. Override only if SPM materially helps.
2. **Minimum macOS version.** macOS 14 Sonoma (released Sep 2023) gives us the new SwiftUI windowing APIs (`Settings`, `Window`, `WindowGroup` improvements) and `NSSplitViewController` modernizations. macOS 13 Ventura is the older floor and would skip some niceties. **Default:** macOS 14. **User input wanted.**
3. **Code signing / notarization.** Right now the Tauri build signs with the user's apple-id by way of `tauri build`. Swift will need its own signing config (`DEVELOPER_TEAM_ID`, certificate, notarization). **User input wanted** — this is a real-world cred I won't guess at.
4. **SwiftUI vs AppKit ratio.** SwiftUI is fast to build but still has rough edges around `NSOutlineView`-class density (file tree) and `NSCollectionView`-class virtualization (chat list). The plan above uses AppKit where SwiftUI is weak (file tree, chat list) and SwiftUI everywhere else. **Default:** hybrid as described.
5. **Sidecar packaging.** Eventually we'd want the Node sidecar bundled inside the `.app` so users don't need a separate `bin/marvin start`. That's [ADR-0011](./0011-sidecar-node-bundling.md) territory and is deliberately out of scope for this ADR.

## Alternatives considered

- **Stay on Tauri + push perf harder.** OffscreenCanvas + Web Worker for the brain, react-window for the chat list, wasm-side syntax highlighting, etc. Each fix is a few days of work; cumulatively maybe 2 weeks. **Why not chosen:** the trajectory points at progressively diminishing returns — every fix gets us 80% of native, never the last 20%. The window chrome / native menu bar / system integration items can't be fixed at all from inside a WebView.
- **Electron rewrite.** Strictly worse than Tauri (~10× the bundle, slower cold start, same web-stack ceiling). No.
- **Native rewrite from scratch (no sidecar, Swift Anthropic SDK).** Doable but very expensive (Swift Anthropic SDK doesn't exist in a maintained form; we'd own a lot of HTTP + SSE plumbing + tool-use loop in Swift). The Node sidecar already exists, is tested, and is the trust boundary. **Why not chosen:** months of duplicative work for no user-visible benefit beyond what the hybrid achieves.

## Consequences

**Positive:**

- Drag / resize / window management feel like a real macOS app.
- Brain animation can run at full GPU speed without competing for the main thread.
- Memory footprint drops substantially (no Chromium, eventually no WKWebView).
- System integration (Spotlight, Quick Look, Continuity, Touch ID) becomes possible.
- The Node sidecar is unchanged, so the security posture (confirm gate, user-initiated write channel, upload preflight, hard-deny patterns) stays exactly as audited.

**Negative:**

- Two app targets coexist for the duration of the migration (Tauri + Swift). Until Phase 6, every UI change has to land in both — or one side has to explicitly tag-out (we deliberately stop investing in the Tauri shell during Phase 2+).
- macOS-only: Windows / Linux users keep the Tauri build indefinitely.
- Build pipeline gets more complex (Xcode + Rust + Node) — `bin/marvin doctor` will need a `check_xcode` step.
- New skill domain (Swift / SwiftUI / AppKit). Honest about the learning curve.

**Reversal cost:** moderate. If we land Phase 1 (native shell + WKWebView island) and decide it's not worth continuing, we can either (a) keep Phase 1 as the default Mac build and stop investing in deeper phases, or (b) retire `apps/macos/` and continue on Tauri. Phases 2+ are harder to unwind because they delete code from `apps/web`.

## Scope of Done

For this ADR specifically (the **decision**, not the implementation):

- [ ] User has reviewed the phased plan and signed off on phases 0 and 1 as the immediate next work.
- [ ] User has answered the five open questions above (or explicitly deferred them).
- [ ] Status flips from `Proposed` → `Accepted`.
- [ ] Roadmap entry under `## In flight` referencing this ADR.
- [ ] Branch `feat/swift-migration` created with this ADR + the `apps/macos/` placeholder. _(this commit)_

The Phase 0 implementation is its own scope, captured in the table above.

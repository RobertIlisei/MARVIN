# ADR-0020 — Phase 5 native embedded surfaces: shape and sub-phases

**Status:** Accepted
**Decider:** Robert Ilisei
**Date:** 2026-05-05
**Supersedes:** _none_
**Superseded by:** _none_

## Context

[ADR-0016](./0016-swift-migration.md) sketches Phase 5 as one row: port
the embedded surfaces — Monaco editor, xterm.js terminal, graph view —
from the in-WebView versions to native Swift / AppKit / SwiftUI. With
Phase 4 shipped (ADR-0019), the inline pieces of MARVIN-Swift's main
window are now: native file tree + SCM panel (Phase 3), native chat
(Phase 2), native brain MTKView (Phase 4), and a WebView "work pane"
that still hosts the file viewer / terminal / preview / graph
surfaces.

Phase 5 retires the work-pane WebView one surface at a time. By the
end of Phase 5 the WebView either disappears entirely, or is reduced
to a tiny island that hosts only the graph (per ADR-0016 §5: graph is
"lower priority — or stay WKWebView"). Phase 6 then formally retires
the Tauri target.

ADR-0016's row doesn't spell out the sub-phase order, the dependency
on third-party Swift packages (STTextView, SwiftTerm), or the gates
between "side preview window" and "promoted inline" for each surface.
This ADR fills that gap, mirroring [ADR-0017](./0017-phase-2-chat-native.md)
for Phase 2, [ADR-0018](./0018-phase-3-files-source-control-native.md)
for Phase 3, and [ADR-0019](./0019-phase-4-brain-metalkit.md) for
Phase 4.

## Decision

### 1. Per-surface, not per-feature, sub-phasing.

The three embedded surfaces (editor, terminal, graph) have nothing
in common technically — different bundles, different Swift packages,
different keyboard / focus models. Sub-phasing per-feature ("first
all foundation, then all promotion") would entangle three unrelated
streams of work. Sub-phasing per-surface lets us ship editor before
touching terminal, and stop after any sub-phase still leaves the
shell usable (the WebView keeps rendering the un-ported surfaces).

The editor lands first because it's the highest-traffic surface
(every file the user opens). Terminal lands second. Graph lands
last — and may not land at all in Phase 5, see §3 below.

### 2. The WebView still owns un-ported surfaces.

Same gate that governed Phases 2g, 3d, 4g: the in-WebView surface
becomes `display: none` only when the native equivalent reaches
parity. Until then, the WebView is the user's working surface. This
prevents a half-shipped native editor (e.g. mid-tree-sitter) from
replacing the working Monaco editor.

### 3. Graph deferral is the default.

ADR-0016 §5 calls graph "lower priority; or stay WKWebView." The
graph view in the web app uses `cytoscape.js` — a custom layout
engine, hand-tuned community colouring, hand-tuned hover/click
interactions. Porting this to SwiftUI/SceneKit is a multi-week
effort for a surface most users see < 1% of the time. **Phase 5
explicitly defers a native graph port.** The WebView shrinks to a
graph-only island after the editor + terminal land natively. Phase 6
retires the Tauri shell either way; the WebView island remains for
graph rendering until a future ADR opts to port it.

### 4. Sub-phases (each independently shippable)

The phase order minimises risk of half-shipped surfaces. 5a–5b ship
a side-window preview the user can open without disturbing the live
WebView. 5c flips the gate. 5d–5f mirror that pattern for terminal.
5g/5h handle graph deferral + final WebView retirement scope.

| Sub-phase | Scope | Definition of Done |
|---|---|---|
| **5a — File viewer foundation** | `FileViewerView.swift` — `NSTextView`-backed read-only file viewer wrapped in `NSViewRepresentable`. Reads file content via `FilesService.fetchContent` (Phase 3a). Monospace `.system(size:design:.monospaced)`. Lives in a "File Viewer (preview)" Window scene during 5a; the file tree's selection drives both the WebView's Monaco AND the native preview, so a user can side-by-side them. | Selecting a file in the native tree opens it in the preview window with correct content, line endings preserved, scrollable. Binary files render a "binary file, N bytes" placeholder. |
| **5b — Editor surface** | Swap the AppKit `NSTextView` for [`STTextView`](https://github.com/krzyzanowskim/STTextView) — the current best-of-breed Swift text view that handles line numbers, soft wrap, and TextKit 2. Add tree-sitter-based syntax highlighting via [`SwiftTreeSitter`](https://github.com/ChimeHQ/SwiftTreeSitter) for the languages MARVIN's user base actually edits: Swift, TypeScript / JavaScript, Python, Go, Rust, Markdown. The package is added via SPM's `Package.swift` as a real dependency; the install script's SPM fallback path needs no changes (SPM resolves transitively). | Highlights every supported language correctly; theme colours match the WebView Monaco's tokens via a small shared JSON; line numbers render. Editor is still read-only. |
| **5c — Promote editor inline** | Tag the WebView's Monaco viewer with `data-marvin-monaco`; add `[data-host-shell="swift"] [data-marvin-monaco] { display: none }`. Promote the native viewer from the preview window into the WebView's work-pane file slot. The native viewer becomes the file viewer the user sees in MARVIN-Swift; the WebView still renders terminal / graph / preview. Editing capability (write + save) lands here too — `/api/files/write` already exists; viewer flips to writable mode with `⌘S` saving. | The native file viewer is the file viewer in MARVIN-Swift. ⌘S saves (POSTs to `/api/files/write`). Web / Tauri builds keep Monaco. |
| **5d — Terminal foundation** | Add [`SwiftTerm`](https://github.com/migueldeicaza/SwiftTerm) via SPM. `TerminalView.swift` — `LocalProcessTerminalView` (SwiftTerm's PTY-backed view) wrapped in `NSViewRepresentable`. Lives in a "Terminal (preview)" Window scene during 5d; spawns the user's `$SHELL` against the project workDir. No MARVIN integration yet — just a working terminal. | A bash / zsh prompt appears, accepts input, runs commands, scroll buffer works, ANSI colour works. ⌘C / ⌘V / ⌘+ font size all work. |
| **5e — Terminal session integration** | Hook into the same `/api/sessions/terminal/*` endpoints the WebView uses (one PTY per session, multiplexed). Multi-tab support inside the preview window. Resize the underlying PTY when the view size changes. | A MARVIN tool-call that runs `bash` shows up in the native terminal in real time; output streams; resize updates the PTY's `winsize`. The web terminal's content matches what the native terminal shows for the same session. |
| **5f — Promote terminal inline** | Tag the WebView terminal with `data-marvin-terminal`; CSS-hide it under `[data-host-shell="swift"]`. Promote the native terminal from the preview window into the WebView's work-pane terminal slot, alongside the native file viewer (5c). The user can ⌘ J the terminal as before; the pane just renders natively. | Running a terminal command during a turn shows native; the WebView no longer renders xterm.js content. Web / Tauri builds keep xterm.js. |
| **5g — Graph deferral** | Document the explicit non-port: graph stays as a WKWebView island. Tag the work-pane's non-graph surfaces (preview, future native pieces) with `data-marvin-non-graph`; CSS-hide *everything in the WebView except the graph* under `[data-host-shell="swift"]`. The WebView shrinks to a graph-only island. Net effect: when the user toggles ⌘ G, the WebView fills the work pane; otherwise it's `display: none`. | The WebView in MARVIN-Swift only renders when graph mode is active. CPU profiles show Chrome/WebKit dropping to near-zero when graph mode is off. |
| **5h — Final retirement scope** | Decide what stays in `apps/web`: the Next.js API routes for sure (sidecar pattern); the graph view (per 5g); and the landing page (boots the user into project picker). Delete the work-pane Monaco viewer, the xterm.js bundle, the BrainLiquid assets in the bundled JS (kept only for Tauri / web builds — verify the import graph), and any chat scaffolding that's now unused. Update `apps/web/package.json` to drop now-unused dependencies. | The MARVIN-Swift `.app` bundle's WebView-loaded JS is < 50% of the pre-Phase 5 size (rough target — exact number measured at the gate). Tauri / web builds still bundle Monaco + xterm.js + BrainLiquid as before. |

### 5. Out of scope for Phase 5

These are real but later (or deliberately not native at all):

- **Native graph view.** Per §3 above and ADR-0016 §5; revisit
  in a future phase if the graph experience becomes a daily-use
  surface for a meaningful user fraction.
- **Multi-pane editor (split / tabs).** The web Monaco viewer
  shows one file at a time; we match that. Tabbed editing is a
  separate ADR if it ever becomes a goal — not part of Phase 5.
- **Custom syntax highlighting beyond the tree-sitter languages.**
  The 6 languages in 5b cover what MARVIN's users actually edit
  (Swift / TS / JS / Py / Go / Rust + Markdown). Anything else
  falls back to plain-text rendering until a user explicitly
  asks for a new language.
- **Vim mode / Emacs bindings / keybinding customization.**
  STTextView ships AppKit standard bindings; that's the contract.
  Re-bindable keymaps are a future ADR if anyone asks.
- **Terminal multiplexer / tmux integration.** The native terminal
  is a window onto a PTY; it doesn't try to re-implement screen
  multiplexing. Users who want tmux can run it inside the terminal.

### 6. Non-decisions deliberately deferred

- **STTextView vs CodeEditor vs hand-rolled NSTextView+TextKit2.**
  Default to STTextView (5b — most active maintenance, MIT, used
  by Krzysztof Zabłocki's apps). Drop down to a hand-rolled
  TextKit 2 view only if STTextView turns out to have a hard
  blocker we hit during integration. Decide with code, not
  speculation.
- **SwiftTerm vs Terminal.app embedding.** SwiftTerm in 5d. The
  AppKit `NSTerminalView` mentioned in ADR-0016 §5 doesn't actually
  exist as a public API; SwiftTerm is the working option for
  embedded terminals. Same author as Xamarin → wide deployment in
  Mac apps already (used by VSCode for Mac, Windows Terminal Tabs
  on macOS, etc.).
- **tree-sitter dynamic language loading.** Static-link the 6
  languages in 5b. Dynamic loading (download grammars at runtime)
  is interesting but adds a download / cache / verify pipeline
  for marginal benefit. Re-evaluate if the bundle size growth from
  6 statically-linked grammars is uncomfortable.

## Consequences

- The migration commit history continues with `phase 5x.<n>`
  prefixes, matching the 1d / 2x / 3x / 4x shape that worked
  through Phases 1d, 2, 3, and 4.
- Each sub-phase is independently shippable; we can stop after any
  of them. After 5c the user has a native file viewer + WebView
  terminal; after 5f the user has both natively + WebView graph
  only; etc.
- The `data-marvin-monaco` and `data-marvin-terminal` attributes
  join `data-marvin-{cost-pill, wordmark, chat-pane, file-tree,
  brain, side-pane, top-bar}` as the host-shell CSS gate set.
- `Package.swift` adds two new SPM dependencies: STTextView (MIT)
  and SwiftTerm (MIT). Both have stable v1+ releases, low transitive
  dep counts, and active 2026 commits — minimal supply-chain risk.

## Scope of Done

For ADR-0020 itself (this document):

- Phase 5 sub-phase list locked above. Re-derive only via a follow-up ADR.
- Match-not-improve gate (web work-pane surfaces stay until parity) explicit.
- Out-of-scope §5 is the only place to look for "is X part of Phase 5?"
  — if it's not in the sub-phase table and not explicitly out-of-scope,
  the answer is "decide as it comes up, document the call in a CHANGELOG entry."

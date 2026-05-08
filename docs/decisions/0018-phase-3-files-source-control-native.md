# ADR-0018 — Phase 3 native files + source control: shape and sub-phases

**Status:** Accepted
**Decider:** Robert Ilisei
**Date:** 2026-05-04
**Supersedes:** _none_
**Superseded by:** _none_

## Context

[ADR-0016](./0016-swift-migration.md) sketches Phase 3 as one row: native
file tree (`NSOutlineView`), native diff viewer, native source-control
panel, with the `/api/git/*` mutation API unchanged. [ADR-0017](./0017-phase-2-chat-native.md)
locked the Phase 2 sub-phasing (chat surface) and shipped 2a–2h on
`feat/swift-migration` (commits `phase 2x.<n>`).

With Phase 2 done, the chat region of the main window is entirely native
([ADR-0017 §3 sub-phase 2g](./0017-phase-2-chat-native.md#3-sub-phases-each-independently-shippable)).
The next visible WebView surfaces are the **file tree** (left pane), the
**source-control panel** (when changes exist), and the **diff viewer**
(when staging or reviewing a hunk). Phase 3 ports these.

This ADR fills the same gap ADR-0017 did for Phase 2 — the Phase 3 row of
ADR-0016 is a paragraph, and the sub-phase order, the wire contract, and
the "match-not-improve" gate aren't spelled out anywhere. Locking them
here lets the Phase 3 commits land incrementally without re-deriving
scope per PR.

## Decision

### 1. Files + source control port as native islands, not as a UI fork.

Same trust boundary as Phase 2: the Node sidecar at `apps/web` stays the
**single source of truth** for the filesystem view (sandbox enforcement,
ignore lists, symlink rejection per [ADR-0008](./0008-fs-sandbox.md)) and
git mutations. Swift is a renderer + an action surface, talking to the
existing HTTP API:

```
Swift native files / SCM            Node sidecar (apps/web)
    │                                    │
    ├── GET  /api/files/tree?cwd&depth ──►   (whole-tree walk; respects ignore list)
    ├── GET  /api/files/content?cwd&path ──► (utf-8 text contents for the viewer)
    ├── GET  /api/files/raw?cwd&path ────►   (binary bytes — images / PDFs)
    ├── POST /api/files/reveal ─────────►    (Finder reveal of one path)
    │                                    │
    ├── GET  /api/files/status?cwd ─────►    (working-tree status: modified / staged / untracked)
    ├── GET  /api/git/status?cwd ───────►    (porcelain v2 + branch ahead/behind)
    ├── GET  /api/git/diff?cwd&path&staged ─► (unified diff text)
    ├── GET  /api/git/branch?cwd ───────►    (current branch + remotes + state)
    ├── GET  /api/git/log?cwd ──────────►    (recent commits, paginated)
    │                                    │
    ├── POST /api/git/stage ────────────►    (stage paths)
    ├── POST /api/git/unstage ──────────►    (unstage paths)
    ├── POST /api/git/discard ──────────►    (discard local changes; CONFIRMS via /api/git/confirm)
    ├── POST /api/git/commit ───────────►    (commit staged changes with a message)
    ├── POST /api/git/fetch / pull / push ─► (network ops)
    └── POST /api/git/confirm ──────────►    (resolve a pending guarded mutation token)
```

We do NOT re-implement the sandbox in Swift, do NOT cache file contents
beyond the in-memory view-model state, and do NOT issue git plumbing
commands directly from the Swift process. The sidecar's existing
guarded-mutation pattern (`/api/git/*` returning a token, `/api/git/confirm`
applying it — see ADR-0015 § auto-mode policy floor) stays the path the
native UI takes for destructive actions.

### 2. Web file-tree + SCM panels stay visible until native parity is reached.

Same gate that governed Phase 1d (cost-pill hides only after the native
equivalent ships) and Phase 2g (web chat hides only after the native
chat reaches parity): under `[data-host-shell="swift"]` the web file tree
becomes `display: none` only when the native tree, selection, file
viewer wiring, status panel, diff viewer, and stage/unstage/commit are
all working. Until then the native island is a side surface for
development; the user works in the web tree as they do today.

This protects against the Phase 1 mistake where a half-built native
control was promoted into the main window and degraded the daily-driver
experience for two days before the rollback. The CSS-toggle + bridge
pattern is the only sanctioned promotion path.

### 3. Sub-phases (each independently shippable)

The phase order minimises risk of a half-shipped surface. Sub-phases
3a-3d are read-only — no state mutation, no possibility of breaking the
user's workflow. Sub-phases 3e-3g add mutation, gated by the same
guarded-mutation pattern as the web side.

| Sub-phase | Scope | Definition of Done |
|---|---|---|
| **3a — Foundation** | `FilesService.swift` (HTTP client for `/api/files/*` + `/api/git/*`), `FileTypes.swift` (Codable models for tree, status, diff). No UI. | Smoke compiles; one debug call hits `/api/files/tree?cwd=…` and decodes a real response. |
| **3b — Native file tree (read-only)** | SwiftUI `OutlineGroup` (or `NSOutlineView` via `NSViewRepresentable` if measured frame drops show up) rendering a `[FileNode]` from `/api/files/tree`. Lives in a side preview pane during 3b — the web tree keeps running in the main left pane. Disclosure triangles, file-vs-dir icons, root pinning. | The tree renders the active project's folder structure natively. Expand / collapse / scroll work. |
| **3c — File selection + bridge contract** | Selection on a native row dispatches through MarvinBridge → web `marvin:select-file` event so the existing web FileViewer (Monaco) opens it. Reverse direction (web tree click → bridge → native tree highlight) deferred to 3d. | Clicking a file in the native tree opens the same file in the web Monaco editor; selection state survives a tree refresh. |
| **3d — Hide the web tree** | Tag the web file tree with `data-marvin-file-tree`; add a CSS rule `[data-host-shell="swift"] [data-marvin-file-tree] { display: none }`. The native tree promotes into the main left-pane region. | Running in MARVIN-Swift, the file tree column is entirely native. The web app's React tree is still alive (file viewer, brain, terminal) but the tree UI specifically is suppressed. |
| **3e — Native source-control panel** | Native list of working-tree changes from `/api/files/status` + `/api/git/status`: untracked / modified / staged sections, branch + ahead/behind header, refresh on commit hook. Read-only — clicking a row does nothing yet. | The native panel matches what the web SCM tab shows for the same repo state, line-by-line. |
| **3f — Native diff viewer** | Click a row in 3e or in the native tree → side pane shows unified diff text from `/api/git/diff?path&staged`. Plain-text first (NSTextView with monospace + minimal red/green tinting); side-by-side Monaco-quality diff is Phase 5. | Selecting any changed file shows its diff natively. Switching between staged / working-tree variants works. |
| **3g — Stage / unstage / commit** | Buttons on each row + a commit-message input. POST to `/api/git/stage` / `/api/git/unstage` / `/api/git/commit`. Destructive ops (`/api/git/discard`) follow the existing guarded-mutation flow: native sheet shows the confirm token + count of files, user OKs, POST `/api/git/confirm`. | Staging, unstaging, and committing all work end-to-end natively. The guarded-mutation flow renders a native confirm sheet (same shape as Phase 2e's tool-confirm sheet). |
| **3h — DnD into Finder + Quick Look** | Drag a file row into Finder copies the file. Space bar on a selected row opens Quick Look (`QLPreviewPanel`). | Both feel like Xcode's source-control / file navigator. |

### 4. Out of scope for Phase 3

These are real but later:

- **Monaco-quality side-by-side diff.** 3f ships unified diff text. The
  side-by-side renderer with syntax highlighting is Phase 5 (embedded
  surfaces) — same reason the chat tool-call diffs ship plain in 2d.
- **In-tree rename / move / delete.** Done via the existing right-click
  menu in the web tree today; native equivalents land alongside DnD in
  3h or as a follow-up. Out of the parity gate.
- **Git history surface.** `/api/git/log` is a wire that 3a will model,
  but the history viewer (Xcode-style commit list with per-commit
  diffs) is a separate body of work — open a follow-up ADR if it ships.
- **Lazy-load on directory expand.** The current `/api/files/tree`
  endpoint walks the whole tree to a depth cap. If real projects start
  hitting `MAX_ENTRIES`, we add an expand-on-click endpoint as a
  surgical change rather than rewriting the renderer.
- **File watcher / inotify integration.** Polling the existing endpoints
  on demand is fine for Phase 3. Real-time file-watch is a future ADR
  if measurement shows the polling loop is the bottleneck.

### 5. Non-decisions deliberately deferred

- **`OutlineGroup` vs `NSOutlineView`.** Default to SwiftUI
  `OutlineGroup` + `DisclosureGroup` first (3b) — fall through to
  `NSOutlineView` only if measured perf shows up at large repos. Same
  pattern as ADR-0017 §5 (List vs NSCollectionView).
- **Tree caching strategy.** Decide after 3b is in and we can measure
  cold-load time on a real ~5k-file repo. Today's web tree caches
  in-memory; Swift might want a disk cache for repeated launches, but
  premature.
- **Whether native tree owns the `selectedPath` source of truth.** During
  3c the bridge proxies; during 3d the native side becomes authoritative
  but the web FileViewer still consumes it. Long-term (Phase 5) the
  Monaco viewer goes native too and the question dissolves.

## Consequences

- The migration commit history continues with `phase 3x.<n>` prefixes,
  matching the 1d / 2x shape that worked through Phases 1d and 2.
- Each sub-phase is independently shippable; we can stop after any of
  them (e.g. after 3d the user gets a native file tree + the existing
  web SCM panel — useful even without 3e-h).
- The Tauri build at `apps/desktop/` continues to render the web file
  tree unchanged; nothing in Phase 3 touches the Tauri shell.
- The guarded-mutation pattern (token + confirm) gets a second consumer
  on the Swift side. If a third one shows up before Phase 6, factor a
  shared helper; for two consumers the duplication is cheap.

## Scope of Done

For ADR-0018 itself (this document):

- Phase 3 sub-phase list locked above. Re-derive only via a follow-up ADR.
- Wire-contract diagram in §1 frozen — endpoints, request bodies. Adding
  a new endpoint is fine; renaming an existing one is an ADR change.
- The "out of scope" list in §4 is the only place to look for "is X part
  of Phase 3?" — if it's not in the sub-phase table and not explicitly
  out-of-scope, the answer is "decide as it comes up, document the call
  in a CHANGELOG entry."

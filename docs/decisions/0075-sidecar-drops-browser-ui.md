# 0075 — Sidecar drops the browser UI; native macOS app is the only client

- Status: Accepted
- Date: 2026-08-29
- Related: [ADR-0011](./0011-sidecar-node-bundling.md) (superseded — the sidecar
  existed to serve the browser UI), [ADR-0016](./0016-swift-migration.md)
  (native Swift migration that began this transition),
  [ADR-0043](./0043-server-turn-announcements.md) (announce loop, native-only),
  the "Post-M5" removal
  of the old WebView-in-native-shell bridge referenced in `ChatPreviewView.swift`

## Context

MARVIN shipped two UIs from the start: a browser-facing Next.js app
(`sidecar/src/app/page.tsx` + `sidecar/src/components/**`) and, from Phase 1a
onward, a native macOS SwiftUI app that first embedded that browser UI in a
`WKWebView` and progressively replaced it with native views (the "M5"
milestone referenced in `ChatPreviewView.swift`'s `syncHydrateFromBridge`
comment). By 2026-08 the native app had its own chat surface
(`ChatPreviewView.swift`), file tree, terminal, source control, and settings
panes — full parity with the browser UI — and the user confirmed directly
that the browser UI has not been opened in normal use for some time. A code
audit (this session) confirmed zero remaining live consumers: `ContentView.swift`
and `MARVINApp.swift` retained only a **stale Phase-1a comment** claiming a
"full-bleed WKWebView pointed at localhost:3030" — no such `WKWebView` still
exists in either file. The only two `WKWebView` usages left in the native app
(`GraphPaneView.swift` for the sandboxed graphify HTML document,
`PreviewPaneView.swift` for previewing the *user's own* project under
development) are unrelated — neither loads MARVIN's own sidecar UI.

## Decision

Delete the browser-facing half of the sidecar. Keep the Next.js process —
it still hosts every `/api/**` route, which is the only thing the native app
talks to over `localhost:3030`, plus the Agent SDK runner, session
persistence, turn-registry, and every other `@marvin/*` backend package. What
goes away is everything that only a browser would ever load: the root
`app/page.tsx` (1154 lines) + `app/layout.tsx` + `app/globals.css`, all of
`sidecar/src/components/**` (72 files — chat rendering, the web-only "brain"
liquid/orb components, file tree, terminal, diff viewer, settings panel,
etc.), two now-orphaned `lib/` helpers (`panel-resize-signal.ts`,
`use-prefs.tsx`), and the three test files that only exercised deleted
components (`file-tree-filter`, `task-role`, `model-picker-presets`).

**The native brain animation is untouched.** It was never the same code —
`macos/MARVIN/BrainMetalView.swift` + `BrainGPUSimulation.swift` are a native
Metal renderer; the deleted `components/brain/*.tsx` were a separate
React/CSS implementation for the browser that the native app never loaded.

## Consequences

- Positive: ~2,600 fewer lines of dead frontend code; no more risk of the
  browser UI silently drifting out of sync with the native app's behavior;
  `next build` now produces a pure API server (verified — the build output
  lists only `/api/**` routes, no page routes).
- Positive: closes the actual ambiguity this ADR exists to record — "does
  MARVIN use its own browser UI" now has one verifiable answer (no), instead
  of a stale comment implying otherwise.
- Negative / trade-off: the `@marvin/ui` workspace package (shadcn
  primitives) and several `sidecar/package.json` dependencies
  (`@monaco-editor/react`, `@xterm/xterm`, `@xterm/addon-fit`,
  `react-resizable-panels`, `tw-animate-css`, `tailwindcss`) are now
  orphaned but were deliberately **not** removed this pass — pruning them
  touches `pnpm-lock.yaml` and the workspace graph, a separate, lower-risk
  cleanup that doesn't need to block this one.
- Follow-ups created: prune the now-orphaned sidecar dependencies +
  `@marvin/ui` package (or repurpose it if native SwiftUI ever needs a
  shared design-token source); remove the stale Phase-1a WebView comment
  blocks in `ContentView.swift` / `MARVINApp.swift` (harmless but
  misleading — noticed in flight, not in scope for this ADR).

## Alternatives considered

- Keep the browser UI as a maintained fallback client — rejected: the user
  does not use it, doubling UI surface area for a client with zero usage is
  pure maintenance cost, and it already required per-feature auditing to
  keep in sync with the native app (see the "Post-M5" comment this session
  found describing exactly that drift).
- Delete the whole `sidecar/` package and rewrite the Agent SDK integration
  natively in Swift — rejected as a separate, much larger decision (no
  official Swift Agent SDK exists; would mean reimplementing the SDK's
  CLI-subprocess control protocol from scratch). Out of scope here; the
  native app still needs *a* local backend process, this ADR only removes
  the part of that backend that rendered pages.

## Scope of Done

- [x] `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, and all of
      `sidecar/src/components/**` deleted.
- [x] Orphaned `lib/panel-resize-signal.ts`, `lib/use-prefs.tsx`, and the
      three tests exercising deleted components deleted.
- [x] `pnpm --filter @marvin/web typecheck` passes clean.
- [x] `pnpm --filter @marvin/web build` succeeds and produces an API-only
      route manifest (no page routes).
- [x] `bin/marvin install-macos-app --bundled` succeeds end-to-end with the
      trimmed sidecar bundled inside `MARVIN.app`.
- [ ] Dependency prune (`@monaco-editor/react`, `@xterm/*`,
      `react-resizable-panels`, `tw-animate-css`, `@marvin/ui`) — deferred,
      tracked in Follow-ups above, not required for this ADR's claim.

## Related

- Files: `sidecar/src/app/page.tsx` (deleted), `sidecar/src/app/layout.tsx`
  (deleted), `sidecar/src/components/**` (deleted, 72 files),
  `sidecar/src/lib/panel-resize-signal.ts` (deleted),
  `sidecar/src/lib/use-prefs.tsx` (deleted), `sidecar/next.config.ts`
  (unchanged — `output: "standalone"` already API-agnostic),
  `macos/MARVIN/ContentView.swift`, `macos/MARVIN/MARVINApp.swift` (stale
  comments, not yet cleaned up)
- Supersedes: none directly, but retires the browser-UI half of the
  architecture ADR-0011 originally bundled the sidecar to serve.

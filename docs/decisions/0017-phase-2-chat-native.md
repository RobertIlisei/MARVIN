# ADR-0017 — Phase 2 native chat surface: shape and sub-phases

**Status:** Accepted
**Decider:** Robert Ilisei
**Date:** 2026-05-04
**Supersedes:** _none_
**Superseded by:** _none_

## Context

[ADR-0016](./0016-swift-migration.md) defines the shell-first / islands-later
migration. Phase 1 (window, menu bar, status item, About, Settings, find,
zoom, notifications, theme sync, drag-drop, lifecycle) shipped over commits
1d.0 — 1d.36 on `feat/swift-migration`. The chat / file-tree / brain content
still renders inside a single `WKWebView` island.

The chat surface is the largest visible WebView region — it's also the most
felt-laggy at 500+ messages, where the React message list is the bottleneck
([ADR-0016 §`Why we picked this shape`](./0016-swift-migration.md#why-we-picked-this-shape)
identifies `react-window` + WKWebView as inadequate for the long-session case
that motivated the migration). Phase 2 replaces the chat with a native
`NSCollectionView`-driven list and a native `NSTextView`-based input, while
the file tree / brain / Monaco islands stay in WebView until later phases.

The Phase 2 row of the ADR-0016 phase table is one paragraph; it doesn't
spell out the wire contract, the sub-phase order, or the "match-not-improve"
DoD. This ADR fills that gap so the Phase 2 commits can land incrementally
without ambiguity about scope.

## Decision

### 1. The chat surface ports as a native island, not as a UI fork.

The Node sidecar at `apps/web` stays the **single source of truth** for chat
state — the agent loop, session persistence, cost tracking, confirm gate,
and turn registry all stay in Node. The Swift side is a renderer + input
surface, talking to the existing HTTP/SSE API:

```
Swift native chat                 Node sidecar (apps/web)
    │                                  │
    ├── POST /api/chat ─────────────►  │   (start a turn)
    │                                  │
    │  ◄────── SSE event stream ───────┤   (turn.started → cli.event*
    │                                  │    → confirm.request? →
    │                                  │    turn.completed | turn.error)
    │                                  │
    ├── POST /api/chat/cancel ─────►   │   (user-initiated cancel)
    │                                  │
    ├── POST /api/confirm/respond ►    │   (decide confirm)
    │                                  │
    ├── GET /api/chat/resume?…  ────►  │   (reconnect to in-flight turn)
    │                                  │
    └── GET /api/sessions/:id  ─────►  │   (hydrate prior transcript)
```

We do NOT re-implement the agent loop in Swift, do NOT cache messages on the
Swift side beyond the in-memory list driving the UI, and do NOT touch
Anthropic credentials. This is the same trust boundary
[ADR-0016 §Architectural shape](./0016-swift-migration.md#architectural-shape)
locked for Phase 1.

### 2. Web chat stays visible until native parity is reached.

Same gate that governed Phase 1d (cost-pill / wordmark hides only after
native equivalent ships): under `[data-host-shell="swift"]` the web chat
list becomes `display: none` only when the native list, the native input,
the streaming UI, the tool-call cards, the confirm prompts, the cancel /
retry / reset, and the session-history hydrate are all working. Until then
the native island is a side panel for development; the user works in the
web chat as they do today.

### 3. Sub-phases (each independently shippable)

The phase order minimises risk of a half-shipped surface. The first three
sub-phases are read-only — no state mutation, no possibility of breaking
the user's workflow.

| Sub-phase | Scope | Definition of Done |
|---|---|---|
| **2a — Foundation** | `ChatService.swift` (SSE client), `ChatTypes.swift` (Codable models for the wire format), one smoke path that verifies a turn streams end-to-end. No UI. | Smoke logs `turn.started → cli.event → turn.completed` for a hello-world turn against a live sidecar. |
| **2b — Native ChatInput (send-only)** | Multi-line `NSTextView` with proper IME via `NSViewRepresentable`. ⌘⏎ submits; ⏎ alone newlines. POSTs to `/api/chat`. No response rendering yet. | User can type a message, hit ⌘⏎, see the request in sidecar logs. The web chat continues to render the response. |
| **2c — Native message list (read-only)** | `List` with cell views for assistant / user / system messages. Driven by the SSE event stream via the foundation client. Empty state, error state, placeholder while streaming. | Sending a message via 2b's input renders the streaming response in the native list while the web chat ALSO renders it (parallel render — proves the wire works without breaking anything). |
| **2d — Tool-call cards** | Collapsible cell view for `tool_use` / `tool_result` block pairs. Bash / Read / Edit / Write etc. each get a tag color matching the web. Output truncation + expand-to-full-text. | Tool-heavy turns render in the native list with the same layout the web shows; expand/collapse works. |
| **2e — Confirm prompts** | Native sheet (`NSAlert`-style or SwiftUI `.confirmationDialog`) on `confirm.request` events. Allow / Allow always / Deny → `POST /api/confirm/respond`. | Gated mode (`permissionStrategy: "gated"`) works end-to-end natively without the web chat being involved. |
| **2f — Cancel / retry / reset** | ⌘. cancels the turn (`POST /api/chat/cancel`). Retry button on errored turns. ⌘⇧N reset (already wired natively in Phase 1d.25 — verify it clears the native list too). | All three actions work without touching the web chat. |
| **2g — Hide the web chat** | Tag the web chat surface with `data-marvin-chat-pane`; add a CSS rule `[data-host-shell="swift"] [data-marvin-chat-pane] { display: none }`. The native island goes from "side panel" to "fills the chat area". | Running in MARVIN-Swift, the chat region is entirely native. The web app's React tree is still alive (file tree, brain, Monaco islands stay) but the chat UI specifically is suppressed. |
| **2h — Session resume + history hydrate** | On project switch, hit `GET /api/sessions/:id` to load the prior transcript into the native list. On `marvin:select-project` events, the native list re-hydrates. On reconnect to an in-flight turn, `GET /api/chat/resume` tails the same bus. | Switching to a project with prior history shows that history natively without flashing through the web. |

### 4. Out of scope for Phase 2

These are real but later:

- **Markdown rendering parity.** Phase 2c renders message text as plain
  text with monospace `code spans`. Full markdown (headings, lists, links,
  rendered code blocks with syntax highlighting) is Phase 5 work because
  the Monaco-style code blocks are part of the embedded-surfaces port.
- **Brain visualizer.** Stays in WebView through Phase 2 — it's an
  independent island. Phase 4 ports it to MetalKit.
- **File tree, diff viewer, Source Control panel.** Phase 3.
- **Tool-call diffs (Edit / Write).** Render as plain "before / after"
  text in Phase 2d; Monaco-style side-by-side diff is Phase 5.

### 5. Non-decisions deliberately deferred

- `NSCollectionView` vs SwiftUI `List` for the message list. Default to
  SwiftUI `List` first (Phase 2c) — fall through to `NSCollectionView` only
  if measured frame drops show up at the high message counts that
  motivated Phase 2 in the first place. The `List` path is cheaper to
  ship and lets us re-evaluate with real numbers instead of folklore.
- Streaming render strategy (whole-message diff vs character-by-character
  vs block-level append). Decide after the smoke client is in and we can
  measure on real turn shapes.
- Whether to keep the `marvinSessionId` ↔ Claude `sessionId` distinction
  in the Swift types or collapse them into one. Defer until Phase 2h
  (resume) — the wire ships both, but the Swift consumer might only need
  one.

## Consequences

- The migration commit history continues with `phase 2x.<n>` prefixes,
  matching the 1d.<n> shape that worked for Phase 1d's 19-commit run.
- Each sub-phase is independently shippable; we can stop after any of
  them (e.g. after 2c the user gets a native read-only chat alongside
  the web one — useful even without 2d-h).
- The Tauri build at `apps/desktop/` continues to render the web chat
  unchanged; nothing in Phase 2 touches the Tauri shell.
- Phase 1d's existing native menu bridges (⌘O, ⌘⇧N, ⌘⇧T, ⌘/) keep
  working — they currently dispatch CustomEvents the web side handles;
  by Phase 2g we'll have native handlers for the chat-relevant ones.

## Scope of Done

For ADR-0017 itself (this document):

- Phase 2 sub-phase list locked above. Re-derive only via a follow-up ADR.
- Wire-contract diagram in §1 frozen — endpoints, event names, request
  bodies. Adding a new SSE event type is fine; renaming an existing one
  is an ADR change.
- The "out of scope" list in §4 is the only place to look for "is X part
  of Phase 2?" — if it's not in the sub-phase table and not explicitly
  out-of-scope, the answer is "decide as it comes up, document the call
  in a CHANGELOG entry."

# ADR-0072 — The session list must not parse transcripts, and a slow list must never blank the chat

- **Status:** Accepted
- **Date:** 2026-08-24
- **Related:** [ADR-0048](./0048-full-session-history-tail-first.md) (tail-first hydration),
  [ADR-0062](./0062-update-constraints-loop-identified-mitigated.md) (layout loop — the co-symptom)

## Context

Reported as *"marvin crashed again … I lost all sessions, including the one that
was running."* Neither was true, and establishing that took measurement:

| Check | Result |
|---|---|
| Process | pid 40388, up 1h56m — never died. No MARVIN `.ips` since Aug 22. |
| Transcripts | all **347** on disk (2.6 GB), the "lost" one ending `turn.completed / success`. |
| `GET /api/sessions/<id>` | **HTTP 200 in 96 ms**, full 3 MB transcript. |
| `GET /api/sessions` (the list) | **HTTP 200 in 23.0 s**, reproducibly. |

One slow endpoint produced both symptoms — "(no past sessions)" *and* a blank
chat for a session whose transcript loaded in under 100 ms.

**Why the list was slow.** `listSessions` (`session.ts`) is already cheap — pure
`statSync`. The cost was entirely in the route: `sessions/route.ts` called
`loadSession()` on every transcript to fill two preview fields
(`firstUserMessage`, `turnCount`), i.e. a full `JSON.parse` of every line of
every file, per request. It crossed a pain threshold on the day several
multi-MB transcripts landed at once.

**Why slow became "lost" — two client defects.**

1. `refreshSessions` (`ChatPreviewView.swift`) opened with
   `sessionsFetchTask?.cancel()`. Its own doc comment promised the opposite:
   *"a fetch in flight isn't re-started; subsequent calls await the existing
   task."* It is called from nine sites, one of them the tab strip's
   `.onAppear`, which re-fires on every SwiftUI subtree rebuild — and
   `NSSplitViewController.loadView` was measured running **8×** that launch
   (ADR-0062). A fetch longer than the gap between rebuilds was cancelled and
   restarted forever and could never complete.
2. `autoHydrate` awaited `fetchSessions` **before** hydrating, purely to turn an
   id it already held (`NativePrefs.lastSessionId`) into a summary object. List
   empty or thrown → `guard let target else { return }` → `hydrate` never called
   → blank chat.

So the layout storm and the missing sessions were one event: the pane
rebuilding while its data source hung.

## Decision

**Server — scan, don't parse; cache on `(mtime, size)`.**
`listSessionSummaries` computes `turnCount` as a `Buffer.indexOf` count of the
`"type":"turn.user"` marker (no per-line allocation), and parses only the single
first-user-turn line from a bounded 256 KB head read. Results persist in
`.summaries.json` beside the transcripts. Sessions are append-only, so all but
the active one are immutable and the hit rate is near-total — including across
restarts.

| | before | after |
|---|---|---|
| Cold (first scan) | 23.0 s | 4.6 s |
| Warm (cache hit) | 23.0 s | **0.017 s** (36 ms end-to-end) |

**Client — hydration does not depend on the list.** `autoHydrate` hydrates the
saved id immediately (tail-first per ADR-0048) and fetches the list in
parallel. A slow or failed picker can no longer cost the user their
conversation. `refreshSessions` now does what its comment said: an in-flight
fetch is left to finish.

## Scope of Done

- [x] `listSessionSummaries` + on-disk cache; route switched to it.
- [x] `autoHydrate` decoupled from the list; `refreshSessions` coalesces.
- [x] 10 tests, including scan-count == parsed-count and marker-inside-payload.
- [x] Verified live: 347 sessions in 36 ms on the restarted app.

## Consequences

**The marker count is a substring count.** A `cli.event` payload that embeds a
raw `"type":"turn.user"` string would be over-counted. Transcript records are
JSON-encoded, so an embedded copy is escaped (`\"type\":\"turn.user\"`) and does
not match — a test pins this. A future record type that stores raw JSON text
unescaped would break the invariant; the test is the tripwire.

**Cache invalidation is by `(mtime, size)`, both required.** Size alone misses
an in-place rewrite; mtime alone is coarse on some filesystems.

**The ADR-0062 rebuild loop is untouched.** This fixes the *consequence* of a
subtree rebuilding 8× per launch, not the rebuild itself. That root cause is
still open.

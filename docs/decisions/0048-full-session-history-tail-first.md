# ADR-0048 — Full session history: tail-first paint, background full-load

- Status: accepted
- Date: 2026-06-22

## Context

Restoring a session on cold start was silently truncating its history. The
native client's auto-hydrate calls `hydrate(tail: 200)` (`ChatPreviewView`), and
the server (`/api/sessions/[sessionId]`) honours `tail` by returning
`record.turns.slice(-tail)`. Crucially `record.turns` is **one entry per
`cli.event`** (a single assistant exchange is many events — assistant deltas,
tool_use, tool_result, result), so 200 lines is only the last few turns. The
user saw a restored session "missing most of its history." Manual history-pick
(`selectSession`) already fetched the full transcript, so only the
auto-restored session was clipped — and the response gave the client **no
signal** that it had been clipped, so it couldn't recover.

The `tail` cap was deliberate (a field session of 314 turns / ~123 MB JSONL
froze launch for seconds). But the freeze was the **fetch + synchronous decode**
of a 120 MB payload, since fixed by decoding off the main actor
(`Task.detached`, `ChatService.fetchSession`); and the message list renders
through a `LazyVStack` (virtualised). So the cap is no longer the only way to
keep launch fast — it can be replaced by paint-the-tail-then-load-the-rest.

## Decision

Keep the fast tail-first paint, and let the user **page in older lines on
demand** — the next page, or the full log — so they get a small fast initial
load and can load as much as they want, never auto-paying the 120 MB cost.

- **Server reports truncation.** `/api/sessions/[sessionId]` now returns
  `truncated: boolean` + `totalTurns: number` alongside the (possibly clipped)
  turns, so the client can tell "exactly `tail` turns" from "clipped at `tail`"
  and show the right `N of M` count.
- **Tail-first paint.** Cold start paints the last `HISTORY_PAGE` (200) lines.
  `historyWindow` / `historyTotalTurns` / `historyTruncated` track the window.
- **Page on demand.** When older lines remain, a top-of-list control offers
  **"Show 200 earlier lines"** (`loadNextHistoryPage` → re-fetch `tail =
  window + 200`) and **"Show full log"** (`loadFullHistory` → `tail = nil`),
  with a live `N of M lines` count. Each load decodes off-main and replays
  through the same reducer into the lazy list; growing the tail window by a
  page each click converges to the full log.
- **Guards.** A load only swaps if we're still on the same session and not
  mid-send (`!isSending`) — a streaming turn's events aren't on disk yet, so
  replacing would drop them. The list is bottom-anchored (`.defaultScrollAnchor(.bottom)`),
  so newly-loaded older lines appear above the latest message; replay also
  reconstructs the plan from whatever window is loaded (ADR-0046/0047).

## Consequences

- Positive: instant launch (200-line paint), and the user controls how much
  history to pull — up to the entire log — so nothing is silently lost and the
  120 MB monster is never auto-loaded. No main-thread freeze (off-main decode +
  lazy render).
- Negative / trade-offs: "Show earlier" re-fetches the growing tail window
  (re-sends the already-loaded lines each page) — negligible at 200/loopback,
  and simpler/safer than a stateful `before`-cursor. The bottom-anchored list
  doesn't preserve the exact scroll offset across a load (older lines land
  above; the user scrolls up) — a deliberate trade to avoid the
  `.scrollPosition(id:)` jump chaos the pane previously hit.
- Follow-ups created: a `before`/offset cursor so paging fetches only the new
  slice; preserve exact scroll offset across a page load. Deferred.

## Alternatives considered

- **Auto background full-load when truncated.** Rejected — re-pays the 120 MB
  transfer/decode on every cold start for a large session; the user asked for
  explicit, incremental control instead.
- **Raise/remove the `tail` cap.** Rejected — reintroduces the launch payload
  cost and still hard-caps somewhere.
- **Stateful `before`-cursor paging (fetch only the new slice).** Deferred, not
  rejected — the grow-the-tail re-fetch is simpler and fine at this page size;
  the cursor is the optimisation if large-session paging gets heavy.

## Scope of Done

- [ ] `/api/sessions/[sessionId]` returns `truncated` + `totalTurns`.
- [ ] `SessionRecord` decodes the new optional fields.
- [ ] Cold-start paints the last 200 lines; a top-of-list control loads the
      next 200 (and a "full log" jump) with a live `N of M` count.
- [ ] Loads decode off-main, replay into the lazy list, and are guarded (same
      session, not mid-send); paging state resets on session switch.
- [ ] `swift build` clean; sidecar `tsc` clean for the change.

## Related

- Files: `sidecar/src/app/api/sessions/[sessionId]/route.ts`,
  `macos/MARVIN/ChatPreviewView.swift`, `macos/MARVIN/ChatTypes.swift`,
  `macos/MARVIN/ChatService.swift`
- Builds on: Phase-2h hydration/replay; ADR-0046/0047 plan rehydration in replay.

## Addendum — 2026-09-09: the tab strip was paying the full-log price

User: *"switching sessions does not load the right pane smoothly and cleanly
and fluid. We need to find a way to improve performance."*

Measured before theorising, on the real 122 MB / 36,356-turn transcript this
ADR was written against. Three causes, one of them a factor of a thousand:

| Cause | Cost |
|---|---|
| `selectSession` passed no `tail`, so a tab click fetched the WHOLE transcript | 122 MB over loopback; ~470 ms in `JSONSerialization` alone, more through `Codable` |
| `loadSession` UTF-8 decoded and `JSON.parse`d all 36,356 lines, then sliced | 528 ms, to produce a 200-turn answer |
| `ChatStreamReducer.apply` took the array by value and returned a new one, so each of the 36,356 events copied the whole list | **6.3 s** against **6 ms** in place, benchmarked at the same N |

The last one is the interesting one, and it was not visible in the code: the
call reads `rebuilt = ChatStreamReducer.apply(rebuilt, …)`, which looks linear.
The caller still holds the array it passed, so copy-on-write fires on the
reducer's first mutation — an O(n) copy per event, O(n²) per replay, on the
main actor.

This ADR's own reasoning is what aged: it said the manual history-pick
"intentionally pays that cost since the user asked". That was true when the
only way in was the history menu. ADR-0107 made the same function the
tab-strip click, and a deliberate act became a routine one.

**Changes.** `selectSession` passes `tail: historyPage`, like every other
hydrate — "show earlier" is still how the rest is reached. A `tail` request
takes a new `loadSessionTail`, which reads the file as a Buffer, counts
newlines for the true total, and parses only the lines it returns (113 ms,
byte-identical to load-then-slice at every tail, pinned by tests). And the
reducer gained `apply(to:cliEventData:)`, which mutates in place; the
value-returning `apply` stays as a wrapper for the older call sites.

**Prefer `apply(to:…)` on any path that runs per event.** The value-returning
form is not a style choice at scale, it is the O(n²).

Two smaller things fell out. Switching sessions never reset `renderWindow`, so
a widened window followed you into the next tab; it resets on hydrate now. And
the pane no longer blanks: rows for the last six visited tabs are kept in
memory and painted immediately on switch, with the fetch replacing them when it
lands. `hydrate` now logs `turns=… fetch=…ms replay=…ms` so the next person
measures instead of guessing.

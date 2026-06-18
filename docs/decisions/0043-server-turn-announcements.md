# ADR-0043 — Server-initiated turns reach the idle client (turn announcements)

**Status:** Accepted — 2026-06-18
**Touches:** `turn-registry.ts` (a turn announcer + emit on register), new
`GET /api/chat/announce` SSE route, `ChatService.swift` (announce stream),
`ChatPreviewView.swift` (idle re-attach + a background-job affordance). Builds
on self-scheduled wakeups ([ADR-0031](./0031-self-scheduled-wakeups.md)) and
background-job event wakeups ([ADR-0038](./0038-background-jobs-event-wakeups.md)).

## Context

ADR-0031 (timed) and ADR-0038 (background-job exit) both fire a **real
assistant turn with no user message** — `startScheduledTurn` →
`runDetachedTurn`, dispatched through the shared `wakeup-scheduler` fire
handler. That server half works and is unit-tested.

The promise still failed in practice: *"I started the build, I'll tell you when
it's done"* — the job finished, a turn ran, and the user **saw nothing**, left
waiting with no idea whether it failed, finished, or was still running.

Root cause is the **last hop — getting a server-initiated turn onto the
screen.** The macOS app attaches to a turn's live event bus via `attachLive()`
→ `GET /api/chat/resume`. But `attachLive()` has exactly **one caller**: the
session-*hydrate* path (open / switch a session). There is no always-on
sidecar→app channel. So once an interactive turn ends, the app sits idle
holding no stream. When a job-completion / wakeup turn later registers via
`registerLiveTurn` and emits to its in-memory bus, **no client is listening**.
The events still land in the on-disk transcript, so the result is only visible
the next time the user switches sessions or relaunches (which re-hydrates and
replays). Pull-based delivery cannot surface a push-shaped event.

## Decision

Add a thin **announcement channel** so an idle client learns that a turn it did
not start has begun, and reuses the existing attach path to render it.

- **`turn-registry.ts`** — a module-level `EventEmitter` (same single-process
  assumption as the `live` map). `registerLiveTurn` emits a `turn` announcement
  `{ marvinSessionId, projectId, turnId, startedAt }` after the turn is in the
  map. `subscribeTurnAnnouncements(listener)` returns an unsubscribe fn. This is
  the ONLY new server surface; the turn-dispatch path is unchanged.
- **`GET /api/chat/announce?projectId=…`** — an SSE stream the app holds open
  for the whole time a project is loaded. Sends `announce.attached` on connect,
  then forwards each `turn.registered` for that project. A ~25 s heartbeat
  comment keeps the connection alive and reaps dead clients. Read-only — it
  never starts, cancels, or mutates a turn.
- **Client (`ChatPreviewView`)** — holds an announce subscription (auto-
  reconnecting) while a session is loaded. **Rule: when an announcement arrives
  for the loaded session AND the view has no live stream of its own, call the
  existing `attachLive()`.** "No live stream" is the dedup — a turn the client
  started itself is already being streamed over its POST, so its own
  `turn.registered` is ignored; only genuinely server-initiated turns (fired
  while idle) trigger a re-attach. Everything downstream — `runResume`, the SSE
  parser, the reducer — is unchanged.
- **Background-job affordance** — the client shows a "background job running"
  indicator from the moment a `run_background_job` tool result lands until the
  next server-initiated turn completes, so *in-flight* is visibly distinct from
  *done* (DoD #3). Approximate single-job mapping; good enough for the affordance.

### Why not poll `/api/chat/resume` on a timer

Polling races the turn registration, wastes connections, and trades a clean
event for a latency knob. We already have the event (`registerLiveTurn`); a
push reuses it with one emitter and one SSE route. Considered as the cheap
interim and rejected once the push proved small.

### Why announce per *project*, not per session

The app shows one session at a time but a job can complete for any session in
the loaded project. Project scope lets the client decide (attach if the
announced session is the open one; otherwise leave it for the transcript — a
future unread badge is out of scope here).

### Why not persist / globalThis-pin the announcer

Same single-process assumption as `turn-registry`'s `live` map, which is
module-level and already shared across every route chunk that uses it (the
POST, resume, and announce routes). The announcer rides the same instance; no
globalThis pin needed (unlike `wakeup-scheduler`, which is also imported from
`instrumentation.ts`). If MARVIN ever goes multi-process, both move to Redis
pub/sub together.

## Consequences

- A background job (or timed wakeup) that completes while the user sits on the
  session now renders a visible turn **without** a switch/relaunch — the
  ADR-0038 promise is true on the client axis too.
- Failures are visible: the completion turn's text already frames
  success/failure + output tail (ADR-0038); it now actually reaches the screen.
- One new always-on connection per loaded project. Cheap (local loopback),
  heartbeat-reaped, read-only.

## Rejected alternatives

- **Poll `/api/chat/resume`.** See above — races and wastes turns.
- **Push the whole turn over the announce channel.** Duplicates the resume
  stream and its reducer. Announce only says "attach now"; `attachLive` does the
  rest through the proven path.
- **Local OS notification only.** Tells the user something happened but leaves
  the result buried in the transcript — doesn't render the turn.

## Scope of Done

- [x] `registerLiveTurn` emits a `turn.registered` announcement;
      `subscribeTurnAnnouncements` delivers it — 3 unit tests
      (`turn-announcements.test.ts`); the 6 existing `turn-registry` tests
      still pass (the emit doesn't perturb the concurrency contract).
- [x] `GET /api/chat/announce` streams `turn.registered` for a project, with a
      25 s heartbeat, and tears down its subscription + timer on disconnect.
- [x] The idle macOS app arms a per-project announce loop (`ensureAnnounceLoop`,
      auto-reconnecting) from hydrate / first-turn / cold-start; on an
      announcement for the open session while idle it calls the existing
      `attachLive`. **Compile-verified; live end-to-end (rebuild + drive a real
      job) still to run.**
- [x] A turn the client started itself is NOT double-attached — guarded by
      `!isSending` plus the server-side `deferIfSessionBusy` (a wakeup/job turn
      only registers once the live turn ends).
- [x] A "background job running" chip (`backgroundJobChip`) shows from the
      `run_background_job` tool_use until the next server-initiated turn settles.
- [x] Sidecar tsc clean for all touched files (pre-existing
      `can-use-tool-dispatch.test.ts` SDK-type drift is unrelated); macOS
      `swift build` of the `MARVIN` target succeeds.

**Remaining:** live verification — rebuild the app, start a background job that
finishes ~30 s later while sitting idle on the session, confirm the completion
turn renders without a switch. Plus a route-level test for `/api/chat/announce`
(currently covered transitively by the emitter unit tests + the thin forwarder).

# 0076 — Mid-turn steering: messages are delivered INTO the running turn

- Status: Accepted
- Date: 2026-08-29
- Related: [ADR-0069](./0069-never-drop-a-user-message.md) (durable queue +
  safe preemption — this ADR narrows when the queue is used),
  [ADR-0031](./0031-self-scheduled-wakeups.md) / [ADR-0043](./0043-server-turn-announcements.md)
  (machine turns, unchanged), [ADR-0073](./0073-agent-sdk-0-3-upgrade.md)
  (SDK 0.3 line this builds on)

## Context

The user: "I can't keep sending messages to MARVIN once he starts working on
something — they go into a queue. On Claude desktop or the CLI I can send as
many messages as I want and it just works through everything." ADR-0069 made
a message sent during a turn *durable* (persisted, then run as a coalesced
follow-up turn), which fixed the original loss bug but still made the user
wait for the whole turn before their steer had any effect.

Checked against the official Agent SDK docs
(`agent-sdk/streaming-vs-single-mode`) rather than assumed: **single-message
input** — `query({ prompt: string })`, what MARVIN used for every turn —
explicitly does *not* support "dynamic message queueing" or "real-time
interruption". **Streaming input** — `prompt: AsyncIterable<SDKUserMessage>`
— does: "Queued messages: send multiple messages that process sequentially,
with ability to interrupt." That is the mechanism Claude Code itself uses.

## Decision

Every human turn runs in streaming input mode over a per-turn
`TurnInputChannel`; a message POSTed while that turn is live is pushed into
the channel and delivered to the SDK, instead of being queued behind the
turn.

- `runAgent` takes an optional `inputChannel`; when present the prompt is
  `channel.stream(firstMessage)`. On a `result` with nothing pending the
  runner closes the channel, so a turn with no extra input terminates
  exactly as single-message mode did (same watchdog, same terminal event).
  A `result` with messages pending is intermediate — the SDK continues
  within the same query — and is not treated as terminal.
- `runDetachedTurn` creates the channel and exposes it as
  `liveTurn.inject`; when the agent returns it closes the channel and
  re-queues anything accepted-but-unconsumed through `enqueuePending`, so
  ADR-0069's "no message is ever lost" still holds end to end.
- `POST /api/chat` on a live **human** turn: persist `turn.user` to the
  transcript, `inject`, emit `turn.user` on the live bus, answer
  `202 { injected: true }`. Everything ADR-0069 specified is the fallback:
  machine turns are still preempted-or-queued, and a closed channel falls
  through to the durable queue.
- The native client stops parking messages in its local `queuedMessages`
  when a turn is running: it echoes the bubble and POSTs; only a transport
  failure falls back to the local queue.

## Consequences

- Positive: typing while MARVIN works now *steers* it, the way the user
  expected from Claude Code; the message is on disk before delivery.
- Positive: nothing changes for machine turns (wakeups, job completions),
  which keep ADR-0069's preempt-or-queue rules — the registration-point
  re-check added the same day (`deferIfSessionBusy` at `registerLiveTurn`)
  closed the last eviction window.
- Negative / trade-off: where exactly the SDK applies a pushed message is
  the CLI's call — "process sequentially" means at the next assistant-turn
  boundary inside the query, not necessarily mid-tool-call. That is also
  Claude Code's behaviour, so it matches the reference, but "instant
  interruption" is not what this delivers; Stop (`/api/chat/cancel`) remains
  the interrupt.
- Negative / trade-off: cost/usage from intermediate `result` events are
  overwritten by the final one — the persisted `turn.completed` reflects the
  whole multi-message turn, not each segment.
- Follow-ups created: the web `use-chat-stream` client is gone (ADR-0075),
  so only the native client was updated; a per-segment cost split if the
  cost tracker ever needs it; render the bus `turn.user` for *other*
  attached clients (the sending client echoes locally).

## Alternatives considered

- Keep the ADR-0069 queue and drain it faster — rejected: the queue only
  runs after the turn ends; the user's complaint is precisely the wait.
- Abort + restart the turn with the new message appended — rejected: throws
  away in-flight work and is exactly the eviction ADR-0069 exists to prevent.
- Persistent streaming session for the whole chat (one `query()` across
  turns) — deferred: strictly more capable (true multi-turn in one process)
  but changes session-id/resume semantics for every turn; per-turn channels
  get the user-visible behaviour with the transcript/registry model intact.

## Scope of Done

- [x] `TurnInputChannel` (`turn-input.ts`) with unit tests: first message
      immediate, ordered delivery, wake-on-push, close semantics,
      `drainUnconsumed` returns anything not delivered.
- [x] `runAgent` runs streaming input when given a channel; closes it on a
      terminal `result` and in `finally`.
- [x] `runDetachedTurn` wires `liveTurn.inject`, closes the channel on
      return, re-queues unconsumed messages durably.
- [x] `POST /api/chat` injects into a live human turn (persist → inject →
      bus event → 202), falling back to ADR-0069 behaviour otherwise.
- [x] Native client sends immediately during a turn (`injectMessage`), echoes
      the bubble, falls back to the local queue only on transport failure.
- [ ] Verified live: send two messages while a turn runs; both appear in the
      transcript as `turn.user` and the model acts on them before the turn
      ends. (Needs a relaunch of the installed build.)

## Related

- Files: `sidecar/packages/runtime/src/turn-input.ts`,
  `sidecar/packages/runtime/src/sdk-runner.ts`,
  `sidecar/packages/runtime/src/turn-registry.ts` (`LiveTurn.inject`),
  `sidecar/src/lib/turn-orchestrator.ts`, `sidecar/src/app/api/chat/route.ts`,
  `macos/MARVIN/ChatService.swift` (`injectMessage`),
  `macos/MARVIN/ChatPreviewView.swift` (`send` / `injectRequest`)
- Supersedes / superseded by: narrows ADR-0069 (queue becomes the fallback,
  not the default, for human turns)

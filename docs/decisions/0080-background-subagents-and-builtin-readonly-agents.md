# ADR-0080 — Scouts run in the background; the runner must not kill them

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** [ADR-0014](./0014-scout-subagents-read-only.md) (scout),
  [ADR-0058](./0058-parallel-graph-extraction-scoped-write-subagent.md) (graph-extractor),
  [ADR-0076](./0076-mid-turn-steering-streaming-input.md) (the intermediate-`result` shape this reuses),
  [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (the rename fix that made the dispatch gate live again)

## Context

> "I want our Marvin to work faster. Currently waiting for 1 agent to finish
> something and then continuing with something else kills our speed." — user

The complaint has a precise cause. `SCOUT_AGENT` and `graph-extractor` set no
`background` field, and the SDK's default for the Agent SDK is **foreground**:
the parent turn blocks on the dispatch until the subagent returns. MARVIN's
one sanctioned form of parallelism — read-only research fan-out — was being
executed serially. Golden Rule 1 was never the bottleneck; the wiring was.

Flipping the flag is one line. What made it a decision is what the runner
does at a `result`: close the input channel and arm a 5 s watchdog that
force-aborts the subprocess. A background scout still running at that moment
would have been killed silently, five seconds after dispatch.

### What was verified live, not read off a doc

Probe on SDK 0.3.245, Haiku, streaming input held open (2026-08-29):

| t | event |
|---|---|
| +6.1 s | `Agent` dispatched, `background_tasks_changed` reports one live task |
| +8.3 s | main turn `result: success` — the model said STARTED and stopped |
| +8.4 s → +35.0 s | subagent keeps running **past the main result** |
| +35.0 s | `background_tasks_changed: []`, then `task_notification: completed` |
| +35.1 s → +37.7 s | **the CLI re-prompts the main model** — a second assistant turn and a second `result` inside the same query |

Two further facts from the same run: the background subagent's own tool
inventory included `mcp__…` servers, so **`marvin-graph` survives and
graph-first still holds for scouts**; and closing the input channel after the
first `result` did *not* stop the re-prompt — the CLI waits for background
tasks before exiting on its own.

Anthropic's docs agree with the probe: "the task keeps running and emits a
task_notification when it settles"; background subagents "run concurrently
while you continue working".

## Decision

1. **`background: true` on `scout` and `graph-extractor`.** The advisor stays
   foreground — its verdict gates the next decision, so blocking there is
   correct.

2. **The runner tracks live background tasks and treats a `result` as
   intermediate while any exist.** `BackgroundTaskLedger` consumes the SDK's
   `background_tasks_changed` — a *level* signal with REPLACE semantics, chosen
   over pairing `task_started`/`task_notification` edges for the SDK's own
   stated reason: a missed bookend cannot wedge a stale "still running". While
   the ledger is non-empty, a `result` takes the same branch ADR-0076 added for
   injected messages: keep iterating, keep the channel open, do not arm the
   watchdog. A drain bound (`MARVIN_BACKGROUND_DRAIN_MAX_MS`, default 15 min)
   catches a subagent that never settles.

3. **Claude Code's built-in read-only agents `Explore` and `Plan` are
   sanctioned.** Six real dispatches in the transcript scan; confirm-gating a
   codebase search adds a click with no security value. The `claude` catch-all
   (every tool) stays gated.

4. **The prompt tells MARVIN what background means.** Dispatch, then keep
   working on everything that does not depend on the answer; never poll or
   sleep; if the next step does depend on it, say so and end the turn — the
   completion re-prompts. Independent scouts go out together in one message.

### Considered and not taken

- **Arming the watchdog when the ledger empties.** The follow-up model turn
  starts after the notification and can take tens of seconds on Opus with
  thinking; a 5 s watchdog would kill it mid-turn. The next `result` is the
  terminal signal; the drain bound is the safety net.
- **Backgrounding the advisor.** Its answer is the input to the decision
  being made. Foreground is the correct semantics, not an oversight.

## Consequences

- A scout dispatch no longer blocks the turn. The user's measured complaint
  is addressed at its cause.
- A turn can now carry more than one `result`. The macOS reducer already
  handles this (it marks streaming rows done and appends a quiet row per
  `result`); `turn.completed` still fires once, when `runAgent` returns.
- The invariant that a subagent cannot mutate the workspace is untouched —
  the gate keys on `agentID` on the inner calls, and background mode changes
  nothing about that.
- Not taken here, and the real question behind the user's ask: **parallel
  implementation on isolated worktrees.** The SDK primitive is reachable
  (background subagents keep `EnterWorktree`; `bgIsolation: 'worktree'`
  exists), and Anthropic's 2026-08-13 paper shows Sonnet 5 sustaining "high
  code sharing" with "high PR throughput" while its conformity failures are
  all shared-state failures. That would amend Golden Rule 1 from "cannot
  mutate the workspace" to "cannot mutate the *main* working tree" and needs
  its own ADR, gated on `scripts/session-time-breakdown.py` showing the wait
  is agents rather than turn-ends.

## Scope of Done

- [x] `scout` and `graph-extractor` carry `background: true`; advisor does not
- [x] `BackgroundTaskLedger` is fed from `background_tasks_changed` and a
      `result` with live tasks is deferred, with a bounded drain
- [x] `Explore` / `Plan` classify `auto`; `claude` still `confirm`
- [x] Scout protocol in `personality.ts` states the background semantics
- [x] Ledger, policy and personality changes are test-pinned
- [ ] Not in scope: worktree-isolated implementation subagents (needs ADR-0081)

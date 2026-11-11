# ADR-0130 — A session says what it is waiting on: `idle` stops meaning three things

- **Status:** Proposed (2026-11-11)
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (the watch feed), [ADR-0055](./0055-checkback-promise-auto-arm-guard.md) (wakeups), [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (stalls), [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §4 (what wakes the supervisor)
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md)

## Context

`deriveSessionState` (`sidecar/packages/runtime/src/session-watch.ts:136`) returns `working`, `idle`, `awaiting-you`, `failed` or `interrupted`. On a real project over 2026-11-09 → 11, with up to six tabs each waiting 25–55 minutes on a gate, `idle` covered three different things:

1. **The tab is done.** Last turn closed with the scope-met marker.
2. **The tab is waiting on its own background job or wakeup.** The row already knows: `supervisor.waitingOnOwn` is `"job" | "wakeup" | null` (`session-watch.ts:122, 449`). The top-level `state`, the tab dot and the Sessions pane do not use it.
3. **The tab stopped and nobody was told.** Two shapes, both seen on 2026-11-11:
   - a turn that ended with a question in prose ("Shall I go ahead with step 1?" under a `marvin:plan` marker): 25 minutes idle, no pending item, because only `AskUserQuestion` and confirms create one;
   - a tab refused a new background job by the chain cap (`MAX_CHAIN_DEPTH = 8`, `wakeup-scheduler.ts:38`, enforced in `background-jobs.ts:192`): the refusal is an error string to the model, the model wrote "send any message and I'll start it", and nothing reached the feed.

The owner asked twice why "no session is working" while four gates ran. The external supervisor's waiter fired a false "idle 25 min" alarm for case 2 dozens of times, and missed both shapes of case 3 until its 25-minute timer.

## Decision

**The watch row's `state` says what the session is waiting on, and the two silent stops become pending items.**

1. **Two new states**, derived, not stored:
   - `waiting`: not live, and `waitingOnOwn` is set. The row gains `waitingOn: { kind: "job" | "wakeup", label, since }` (the job's reason or first 60 characters of its command; the wakeup's reason).
   - `done`: not live, nothing pending, and the last turn closed with the scope-met marker. `idle` keeps its meaning for everything else, so an `idle` row is now a row worth a look.
2. **A turn that ends on a question is a pending item.** The Stop hook (`turn-close-hook.ts`) already reads the close; it gains one deterministic check: the final assistant text ends with a question addressed to the reader and the turn made no `AskUserQuestion` call and did not close scope-met. That raises a pending item `raisedBy: "prose-question"` with the last paragraph as its excerpt. No model call. A false positive costs one dismissible item; a false negative is today's behaviour.
3. **The chain cap raises an escalation instead of only an error string.** When `startBackgroundJob` or `enqueueWakeup` refuses for depth, the session gets a pending item `raisedBy: "chain-cap"` naming the refused command. Answering it (the user, or a supervisor with `answer-confirms`) resets the chain for that one job. The cap itself does not move.
4. **The row carries the last close marker** (`lastTurn.marker: "scope-met" | "plan" | null`), so a consumer does not parse transcripts for it.
5. **The macOS client** maps `waiting` and `done` in `SessionRowState` to their own dot and label ("Așteaptă un job · 31 min" is the project's language; MARVIN ships English: "Waiting on a job · 31 min", "Done").

## Consequences

- An `idle` tab becomes rare and meaningful. The supervisor loop's own filter (`supervisor-loop.ts:454`) already skips `waitingOnOwn`; it can now be woken by the two new pending kinds instead of a timer.
- API consumers that switch on `state` see two new values. The route is versioned by `x-marvin-client`; the external tooling in use treats unknown states as idle.
- The prose-question check is a heuristic and will sometimes fire on a rhetorical question. It is a `nudge`-tier practice row (`builtin:prose-question`) so it can be measured and switched off (ADR-0104 brakes).

## Alternatives considered

- **Leave `state` alone and document `waitingOnOwn`.** Fixes external consumers, not the owner's screen, and not case 3.
- **Ask a model whether the turn ended on a question.** A model in the close path of every turn, for a check a suffix test does well enough to start.
- **Raise the chain cap.** The cap exists for runaway chains; four legitimate gate retries plus their completion turns reach eight honestly. Exempting "jobs that are gates" needs project knowledge (Golden Rule 6). An escalation keeps the cap and shows the stop.

## Open questions (recommended answer first)

1. `done` as a state, or `idle` plus the marker? **A state**: the dot is what the owner reads.
2. Does a `prose-question` item block a supervisor from sending a message? **No**: it is advisory; answering it is just a message.
3. Should `waiting` expire into `idle` after N hours? **No**: the job ledger and its six-hour recovery window already bound it.

## Scope of Done

- [ ] `deriveSessionState` returns `waiting` and `done`; pinned by tests for each of the five inputs that used to read `idle`.
- [ ] A turn ending on a question with no `AskUserQuestion` raises a `prose-question` pending item; a scope-met close and a rhetorical mid-text question do not (tests).
- [ ] A chain-cap refusal raises a `chain-cap` pending item; answering it lets exactly one job start (test).
- [ ] `lastTurn.marker` is in the row.
- [ ] The Sessions pane and the tab dot show `waiting` (with what and since when) and `done`.

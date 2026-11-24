# ADR-0130 — A session says what it is waiting on: `idle` stops meaning three things

- **Status:** Accepted (2026-11-11), with the amendments under "Decisions" below; build plan in [`docs/plans/supervision-improvements.md`](../plans/supervision-improvements.md)
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

## Decisions (2026-11-11, by the owner's delegation, after checking the text against the code)

The three open questions are answered as recommended. Five amendments, where the text above and the code disagree; where they conflict, this section wins.

1. **The two silent stops are a session `attention` record, not entries in `pending`.** The row's `pending` array holds the live turn's confirms only (`listPendingConfirms(turn.turnId)`), each answerable through `/api/confirm` by `toolUseId`. A prose question and a chain-cap refusal belong to a turn that has ended and are answered by a message. They are stored as `SessionMeta.attention: { kind: "prose-question" | "chain-cap", excerpt, since, turnId }`, set when the turn ends and cleared when the session's next turn starts or the user dismisses it. The row carries `attention`, and a row that is not live with `attention` set reads **`awaiting-you`**. This works with the supervisor off, which the supervisor inbox would not.
2. **The detector is the one that exists.** `classifyTurnEnding` (`practice-extractors.ts`) already returns `asked` and `blocked-on-human`, and the Stop hook already uses it. No new heuristic is written. No item is raised when the turn called `AskUserQuestion`, closed scope-met, or the session is waiting on its own job or wakeup.
3. **`lastTurn.marker` is `"scope-met" | null`.** There is no plan sentinel in the runtime to read a `"plan"` value from. The marker is derived from `scopeMetAt`, which the session meta already records.
4. **Answering a chain-cap item is sending a message; no new reset is built.** A turn started by a message runs at chain depth 0 already (`depth: input.wakeupDepth ?? 0`). The bound that keeps the cap meaningful: a supervisor at `answer-confirms` may restart **once** per chain-cap item; a second cap on the same session before any user turn is the user's. The refusal text the model sees says the user has been told, so the model stops instead of inventing an instruction. The wakeup cap is enforced in `scheduleWakeup`; `enqueueWakeup` is the boot-recovery path and has no cap by design.
5. **State precedence**, pinned by tests: live with a confirm → `awaiting-you`; live → `working`; `attention` → `awaiting-you`; a recent interruption → `interrupted`; error → `failed`; waiting on its own job or wakeup → `waiting`; `scopeMetAt` set → `done`; otherwise `idle`. A call to action outranks a wait. `supervisor.waitingOnOwn` stays in the row for existing consumers.

## Scope of Done

- [ ] `deriveSessionState` returns `waiting` and `done`; pinned by tests for each of the five inputs that used to read `idle`.
- [ ] A turn ending on a question with no `AskUserQuestion` raises a `prose-question` pending item; a scope-met close and a rhetorical mid-text question do not (tests).
- [ ] A chain-cap refusal raises a `chain-cap` pending item; answering it lets exactly one job start (test).
- [ ] `lastTurn.marker` is in the row.
- [ ] The Sessions pane and the tab dot show `waiting` (with what and since when) and `done`.

## Addendum (2026-11-24) — an honest wait clock, and a structural mark for a restart

**Why.** The 2026-11-24 UX review ([`docs/reviews/2026-11-24-ux-review/ROUND2.md`](../reviews/2026-11-24-ux-review/ROUND2.md), R2-04, R2-10; README W-05, R-01) measured a tab 13 minutes on the commit gate whose row said "3 min": `waitingOn.since` is one wait's start, and a tab that waits job after job re-arms a new wait after every result, so `since` restarts and the amber threshold (15 min) never fires for the worst case. `since` can also be older than the tab's later activity. And a restart that re-queues a job left only the free-text reason "background job interrupted: …", so nothing could mark the tab without matching on prose. (This addendum lives here, not in ADR-0107's text, because ADR-0130 is the ADR that introduced `waitingOn`; ADR-0107 carries a one-line pointer.)

**Decision.** `waitingOn` keeps `since` and gains three optional fields, and the response gains one:

1. `waitingSince` — the start of the **unbroken stretch** in which the session has been waiting, never later than `since`. Recorded on the session meta (`waitStretch: { since, cause? }`) at turn boundaries by `wait-stretch.ts`, so a sidecar restart does not reset it, and validated where read (`readWaitStretch`: a bad time is no stretch, an unknown cause is dropped).
2. **The "real work" rule.** A stretch ends when (a) a turn finishes with nothing pending, (b) a turn **edits files** (`Edit`, `Write`, `NotebookEdit`, `MultiEdit`, flagged on the live turn at the permission gate), or (c) a person's or the supervisor's turn starts on a tab with nothing pending (a stale record, e.g. a job cancelled from the app). Anything else leaves it running. **Why not "any tool other than re-arming":** in measured gate-lane sessions almost every wake turn runs `tail`, `sed`, `grep` or a graph call before re-arming, so that rule would break the stretch on every turn and fix nothing. **Why Bash is never an edit:** reading and writing cannot be told apart from a command line (`isMutatingToolCall` already calls `cd … && sed` mutating). The cost of the narrow rule: a turn that edits a file by script (`python3 - <<EOF`) does not end a stretch, so the clock errs long, never short.
3. `jobs` — background jobs plus own wakeups pending now (a supervisor's wakeup is not the tab's wait).
4. `cause: "restart"` — set structurally: `recoverInterruptedJobs` stamps the wakeup it re-creates (`WakeupRecord.cause`) and marks the session's stretch, continuing an existing one or starting it at the interrupted job's start. The stretch's cause carries to a wait the model arms afterwards (the "gated commit rerun after restart" case), until the stretch ends. Nothing matches on `reason`. The type leaves room for more causes; clients ignore unknown ones.
5. `GET /api/sessions/watch` answers `sidecarStartedAt` (ISO, from `process.uptime()`), so the app can say "since the restart at HH:MM".

All new fields are optional; the Swift feed decoder reads them as optionals and a row or response without them decodes as before. Shape and rule are in [`docs/reference/api.md`](../reference/api.md).

**Sessions already waiting when this lands.** The sidecar restart that ships it is itself a restart: tabs with a job in the ledger get the `restart` cause. A tab already waiting on a wakeup has no recorded stretch, so its `waitingSince` equals `since` until its next turn ends waiting (that turn starts the stretch from the earliest pending wait). The clock is never made longer than the sidecar can prove.

**Known limit.** A wait that ends with no turn after it (a job cancelled from the app, a wakeup dropped as stale) leaves its stretch on the meta until the next turn's start or end clears it.

**Scope of Done (addendum).**
- [x] `waitingOn.waitingSince`, `jobs` and `cause` are in the watch row; `since` is unchanged; `sidecarStartedAt` is in the response (`session-watch-wait.test.ts`).
- [x] The stretch survives a re-arm and a read from disk; it ends on the three conditions and not on a Bash command or a re-arm (`wait-stretch.test.ts`).
- [x] Restart recovery marks the wakeup and the stretch with `cause: "restart"` and no code reads the reason text (`background-jobs.test.ts`).
- [x] The Swift decoder reads all four as optionals and decodes rows and responses without them (`watch-feed-wait-clock` suite).
- [ ] Not in this change: the pane's row text, the amber threshold taken from `waitingSince`, and the restart banner that names the re-queued tabs (the macOS UI, another change).

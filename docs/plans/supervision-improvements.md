# Plan: what supervising real tabs showed (hand-over for the session that builds it)

Written 2026-11-11 by the external supervising session. Nothing here is built. Everything is **Proposed**: the owner decides each ADR before code is written.

## Read first

1. [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md): what was seen over two days on a real project, what goes well, what costs time, and **two first impressions that reading the code disproved** (boot recovery of jobs exists; `waitingOnOwn` is already in the watch row). Start there so the same mistakes are not built for.
2. The five ADR proposals, in the order they are worth building:

| Order | ADR | What | Size | Depends on |
|---|---|---|---|---|
| 1 | [0130](../decisions/0130-a-session-says-what-it-is-waiting-on.md) | `waiting` and `done` states; a prose question and a chain-cap refusal become pending items; `lastTurn.marker` | M | nothing |
| 2 | [0131](../decisions/0131-a-project-notice-reaches-running-tabs.md) | expiring project notices in the reminder suffix; `post_notice` verb | S–M | nothing |
| 3 | [0132](../decisions/0132-the-supervisor-may-say-go-ahead-inside-the-seeded-spine.md) | `continue_plan`: fixed-text go-ahead when every step joins the seeded spine; shadow first | M | 0130 (the `prose-question` item) |
| 4 | [0133](../decisions/0133-an-approved-queue-the-user-approves-a-list-once.md) | approved queue, per-project cap, `after` ordering, `openGuard`, `scopeRef` check | L | nothing; amends ADR-0127 §7 |
| 5 | [0134](../decisions/0134-a-standing-merge-authorisation-behind-the-gate.md) | standing, expiring merge authorisation into one local branch behind a project gate | L | nothing; amends ADR-0127 §6 and ADR-0109 |

0130 and 0131 change MARVIN for every user and widen no authority. 0132–0134 widen the supervisor's authority; ADR-0127 requires an ADR for that, and each is written as the narrowest form that would have covered what happened.

3. The roadmap entry at the top of `## In flight` in [`docs/roadmap.md`](../roadmap.md), which also lists four follow-ups that need no decision (API-opened tabs and the tab bar; a job started twice; `graphify-out` snapshot growth; a supervisor handover note).

## Where the code is (checked 2026-11-11, by graph then by reading)

- Watch feed and the state rule: `sidecar/packages/runtime/src/session-watch.ts` (`SessionWatchState` L47, `deriveSessionState` L136, `waitingOnOwn` L122 and L449).
- Chain cap: `MAX_CHAIN_DEPTH` in `wakeup-scheduler.ts:38`; enforced for jobs in `background-jobs.ts:192` and for wakeups in `wakeup-scheduler.ts:275`.
- Boot recovery: `recoverInterruptedJobs` (`background-jobs.ts:413`), called from `sidecar/src/instrumentation.ts:98`; interrupted turns in `session-recovery.ts`.
- Close-of-turn hook: `turn-close-hook.ts`. Seeded spine: `plan-seed.ts`. Supervisor: `supervisor-policy.ts`, `supervisor-loop.ts` (the `waitingOnOwn` filter is at L454).
- Client side: `macos/MARVINLogic/SessionRowState.swift`, `SessionFeed.swift`.

Line numbers drift; re-find with `graphify query` before editing (Golden Rule 7).

## Before building

- Each ADR has open questions with a recommended answer. The owner has said audits' design questions may be decided by a separate session; these are MARVIN design decisions, so ask the owner which rule applies here.
- Not verified, and worth five minutes each before relying on them: whether a tab opened by another process through `/api/chat` appears in the Sessions pane; why one tab started the same background job twice.
- The external tooling that produced the evidence lives outside this repo in `~/marvin-supervisor/` (dispatcher, merge runner, event watcher). It is the working prototype of 0133 and 0134 and of the event list in the field notes; read it for behaviour, do not port it.

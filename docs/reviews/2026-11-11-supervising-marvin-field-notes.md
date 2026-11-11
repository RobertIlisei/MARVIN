# Field notes: two days of supervising MARVIN tabs from outside (2026-11-09 → 2026-11-11)

Written by the external supervising session (Claude Code, `~/marvin-supervisor/`) at the owner's request. Project supervised: one real project, about 45 branches merged in the period, up to six tabs open at once, each tab waiting 25–55 minutes per commit on an external test gate. Every observation below was seen in that session. Where MARVIN's code was read to check a claim, the file is named; where it was not, the cause is marked **unverified**.

## Corrections to what was first said in chat

Two findings did not survive reading the code, and are recorded so nobody builds for them:

- **"A restart loses in-flight jobs quietly" is wrong.** `recoverInterruptedJobs` (`sidecar/packages/runtime/src/background-jobs.ts:413`, called from `sidecar/src/instrumentation.ts:98`) reports every job the ledger still holds to its session at boot, inside a six-hour window, and `session-recovery.ts` marks a cut-off turn `interrupted`. On 2026-11-10 MARVIN restarted at 17:15:06 and the supervisor messaged the tabs at 17:16–17:17, racing the recovery wakeups (one tab answered "this wakeup is stale"). The recovery worked; the supervisor did not know it existed.
- **"The watch feed cannot tell a waiting tab from a finished one" is half wrong.** `SessionWatchRow.supervisor.waitingOnOwn` is `"job" | "wakeup" | null` (`session-watch.ts:122, 449`), and `worktree.commits` / `worktree.dirty` are in the row. The external tooling read only `state`, which says `idle` for all three cases. What is missing is narrower: see ADR-0130.

The lesson for the supervisor design is itself a finding: a supervisor that does not know what the runtime already does will duplicate it and race it.

## Going well

- **A worktree per tab holds.** About 45 branches in two days and no tab damaged another's tree. The only cross-tab damage was at merge, in files several tabs append to.
- **The honesty rules work in practice.** Tabs refused the scope-met close when one bullet of the Definition of Done was unmet, reopened backlog items with "what landed, what is left", and one tab stopped and cited the owner's recorded decision when the supervisor's brief contradicted it.
- **Background jobs with a completion turn** make a 40-minute gate workable; tabs read the gate log and fixed the cause themselves, often several rounds in a row.
- **The Agent SDK 0.3.301 upgrade** and the Fable 5.2 advisor went in without a behaviour change anyone noticed.
- **`AskUserQuestion` surfaces as `awaiting-you`** with the question text, and `/api/confirm` answers it.

## Costly

1. **`state: "idle"` is three states.** Finished, waiting on its own job, and stopped after asking something in prose all read `idle`. The owner asked twice why "no session is working" while four gates ran. Most supervisor wake-ups in the period were false "idle 25 min" alarms.
2. **A question asked in prose raises nothing.** On 2026-11-11 a tab ended a turn with "Shall I go ahead with step 1?" under a `marvin:plan` marker and sat 25 minutes; only `AskUserQuestion` becomes a pending item.
3. **The job-chain cap strands a tab.** After four failed gate attempts a tab hit `MAX_CHAIN_DEPTH = 8` (`wakeup-scheduler.ts:38`, enforced at `background-jobs.ts:192`), could not start a fifth background job, and waited for a human message. The refusal is an error string returned to the model; nothing reaches the feed.
4. **A fact cannot be told to running tabs.** "The test machine is back", "the test config moved to one file per project" each needed one message per tab, and each message is a turn.
5. **Tabs opened through the API are not in the owner's tab bar.** They are in the Sessions pane (unverified in the Swift code; the owner did not find them).
6. **Files that every tab appends to** (a release precheck, a deploy-check table, a test config's project list) bounced nine merges. That is the project's problem, fixed there (a union merge attribute; one file per entry). MARVIN's part is only that nothing predicted it: the watch row knows each tab's changed files.
7. Smaller: a background job was started twice eight seconds apart by one tab (cause unverified); `graphify-out` snapshot folders grow by about 600 MB each and were pruned by the supervisor's script.

## What would be changed

In MARVIN itself: ADR-0130 (a session says what it is waiting on) and ADR-0131 (a project notice reaches running tabs). Follow-ups that need no decision are in `docs/roadmap.md` under "In flight".

## What would help the built-in supervisor (ADR-0127, ADR-0128)

What the external supervisor actually did, by count, over the period: relayed a fact to tabs (about 20 times), told a tab how to resolve a merge conflict (12), answered a question or approved a plan (6), restarted a stalled tab (3), opened a tab from a queue the owner had approved (about 30), merged a finished branch behind the gate (about 45). The owner kept: scope (twice), the tab cap (three times), everything on production.

Against ADR-0127 that gives five gaps:

1. **It needs events, not polling**: job finished, question asked (tool or prose), chain capped, scope-met close, commit landed, a conflict predicted between two open tabs. The first four are ADR-0130.
2. **Plan approval is the largest stall and is human-only today.** Every plan approved in the period was "the brief is the plan". ADR-0132.
3. **One confirmed tab per request does not match how the owner works.** The owner approved a list once and expected tabs to open as slots freed. ADR-0133, which also checks a brief against the plan's recorded scope: the supervisor's one real mistake was queueing three items the owner had deferred.
4. **Merging is human-only.** The owner gave a standing instruction and the gate did the judging. ADR-0134.
5. **It must know what the runtime already does** (the two corrections above) and keep state that survives compaction: the ledger exists; a handover the next wake reads does not. Roadmap follow-up, no ADR.

Gaps 2–4 widen the supervisor's authority. ADR-0127 says that needs a new ADR; each of the three is one, Proposed, with the narrowest form that would have covered what happened.

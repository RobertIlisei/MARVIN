# Supervision improvements — implementation plan

- **Decisions:** [ADR-0130](../decisions/0130-a-session-says-what-it-is-waiting-on.md), [ADR-0131](../decisions/0131-a-project-notice-reaches-running-tabs.md), [ADR-0132](../decisions/0132-the-supervisor-may-say-go-ahead-inside-the-seeded-spine.md) (in part), [ADR-0133](../decisions/0133-an-approved-queue-the-user-approves-a-list-once.md), [ADR-0134](../decisions/0134-a-standing-merge-authorisation-behind-the-gate.md). Each ADR's "Decisions (2026-11-11)" section amends its text and wins where they differ.
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md). Read its two corrections first: boot recovery of jobs exists, and `waitingOnOwn` is already in the watch row.
- **Written:** 2026-11-11. The hand-over from the external supervising session was analysed against the code the same day, the open questions were decided by the owner's delegation, and this plan replaces the hand-over.
- **Status:** milestones [1]–[6] built 2026-11-11 by Sonnet 5.5 implementers on isolated worktrees, each reviewed, and merged to local `main` (`ef3e6764`). On the merged tree: 2,803 sidecar tests pass, three typechecks are clean, and MARVIN.app builds. Not yet exercised in the running app. [4.5] (measure the go-ahead rule for a release) is open. See "What the build changed" below.
- **Branch discipline:** each milestone lands on its own tab branch; the user merges. Milestones [1]–[4] are independent of [5] and [6] and widen no authority.

## What the code check changed

Six things the ADR texts got wrong or left open, each now decided in the ADR it belongs to:

| # | Finding | Decided in |
|---|---|---|
| 1 | `pending` in the watch row is the live turn's confirms only; an ended turn has nowhere to hold a pending item | ADR-0130 decision 1: `SessionMeta.attention`, row reads `awaiting-you` |
| 2 | The prose-question detector already exists (`classifyTurnEnding`); `scopeMetAt` already exists; there is no plan sentinel for `lastTurn.marker: "plan"` | ADR-0130 decisions 2 and 3 |
| 3 | A message-started turn already runs at chain depth 0, so "answering resets the chain" needs a bound, not a mechanism | ADR-0130 decision 4 |
| 4 | The `send` word list would refuse real notices ("release", "merge", "CI") | ADR-0131 decision 1: a match becomes a card |
| 5 | The `[N]` join reads `TodoWrite`, not prose; the Stop hook can clear the go-ahead stall with no supervisor | ADR-0132 decisions 1 and 2: hook rule first, verb deferred |
| 6 | `openGuard` in `worktree.json` is repository-controlled code the runtime would execute; the merge pass would hold the main checkout mid-merge for the length of a gate run | ADR-0133 decision 1, ADR-0134 decision 1 |

## Where the code is (checked 2026-11-11, by graph then by reading)

Line numbers drift; re-find with `graphify query` before editing (Golden Rule 7).

| Area | File | Symbols |
|---|---|---|
| Watch row and state rule | `sidecar/packages/runtime/src/session-watch.ts` | `SessionWatchState`, `SessionWatchRow`, `deriveSessionState`, `buildSessionWatch` |
| Session meta | `sidecar/packages/runtime/src/session-meta.ts` | `SessionMeta`, `SessionLastTurn`, `nextScopeMetAt` (the pattern `attention` copies) |
| Turn ending | `practice-extractors.ts` `classifyTurnEnding`; `turn-close-hook.ts` `decideTurnClose`, `decideSeededClose`, `makeTurnCloseStopHook`; hook wiring in `sdk-runner.ts` | |
| Chain cap | `wakeup-scheduler.ts` `MAX_CHAIN_DEPTH`, `scheduleWakeup`; `background-jobs.ts` `startBackgroundJob`; both called from `wakeup-tools.ts`; depth set in `sdk-runner.ts` (`input.wakeupDepth ?? 0`) | |
| Reminder suffix | `sdk-runner.ts` | `turnReminders` |
| Protected paths at the gate | `sdk-runner.ts` | `mutatesProtectedPath` and the memory / plans deny blocks |
| Built-in practice rows | `practice.ts` | `BUILTIN_RULE_IDS`, `BUILTIN_NATIVE_TIER`, `builtinGate` |
| Seeded spine and the join | `plan-seed.ts` `seededOpenSteps`, `hasSeededPlan`; `plan-spine.ts` `applyTodosToSpine`, `parsePlanTag` | |
| Supervisor | `supervisor-loop.ts` (triggers `question`, `confirm`, `scope-met`, `turn-ended`, `idle`, `message`); `supervisor-policy.ts` (`evaluateSend`, `questionHeuristic`); `supervisor-mcp.ts` (`SUPERVISE_TOOL_NAMES`, `createSupervisorVerbs`); `supervisor-inbox.ts` (`INBOX_KINDS`, `addInboxItem`); `supervisor-inbox-perform.ts` (`openSupervisorTab`); `supervisor-state.ts` (`AUTONOMY_CATEGORIES`, `supervisorDir`) | |
| Worktrees and merging | `worktrees.ts` `reconcileWorktrees`, `mergeAllWorktrees`; `integration.ts` `previewIntegration`; `worktree-setup.ts` `readWorktreeSetupConfig` | |
| Client | `macos/MARVINLogic/SessionRowState.swift`, `SessionLedger.swift`, `SessionFeed.swift`, `SupervisorWire.swift`; `macos/MARVIN/SessionsPane.swift`; fixtures in `SurfaceSnapshotRoutesMore.swift`; tests in `macos/MARVINTests/main.swift` | |

## Milestone [1] — a row says `waiting` or `done` (ADR-0130 §1, §4, §5)

No new store, no new authority. Small.

- [1.1] `SessionWatchState` gains `"waiting"` and `"done"`. `deriveSessionState` takes three more inputs (`attention`, `waitingOn`, `scopeMet`) and applies the precedence in ADR-0130 decision 5. Tests pin each of the five inputs that used to read `idle`, plus "failed outranks waiting".
- [1.2] The row gains `waitingOn: { kind: "job" | "wakeup", label, since } | null`. For a job: its reason, or the first 60 characters of its command, and `startedAt`. For a wakeup: its reason and `createdAt`. `buildSessionWatch` already reads the wakeup store once per build; keep the record instead of only the session id. `supervisor.waitingOnOwn` stays.
- [1.3] `lastTurn.marker: "scope-met" | null` in the row, derived from `meta.scopeMetAt`.
- [1.4] Client: `SessionRowState` gains `.waiting` and `.done`, mapped from the wire `state`, each with its own dot and label ("Waiting on a job · 31 min", "Done"). `done` collapses with idle rows; `waiting` stays visible. A client that meets an unknown state string keeps reading it as idle. One `waiting` and one `done` row are added to the snapshot fixtures.
- [1.5] Check, while in the Swift code: does a tab opened by another process through `/api/chat` appear in the Sessions pane? Record the answer in the roadmap follow-up; fix only if it is a one-line omission, otherwise leave it as the follow-up it is.

**Done when:** the first, fourth and fifth bullets of ADR-0130's Scope of Done hold, with the marker as amended.

## Milestone [2] — the two silent stops reach the user (ADR-0130 §2, §3)

Depends on [1] (the `attention` input of the state rule).

- [2.1] `SessionMeta.attention` and a pure transition `nextAttention`, shaped like `nextScopeMetAt`: any turn start clears it; a turn end sets it or leaves it. Tests for the transition.
- [2.2] Prose question. Where the turn end already computes the scope-met fact, raise `attention { kind: "prose-question" }` when `classifyTurnEnding` returns `asked` or `blocked-on-human`, the turn made no `AskUserQuestion` call, and the session has no job or wakeup of its own pending. The excerpt is the final paragraph, capped. Governed by a new built-in row `builtin:prose-question` (native tier `nudge`; switched off, nothing is raised). Tests: a closing question raises; a scope-met close does not; a question in the middle of the text does not; a turn with `AskUserQuestion` does not.
- [2.3] Chain cap. `startBackgroundJob` and `scheduleWakeup` return a refusal code for depth, not only a string. `wakeup-tools.ts` notes the refusal on the turn; the turn end writes `attention { kind: "chain-cap" }` naming the refused command or reason, and it outranks a prose question from the same turn. The text the model sees changes to say the user has been told and the turn should end.
- [2.4] The row carries `attention`; a not-live row with it set reads `awaiting-you`. A user route dismisses it; sending the tab a message clears it at turn start.
- [2.5] Supervisor. A new wake trigger `attention`, enqueued from the turn-ended event when the record is set, for a tab the supervisor may act on. It answers with the existing `send` verb and policy; the question text goes through `questionHeuristic` as well as the reply. For a chain-cap item: `answer-confirms` is required, and one restart per item (counted in the ledger by the item's `since`); a second cap before any user turn escalates. Test: a supervisor-started turn runs at depth 0 and the job starts; the second attempt escalates.
- [2.6] Client: an attention row counts as "needs you", shows the excerpt and a Dismiss action.

**Done when:** the second and third bullets of ADR-0130's Scope of Done hold, as amended by decisions 1, 2 and 4.

## Milestone [3] — project notices (ADR-0131)

Independent of [1] and [2].

- [3.1] `notices.ts`: the store at `<workDir>/.marvin/notices.json`, keyed on `workDir`, never a session's `cwd`. The reader validates: at most 8 live entries, text at most 400 characters with control characters removed, an expiry required and at most 7 days out, `author` one of two values; anything else is dropped. Tests for over-long, expired and malformed entries.
- [3.2] `turnReminders` takes the rendered block and appends it. The block's label says it is information about the environment and neither consent nor a change of scope. Test: two tabs' next turns and a later tab's first turn carry a live notice, and `buildTurnSystemPrompt`'s bytes are unchanged.
- [3.3] Gate: `.marvin/notices.json` joins the protected-path deny (Edit, Write, mutating Bash). The notices route is user-only and joins the control routes a tab cannot reach. Tests for both.
- [3.4] Supervisor verb `post_notice` with `evaluateNotice`: allowed as in ADR-0131 decision 2; a word-list match raises a card whose click posts the notice; secret-shaped text is refused; every outcome is ledgered.
- [3.5] Client: "Tell every tab…" in the Sessions pane, with the live notices listed and a retire action on each.

**Done when:** ADR-0131's Scope of Done holds, with the card in place of a refusal for a word-list match.

## Milestone [4] — the go-ahead rule (ADR-0132 decision 1)

Independent. Replaces the `continue_plan` verb for now.

- [4.1] `builtin:go-ahead` in `practice.ts`: title, fingerprint, message, native tier `nudge`.
- [4.2] `decideGoAheadClose` in `turn-close-hook.ts`, pure. It needs two facts the hook does not pass today: the turn's mode, and whether the turn called `AskUserQuestion`. It blocks once per turn when every condition in ADR-0132 decision 1 holds. "Offers no alternative" is decided by text: the final paragraph holds one question and it matches a short go-ahead pattern list; anything else is left to end as it does today. It applies to machine turns too, because a tab opened by the supervisor or the queue starts on one.
- [4.3] Wiring in `makeTurnCloseStopHook`, with the same telemetry shape as the plan-spine gate: `measured`, `nudge`, `block`. One block per turn; it never fires when the SDK's `stop_hook_active` is set.
- [4.4] Tests, one each: blocks on the 2026-11-11 text ("Shall I go ahead with step 1?") with a seeded spine in Agent mode; does not block in Plan mode, with no seeded spine, with all seeded steps closed, when `AskUserQuestion` was called, when the question offers a choice, when the turn's `TodoWrite` added a step that does not join.
- [4.5] After one release with the rule promoted to `deny` on a real project, count `prose-question` attention items on seeded tabs and decide whether to build `continue_plan` (ADR-0132 decision 2). Record the count in the ADR.

**Done when:** the rule exists as a Practice row at `nudge`; promoted, it turns the recorded stall into a continuation in the same request; each negative case in [4.4] is pinned.

## Milestone [5] — the approved queue (ADR-0133)

Large. Widens the supervisor's authority; nothing opens without the user's click on a list.

- [5.1] The store (`queue.json` in the supervisor dir) and the approval card: a new inbox kind, the entries listed with each brief's first lines, approve all or a subset. An entry the model wrote and the user did not approve never opens (test).
- [5.2] The opener, in the runtime: woken by a tab closing, a branch reaching the derived `merged` state, and an approval. It opens the next entry when open tabs are under the cap (every non-supervisor tab counts), every `after` entry is merged, the disk floor holds and the guard passes. Each tab goes through `openSupervisorTab` and ADR-0122's atomic path at the approved posture. One opener per project: a lock in the data dir recording its pid, cleared at boot when the pid is gone. Tests: two openers cannot both open; the cap holds under a burst; `after` holds an entry.
- [5.3] The cap: a per-project number in the Supervisor workspace, default 1. A supervisor verb lowers it for the length of an alarm and restores it, both ledgered; raising is refused (test).
- [5.4] The guard command: stored with the queue, set and changed only by a card that shows it in full. Run with the `env` map's rules and a timeout; a non-zero exit holds the queue and is ledgered. A changed command does not run until approved again (test).
- [5.5] `scopeRef`: at open time the entry's id must still appear under its heading and not under one of `worktree.json`'s `deferredHeadings` (validated where read). A miss holds the entry and escalates with both lines. An entry unopened after 7 days expires. A card for more than five entries with no `scopeRef` shows a warning.
- [5.6] Client: the queue in the Supervisor workspace, with order, cap, holds and the reason for each hold.

**Done when:** ADR-0133's Scope of Done holds, with the guard as amended by decision 1.

## Milestone [6] — the standing merge authorisation (ADR-0134)

Large, and the widest. Build after [5]: it reuses the guard command and the pid lock.

- [6.1] The authorisation: `{ target, gate, holds, expiresAt }` in the supervisor dir, created by a card that shows the gate command in full, at most 14 days, shown in the workspace at all times, revoked in one click. With none, ADR-0109's path is unchanged (regression test).
- [6.2] The pass, for each `ready` branch, oldest first: refuse a tab not closed scope-met and a dirty tree; predict with `previewIntegration` and send a conflict back to the tab with the file list; then, in a scratch worktree cut detached at `target` and set up like a tab's, merge and commit, run the gate with a timeout, and on exit 0 fast-forward `target`. Anything else discards the scratch tree and reports the failing lines to the tab. If `target` moved during the gate, discard and retry. The fast-forward waits while the main checkout holds `target` with uncommitted changes or a live shared-checkout turn. Tests, one per refusal; the git argv is asserted to contain no push and no tag.
- [6.3] One pass at a time: the pid lock of [5.2], cleared at boot. Revoking stops before the next branch (test).
- [6.4] Holds: `{ pathGlob, window }` in local time; a branch touching the glob waits for the window. Verbs `hold_merge(branch, reason)` and `release_merge`: release undoes only the supervisor's own hold, never a window or a failed gate (test).
- [6.5] After a merge, close the tab only when its marker is scope-met and its worktree is clean; otherwise leave it open and list it.
- [6.6] Ledger and workspace: branch, prediction, gate exit code, commit, each hold and its reason.

**Done when:** ADR-0134's Scope of Done holds, with the scratch worktree of decision 1.

## What the build changed from the text above

- **[1]** Subtitles read "31m" (the pane's own elapsed helper), not "31 min". A stale interruption now falls through to `waiting` / `done` instead of always reading `idle`. Finding for [1.5]: a session opened through `/api/chat` by another process shows in the Sessions pane only while its turn is live, never in the tab bar, and drops out afterwards (no open-tab entry, no `closedAt`), so its `waiting` / `done` state is not visible. Not a one-line fix; left as the roadmap follow-up.
- **[2]** A new meta field `lastUserTurnAt` carries the "one supervisor restart before a user turn" bound. A shadow proposal counts as that one restart. The word list also runs over a chain-cap item's refused command. A supervisor-sent turn was confirmed to run at chain depth 0 (two tests).
- **[3]** The reminder block shows no author: `author` comes from a file in the repository and is not verified, so the block does not vouch for it (review fix). `post_notice` takes no grounds. A notice the supervisor posts appears in the pane after a reload, not live.
- **[4]** `seededStepCount` was added to `plan-seed.ts` for the `[N]` join. A choice mentioned before the final question does not stop the match.
- **[5]** The worktree sweep keeps a merged branch while a queued entry names it in `after`, and reclaims it once that entry opens; without this the derived `merged` state vanished at tab close. A successor waits until its predecessor's tab is closed. A tab counts toward the cap when unclosed and either live or touched in the last 7 days. A merge made by hand in a terminal is noticed at the next project event. Queued tabs open delegated at `answer-questions`.
- **[6]** The scratch worktree lives under the data dir (`merge-scratch/<projectId>/`), not `.marvin/worktrees/`, so the registry does not adopt it. Every git argv the pass issues goes through an allowlist (`argvViolation`), and the pass runs its merge with repository hooks off. **Only branches of closed tabs merge:** the derived `ready` state requires the tab's worktree to be closed, so an open scope-met tab is skipped, and a conflict or gate failure is recorded in the ledger and workspace because a closed tab cannot be messaged. Whether an open scope-met tab should be mergeable is an open decision. No supervisor verb proposes the authorisation; only the user's route raises the card.
- **Found, not fixed:** the `env` map's reserved names (ADR-0110) do not block `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n`, so a project-controlled `env` map can inject git config into any command that runs git.

## Follow-ups that need no decision

Still open in [`docs/roadmap.md`](../roadmap.md); none blocks a milestone.

- A tab opened through `/api/chat` and the owner's tab bar (checked in [1.5]).
- One tab started the same background job twice, eight seconds apart: refuse an identical command already running for the session. Cause unverified; read `startBackgroundJob`'s running-jobs check first.
- `graphify-out` snapshot folders in tab worktrees grow by about 600 MB each: bound them in the per-worktree refresh.
- A supervisor handover note the next wake reads, which also says what the runtime already does at boot.

## For every milestone

- Query the graph before reading source, and `graph_affected` before changing a symbol's signature (`deriveSessionState`, `turnReminders`, `startBackgroundJob` and `scheduleWakeup` all have callers and tests).
- Tests first (the `test-driven-development` skill); `pr-review` before the commit, and `security-audit` as well for [3], [5] and [6], which read project-controlled files or run commands.
- When a milestone lands: move its line in the roadmap, add the changelog entry, and write a "What milestone N changed" section here if the build departed from this text, as [`supervisor.md`](./supervisor.md) does.
- The external tooling in `~/marvin-supervisor/` is the working prototype of [5] and [6]. Read it for behaviour; do not port it.

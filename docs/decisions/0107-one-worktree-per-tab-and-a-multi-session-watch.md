# ADR-0107 — One worktree per chat tab, a project-wide session feed, lanes for shared tabs, and resume after a restart

- **Status:** Accepted — implemented 2026-09-09
- **Date:** 2026-09-09
- **Related:** [ADR-0081](./0081-implementer-subagents-on-isolated-worktrees.md) (implementer worktrees — the machinery this reuses), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (two sessions, one tree — **amended**: shared mode stays supported and becomes per-tab opt-in), [ADR-0103](./0103-implementer-branch-lifecycle.md) (worktree lifecycle — **amended**: a `session` state), [ADR-0043](./0043-server-turn-announcements.md) (the announce stream this extends), [ADR-0069](./0069-never-drop-a-user-message.md) (preemption rails the resume path inherits), [ADR-0072](./0072-session-list-must-not-parse-transcripts.md) (no transcript parsing on the hot path), [ADR-0062](./0062-update-constraints-loop-identified-mitigated.md) (layout rules the new pane obeys), research: `docs/research/2026-09-09-multi-session-management.md`
- **Touches:** sidecar `packages/runtime/src/{session-meta, session-cwd, session-watch, session-recovery, worktree-setup}.ts` (new), `worktrees.ts`, `sdk-runner.ts`, `turn-registry.ts`, `confirm-registry.ts`, `cost-tracker.ts`, `wakeup-scheduler.ts`, `wakeup-tools.ts`, `background-jobs.ts`, `session.ts`, `paths.ts`, `fs-sandbox.ts`; `packages/tools/src/lanes.ts` (new); `src/lib/turn-orchestrator.ts`, `changes-helpers.ts`; routes `api/chat`, `api/chat/announce`, `api/confirm`, `api/cost`, `api/worktrees`, `api/sessions/{meta,close,watch,interrupted,resume}` (new); `instrumentation.ts`. macOS `MARVINLogic/{SessionFeed, SessionLedger, SessionRowState, SessionCwdPolicy, TabCloseDecision, ChatTabsMigration}.swift` (new), `MARVIN/{SessionRegistry, SessionMetaService, SessionsPane, SessionModeChip, ChatTabCloseDialog}.swift` (new), `ChatPreviewView`, `ChatService`, `ChatTypes`, `Bridge`, `ContentView`, `LeftPane`, `CommandRegistry`, `SettingsView`.

## Context

> "i have 3 sessions running simultaneously but i want marvin to be able to run multiple sessions simultaneously, perhaps we need some sort of environment constraints or sandboxes? How does anthropic fix this? What does their documentation say?"

Two problems, measured before designing:

1. **Sessions sharing one checkout collide.** ADR-0102 made the collision *visible* (a HEAD-moving git command raises a confirm naming the other live session) because the user then required the shared tree. It did not make it impossible, and it could not: git has one HEAD per checkout.
2. **Only one session is visible at a time.** `ChatPreviewModel` holds the selected session; the open-tab list was a bare `[String]` with no state. The project-wide announce stream (ADR-0043) already carried every session's `turn.registered`, and the client discarded everything not on screen. A tab that needed an answer, failed, or finished was invisible until you switched to it; the dock badge parsed `bridge.webTitle`, which nothing had written since the WebView was removed, so it was permanently zero.
3. **A restart cut three turns off** on 2026-09-08 and left no way back but a hand-crafted API call: no marker in the transcript, no meta, the tab looked idle.

The research pass (25 Anthropic-primary claims, 0 refuted) settled the direction: sessions persist the conversation, not the filesystem; Anthropic's own answer to this scenario is **one git worktree per session** (the Claude Code desktop default, harness-enforced since CLI 2.1.218 — for worktrees the CLI creates); sandboxes are an orthogonal access-control layer; agent teams are unavailable in SDK sessions; a watch UI is built on the SDK's session APIs plus each session's live stream, with Anthropic's agent panel and web session list as the precedents. MARVIN already owned the worktree machinery for implementer subagents (ADR-0081/0103); it was not wired to chat sessions.

**Decisions taken with the user:** new tabs isolated by default; a per-tab chip switches to the shared checkout; scope = per-tab worktree + lifecycle, status dots + a Sessions pane, lanes for shared tabs, resume after restart. One transcript on screen; the brain keeps describing the selected session.

## Decision

1. **`projectId` stays the project; only `cwd` varies per session.** Every turn now carries `cwd` (the checkout the SDK runs in) *and* `workDir` (the project root). The twelve `.marvin/`-scoped services in `runAgent` — memory, backlog, graph, audit, design hooks, plugins, skills, wakeups, implementer worktrees — take `workDir`, so a session worktree can never fork them; `practicePromptBlock(slugifyWorkDir(…))` and the prompt cache prefix are keyed on the root. Transcripts, cost, wakeups and checkpoints remain keyed by project.
2. **A per-session meta file beside the transcript** (`<id>.meta.json`, plan-state discipline): the tree (`worktree` | `shared` + lane), the posture every turn ran with, the last turn's outcome, `closedAt`. The chat route creates it on the first message and patches it on every turn; a server-initiated resume rebuilds the turn from it.
3. **MARVIN creates the worktree; the SDK is not told.** `createSessionWorktree` reuses the implementer git path — cut from the **current HEAD** (`baseRef: head` semantics; the CLI's default `fresh` would silently drop unpushed work), branch `marvin/tab/<slug>`, dir `.marvin/worktrees/tab-<slug>`, so a lost record classifies from its ref name. No `Options.settings.worktree` is passed and **`EnterWorktree` / `ExitWorktree` are disallowed**: a model-initiated worktree inside a MARVIN worktree would nest a checkout the registry cannot see. `.marvin/worktree.json` (`symlinkDirectories`, `copyIgnored`) plus the project's `.worktreeinclude` amortise the fresh-checkout cost; only git-ignored files are ever copied, nothing is overwritten. Nothing project-specific ships in MARVIN (Golden Rule 6): when a project has no `worktree.json`, the setup is **detected from the project itself** and written there for the user to edit (addendum 1 below).
4. **Lifecycle** (amends ADR-0103's table): `session` while the tab is open — never swept, no staleness timer; on close it derives to `ready` / `empty` / `merged` like any tree; `discard` (checkout **and** branch) only after close and only for a session tree; merge of an open tab is refused only while it has a turn in flight; adoption of a lost `marvin/tab/*` branch yields an open-tab tree, not a spent orphan. Closing a tab offers **Merge** (local, never pushed; commits uncommitted work first on request; conflict aborts and keeps the branch), **Keep**, **Discard**; an empty clean tree is reclaimed silently.
5. **Main-loop containment, MARVIN-enforced** (Anthropic's four checks arm only for CLI-created worktrees): a write into the main checkout from a worktree tab is denied naming the tab's tree and the way out; shell that names the main tree (`cd <root>`, `git -C <root>`, `--git-dir`, `GIT_WORK_TREE`, a bare absolute path under it) raises a **confirm** in every permission mode, deny when no UI — never a rewrite (the implementer's `cd '<wt>' &&` rewrite exists only because subagent dispatch ignores cwd; the main query honours it). The shared-tree collision confirm (ADR-0102) is skipped for a worktree tab: there is no co-tenant in a private checkout.
6. **Lanes for shared tabs** (Anthropic's only shared-directory guidance is partitioned file ownership, with no enforcement): a shared tab may declare repo-relative prefixes; an Edit/Write/NotebookEdit outside them confirms, and a HEAD-moving git command confirms once a lane is declared even with no other session live. Prefix-by-segment (`src/api` never owns `src/api-v2`).
7. **One project event bus, extended, not duplicated.** `/api/chat/announce` now carries `turn.registered` (with `kind`), `turn.ended` (outcome, cost), `confirm.pending` / `confirm.resolved` (AskUserQuestion rides the same channel), `session.tree`. `GET /api/sessions/watch` is the cold-start snapshot: per session, state (`working | idle | awaiting-you | failed | interrupted`), live turn, pending confirms (the registry now records the tool name), tree + current branch, a `+N −M` badge (worktree: vs its base, committed and uncommitted; shared: vs HEAD; memoised 2 s), plan done/total from the persisted spine, cost (the ledger now carries `marvinSessionId`). Nothing parses a transcript on the hot path (ADR-0072).
8. **On the client, `SessionRegistry`** owns the tab set (a new key, `marvin.chatTabs.<pid>` — the old one was shared with the editor's file tabs and each writer blanked the other; a one-time migration frees it) and a `SessionLedger` reduced from the feed and the snapshot (a snapshot cannot clear a turn registered within a 5 s grace). Tab dots, an orange needs-you count, an interrupted glyph, the dock badge and a **Sessions** left-pane tab (PracticePane shape; sections Needs you / Working / Interrupted / Failed / Idle — collapsing after 30 s, first three stay, selected never — / Recent) are observers over it. New chats are draft tabs with a client-minted id; the first message declares the tree.
9. **Resume after restart.** At boot the sidecar stamps every transcript whose newest boundary is a `turn.started` with an `interrupted` terminal (tail scan, idempotent) and marks the meta. `POST /api/sessions/resume` builds a `WakeupRecord` from the meta's posture and dispatches it through `fireNow → startScheduledTurn`, which yields to a live human turn, re-resolves the tab's tree at fire time, and refuses when the worktree is missing. The client shows a banner and a Sessions row with Resume; nothing synthetic enters the chat.

### Considered and not taken

- **The SDK's own worktree support** (`Options.settings.worktree`, `EnterWorktree`, `isolation: worktree`): applies only to worktrees the CLI creates, ignores dispatch `cwd`, and is unusable in MARVIN's isolation mode (ADR-0081).
- **Sandboxing as the answer:** orthogonal; Anthropic states it does not address two sessions in one tree.
- **A second SSE stream per session for the watch UI:** one project-wide stream already existed; extending it costs nothing.
- **Forbidding the shared tree:** the user's requirement (ADR-0102) stands; it is now a per-tab choice with lanes for the cases that need it.
- **Auto-merge on close:** ADR-0081's position — the user merges — unchanged; merge is one of three explicit choices.

## Consequences

- The registry file gains `kind` and `sessionId` on records and a `session` state; pre-0107 records reconcile exactly as before (pinned by test).
- Persisted wakeup and background-job records gain an optional `workDir`; readers fall back to `cwd`.
- `ChatRequest` grows optional fields (`tree`, `lane`, `sessionTitle`); older clients keep working (shared mode, no lane).
- The editor, terminal, file tree and LSP stay on the project root; only the agent's turns, the changes badge and the review sheet follow the session's worktree. The chip says so.
- `buildProjectContext` reads context docs from the main tree (keeps the cache prefix identical across tabs); a tab's edits to `PROJECT_STATUS.md` in its worktree are not seen next turn.
- A mode switch mid-session changes the change-ledger's base directory; entries recorded before the switch may read stale until the next turn.
- **Unverified live:** SDK `resume` of a session whose cwd changed between turns (mode switch). The chip permits the switch only while no turn is live; a live run is the next check.

## Verification

- Sidecar: `session-meta`, `session-cwd`, `project-events`, `confirm-registry-list`, `cost-per-session`, `session-watch`, `session-worktrees`, `worktree-setup`, `session-worktree-gate`, `session-recovery`, `lanes`, `lane-gate` (12 new files); the pre-existing `shared-tree-gate`, `worktree-lifecycle`, `fs-sandbox` suites unchanged and green. Full run 2026-09-09: 79 files, **1178 tests, 0 failed**.
- macOS: `chat-tabs-migration`, `session-feed-decode`, `session-ledger`, `session-row-state`, `session-idle-collapse`, `session-cwd-policy`, `tab-close-decision`; `swift run MARVINTests` 758 assertions, 0 failures.
- Live check (user, after relaunch): `+` → a tab reading `isolated · pending`; first message → chip `isolated: marvin/tab/…`, `git worktree list` shows the tree, the registry has `kind: session`; an edit lands in the worktree and the main checkout is untouched; `cd <root> && …` from that tab raises a confirm; closing offers Merge / Keep / Discard; two tabs, a turn in one, the other's dot turns and the Sessions pane sorts it under Working; an AskUserQuestion in a hidden tab lights the badge and the dock; a killed sidecar leaves the tab marked interrupted with Resume.

## Scope of Done

- [x] `workDir`/`cwd` split through runner, orchestrator, wakeups, jobs, chat route; `.marvin/` services never fork into a worktree
- [x] Per-session meta beside the transcript; session-aware cwd validation (registered worktrees only)
- [x] Session worktrees: create / close / reopen / discard, `session` state, sweep and adopt rules, merge guard, setup config
- [x] Main-loop containment (deny writes into the root, confirm shell naming it); shared-tree confirm skipped in worktree mode
- [x] Lanes: gate + shared-tree extension + client editor
- [x] Project event bus, confirm index, per-session cost, watch snapshot and route
- [x] Client registry, tab dots/badges, dock badge, chip + popover, close dialog, Sessions pane, settings default
- [x] Boot marker, interrupted listing, server-initiated resume, client banner and row
- [x] ADR-0102 and ADR-0103 amended; roadmap, CLAUDE.md, changelog
- [ ] Live check on the rebuilt app (the user relaunches; Claude never restarts MARVIN)

## Addendum 1 (2026-09-09) — per-session activity, and a detected worktree setup

Two gaps found on the first day of use.

**One brain for every tab.** User: *"brain is still not session isolated, some sessions might be 'thinking' some others he might be using a 'tool', currently there is 1 brain status for all sessions."* The brain slot (`MarvinBridge.marvinState`, gated by `BrainStateGate`) was fed only by the selected tab's own stream. A tab not on screen produced no activity anywhere, so switching to it showed whatever the previous tab left, and the Sessions pane could only say "running". Fix, on the same event bus this ADR introduced: the orchestrator derives **thinking / writing / tool(name)** from the stream it already forwards (`assistant` text → writing, `assistant` tool_use → tool, `user` tool_result → thinking — the same rules the client's `peekCLIEvent` uses) and announces `session.activity` **on change only**; the watch row carries `activity` for cold start; the client ledger holds it per session, `SessionEntry.brainState` maps it to the brain's vocabulary, and the registry pushes it into the gated slot when the event's session is the one on screen and on every tab switch. The pane subtitle reads `using Bash 2m` instead of `running 2m`. The selected tab's own stream still drives the brain first; the feed agrees with it rather than replacing it.

**A fresh worktree with no dependencies.** User: *"tell me what are the worktree tab, node_modules and how to prepare them? … this needs to be documented in marvin, or he needs to automatically build it if a user wants."* Empty-by-default was the Golden Rule 6 reading; the result was a tab whose first `npm test` failed. Detection is not project knowledge: `detectWorktreeSetup` symlinks each of a fixed list of **dependency** directories (`node_modules`, `.venv`, `venv`, `.pnpm-store`, `vendor`, `.yarn/cache`, `.gradle`) that exists **and is git-ignored**, at the root and up to two levels into workspace packages, and copies the env-file patterns (`.env`, `.env.*`, `.envrc`, `*.local`) when an ignored file matches. Build output (`target`, `.next`, `dist`) is never symlinked — sharing it between trees is the collision this ADR exists to prevent. `readOrDetectWorktreeSetup` **writes** the detected config to `.marvin/worktree.json` with `"detected": true` and never re-detects over an existing file, so the guess is visible and editable. What was done is stored as `setup` on the session meta and stated in the per-turn session context, so the model does not reinstall into a symlink. Guide: [`docs/guides/worktrees.md`](../guides/worktrees.md).

Tests: `session-activity` (derivation, announce-on-change, independence, clear), `worktree-setup` (+2: detection, detect-then-write-then-honour-edits), `session-watch` (activity on the live row); Swift `session-feed-decode` (+1), `session-ledger` (+2). 769 Swift assertions.

## Addendum 2 (2026-09-09) — a confirm raised while the tab was hidden was never shown

User: *"marvin in 1 session is asking us for approval of some tools to use or asking us questions but if we are active in another session, we can't see those requests and then it just gets stuck."* The Needs-you dot, badge and Sessions row all lit correctly; what failed was the switch itself. Two rules met: `/api/chat/resume` forwards only events emitted **after** the client attached, and the client's transcript replay skips every stored `confirm.request` on the grounds that a historical confirm is settled — true for a finished turn, false for a live one. So a tab selected after its confirm was raised rendered no sheet; a Bash confirm auto-denied after five minutes and the turn carried on with a refusal, and an `AskUserQuestion`, which has no timer by design, waited indefinitely.

Fix on the sidecar, no client change: the orchestrator attaches the wire payload to the pending entry in the confirm registry (`attachPendingPayload`), and the resume route replays every still-pending payload as `confirm.request` right after `resume.attached`, subscribing to the bus **before** replaying so a resolution landing in between reaches the client as a later event. The client dedups by `toolUseId`, so the sheet appears exactly once; the Sessions pane's *Answer* action, which selects the tab, now ends in the sheet it promised.

Also in this addendum: the boot marker for interrupted turns now honours a window (`INTERRUPTED_MAX_AGE_MS`, 7 days, the same as the watch's recent set), and the watch derives `interrupted` only for a cut-off inside it. The first boot with the marker had flagged nine transcripts, three of them from June and August — their dangling `turn.started` lines had survived every restart since — and offered Resume on each. Already-stamped old transcripts are left as they are; they simply read as idle.

Tests: `confirm-registry-list` (+1: payload kept, ordered, gone on resolve), `session-recovery` (+1: an old cut-off is ignored and not marked), `session-watch` (+1: stale interrupted reads idle). The recovery fixture's start time is now relative, so the window cannot age the suite out.

## Addendum 3 (2026-09-09, evening) — a restart read as a Stop, and a read confirmed like a write

Two more from the first evening on the rebuilt app.

**"Turn cancelled (subprocess received SIGTERM — usually Stop / ⌘.)" after a restart.** The reinstall at 18:59 stopped the running app; its three live turns ended with that message, which is the SDK's wording for exit code 143 and is identical whether the user pressed Stop or the process was killed from outside. So the transcript recorded an *error*, the boot marker saw a terminal record and did not flag an interruption, and the tab showed a stream-error banner with no Resume — still there above the next turn's streaming reply, because nothing cleared it. The orchestrator holds the one fact the SDK lacks: whether the turn's abort signal was pulled. `classifyTurnFailure` turns a SIGTERM with no user cancel into `turn.error {interrupted: true, code: "interrupted"}` with a message that says what happened, the meta records `outcome: "interrupted"`, and the watch, the Sessions pane and the banner offer Resume. A new `turn.started` now clears the previous banner.

**A confirm under the auto gate for reading a spec file.** User: *"why do we get this if we run marvin with Auto gate."* The Bash containment confirmed on any bare mention of a main-checkout path, including `open('<root>/docs/smartbill-openapi-spec.json')`, a read. The containment exists to keep *writes* in the worktree; reading the shared checkout is harmless. `mainTreeRedirect` keeps confirming `cd`, `git -C`, `--git-dir` and `GIT_WORK_TREE` (they move the whole command), and otherwise confirms a root path only in a write position: a redirection into it, a mutating shell tool (`rm`, `mv`, `cp`, `mkdir`, `touch`, `tee`, …), in-place `sed`/`perl`, a mutating git verb, or a Python/Node file API opening it for writing. The per-turn session context now tells the model the same tracked files exist in the worktree and to name them by the worktree path.

A second false positive followed the same evening, under the auto gate: `mkdir -p docs && cp <root>/docs/smartbill-openapi-spec.json docs/…` — copying a spec file **out of** the main checkout **into** the worktree, which is the normal way to bring a fixture across. Keying the write test on the tool name alone was too crude for source → destination tools. `cp`, `mv`, `ln`, `install`, `rsync` and `scp` now confirm only when the ROOT path is the destination (whatever `-t` / `--target-directory` names, else the last positional argument); `dd` keys on `of=`. Tools whose every path argument is a target (`rm`, `mkdir`, `touch`, `tee`, `chmod`, …) are unchanged. Six source-position shapes and six destination shapes are pinned.

Tests: `session-recovery` (+1: classification), `session-worktree-gate` (+1: seven read shapes fall through, thirteen write shapes confirm, and twelve source-vs-destination copy shapes; the old "cat confirms" expectation inverted). Swift build green; 769 assertions unchanged (the banner clear is a one-line handler change).

## Addendum 4 (2026-09-09, night) — the stale banner was in the REPLAY, not the live path

User, after addendum 3 shipped: *"still appears when switching sessions."* Addendum 3 cleared the error banner on `turn.started`, which fixes a turn the user starts — and misses the two paths a session switch actually takes. `replay(record:)` assigned `lastError` from **every** `turn.error` in the replayed window and nothing cleared it: `turn.completed` fell into the `break` arm with the events that need no row. So a failure from hours ago re-appeared on every hydrate of that session, even with a dozen successful turns after it. And `attachLive` (the mid-turn re-attach) emits no `turn.started` at all, so a live turn streaming underneath the banner never cleared it either — exactly the screenshot with "streaming…" above "Stream error".

The rule is now one line in `MARVINLogic/ReplayBanner.swift` and pinned by tests: **only an error that is the last terminal event still holds**; a later start or completion supersedes it. Replay follows it, `attachLive` clears the banner when it confirms a live turn, and an **interrupted** turn banners nothing at all — the "cut off before it finished" chip with Resume already says it, and two banners in different words for one event was the confusion being reported. `turn.error` on the wire now carries `interrupted` through to the client (`ChatSessionEvent.turnError`, `TurnError`).

Tests: Swift `replay-banner` (7 assertions: trailing-only, newest-wins, interrupted-silent); 776 assertions total.

## Addendum 5 (2026-09-09, night) — `cd` is not a write, and the graph lives in the main checkout

User, on a confirm for a read-only graph query while the tab was on **auto**: *"why do we still get this? marvin is on Auto."* The transcript shows fourteen such confirms in four minutes, one per graph query, each on a command of the shape `cd <root> && $(cat graphify-out/.graphify_python) -c "…read…"`.

Two causes, both fixed here.

**A directory change was treated as a write.** `cd <root>`, `git -C <root>`, `--git-dir` and `GIT_WORK_TREE` confirmed unconditionally, on the reasoning that they move the whole command into the main tree. They do — but *what runs there* is what matters, and the model's reason for going there is almost always to read. `mainTreeRedirect` now tracks the effective cwd across `&&` / `;` / `|` segments, resolves relative paths against it, and confirms only for a write-shaped command whose target lands in the main tree: a redirection, a mutating shell tool, an in-place `sed`/`perl`, a **mutating** git verb (`checkout`, `reset`, `commit`, `rebase`, …, never `log`/`status`/`diff`), a `cp`/`mv`-style destination, `dd`'s `of=`, or a Python/Node file API opening for write. A mutating git verb run *from* the main checkout confirms even with no path, which is the ADR-0102 collision this gate exists for. `Edit`/`Write`/`NotebookEdit` into the main tree remain a hard **deny**, so the model's ordinary way of changing a file is still contained.

**The graph was only in the main checkout.** `graphify-out/` is git-ignored, so a fresh worktree has none, and every graph query had to leave the tab's tree. It joins the auto-detected symlink set — not project knowledge: MARVIN's own `graphify-bridge` already reads `<workDir>/graphify-out`, and the model reaches for the same directory by relative path. New session worktrees get it linked; existing ones rely on the `cd` rule above.

Tests: `session-worktree-gate` grows five read shapes that now fall through (including the reported command verbatim) and eight write shapes run *from* the main checkout that still confirm; the four "`cd` alone confirms" expectations are inverted. A nested-quote bug found by the suite: `node -e "…'/abs/path'…"` needs single- and double-quoted runs collected separately, or the path is lost. 1188 sidecar tests green.

## Addendum 6 (2026-09-10) — the graph directory is MARVIN's, not the user's checkout

Same complaint as Addendum 5, one day later, same tab state (**auto**, isolated
tab): *"why do we still get these if marvin is on auto?"* Addendum 5 stopped
confirming on `cd <root>` and on reads. The command that still confirmed was
graphify's own incremental-detect snippet — `cd <root> && $(cat
graphify-out/.graphify_python) -c "…"` — which **writes**
`graphify-out/.graphify_detect.json`. A write into the main tree is exactly
what the rule is for, so it fired, and it named the hit correctly. The rule
was right about the shape and wrong about the target.

**`graphify-out/` is not the user's checkout.** It is git-ignored, built by
MARVIN per project at the root (ADR-0041), read by `graphify-bridge` from
`<workDir>/graphify-out` on every turn, and now written by graphify's own
detect pass on many of them. Golden Rule 7 makes it the first thing MARVIN
touches on a codebase question. A reach into it from a worktree tab is not a
reach into the user's work, any more than a reach into `.marvin/worktrees/`
is — and that directory was already carved out of `underRoot`. `graphify-out/`
joins it: reads and writes there fall through the containment, in every mode.

Not changed: `Edit`/`Write` into the main tree still deny; a command that
touches `graphify-out/` *and* something else in the main tree still confirms,
named after the something else.

Tests: three cases in `session-worktree-gate` — the reported command
verbatim, the mixed command, and an absolute `graphify-out` path beside an
absolute `src` path. 1343 sidecar tests green.

## Addendum 7 (2026-09-10) — the plain chat gets its own button back

User: *"i also want a way when opening a new session, to be separate of our
multi-session-branches and behavior, like a normal chat that marvin had
previously … we need buttons and functionalities in the marvin UI for this."*

The shape existed — a shared-checkout tab is exactly the pre-ADR-0107 chat —
but only as an app-wide Settings default and a header chip on an already-open
draft. Nothing at the moment of *opening* a tab said there were two shapes.

Now the tab strip's `+` and the header's **New** are split buttons: click
takes the Settings default, the menu offers **New Chat — shared checkout** and
**New Isolated Tab — own branch**. The File menu carries the same two as
commands with their own keys (⌥⌘N shared, ⌃⌘N isolated; ⇧⌘N stays the
default), so they are in the ⇧⌘P palette and the ⌘/ help sheet too. The choice
is recorded on the draft the way the chip records it — nothing on disk until
the first message — and `newTab(mode:)` is the one entry point all of them use.

## Amendment (2026-09-10, ADR-0111) — the close rules are remade

The rule table in this ADR ("closed, 0 commits → `empty` → sweep if clean") described a sweep that ran from one button and never automatically, and the client's "reclaim silently" sent `keep`. Measured: 17 session worktrees on disk, 16 for closed tabs, 0 ever swept. [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md) replaces the close decision (from the sidecar's derived state; empty and merged trees discarded without asking; keep commits work first; Merge names its target), runs the sweep at boot and after every close, previews conflicts before integration, lets the owning session resolve them, names branches by their first commit, and cuts a fresh tree when an integrated tab is reopened.

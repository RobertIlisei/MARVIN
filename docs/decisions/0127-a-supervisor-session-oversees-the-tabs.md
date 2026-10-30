# ADR-0127 — A supervisor session oversees a project's tabs, within limits the user sets, and never stands in for the user's consent

- **Status:** Accepted — 2026-10-30 (decision, Phase A). Implementation follows [`docs/plans/supervisor.md`](../plans/supervisor.md); nothing in this ADR is shipped yet.
- **Date:** 2026-10-30
- **Supersedes, in part:**
  - Golden Rule 1 (`AGENTS.md`): the 2026-07-24 rejection of a standing supervisor, "No model ever commands another model", and "Two sessions must still never be *dispatched* by a model".
  - [ADR-0059](./0059-session-auditor-runtime-dispatched-read-only.md): "No model ever commands another model", the rejected alternative "Standing supervisor over executor+advisor", and — for the supervisor only — §5's "Not a dispatcher". The auditor itself stays a non-dispatcher.
  - [ADR-0001](./0001-single-assistant.md) camp 2: its rejection of a supervising model *at all*. The rejection of role decomposition and handoff pipelines stands (§1).
  - [ADR-0077](./0077-ai-native-sdlc-selective-adoption.md)'s Golden Rule 1 clarification, as far as it implies a session is never steered by a model. Its ban on model-dispatching-model *on shared state* stands.
- **Amends:** [ADR-0059](./0059-session-auditor-runtime-dispatched-read-only.md) (the auditor reviews the supervisor), [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md), [ADR-0040](./0040-interactive-ask-user-question.md), [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md), [ADR-0108](./0108-per-session-posture.md), [ADR-0115](./0115-full-auto-is-the-third-posture.md) (a turn the supervisor started or steered re-raises the human-only confirms even in `full`). Each carries a note pointing here.
- **Leaves untouched, and restates:** [ADR-0102](./0102-multiple-sessions-one-worktree.md)'s HEAD-moving confirm and [ADR-0109](./0109-batch-integration-and-metered-ci.md)'s metered-CI confirm and tab-branch publish deny are answered by the user and nobody else.
- **Related:**
  - Subagent invariants, unchanged: [ADR-0007](./0007-advisor-as-subagent-pattern.md), [ADR-0014](./0014-scout-subagents-read-only.md), [ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md), [ADR-0054](./0054-plugin-agents-read-only-hooks-stay-stripped.md), [ADR-0081](./0081-implementer-subagents-on-isolated-worktrees.md).
  - Wakeups and background jobs: [ADR-0031](./0031-self-scheduled-wakeups.md), [ADR-0038](./0038-background-jobs-event-wakeups.md).
  - [ADR-0036](./0036-ask-agent-plan-modes.md): plan approval.
  - [ADR-0069](./0069-never-drop-a-user-message.md): a user message preempts.
  - [ADR-0104](./0104-ship-review-gate.md): measure first, the boundary path set, the two-denies brake.
  - [ADR-0105](./0105-practice-loop.md): data-dir records about MARVIN.
  - [ADR-0110](./0110-worktrees-isolate-the-filesystem-not-the-machine.md): project-controlled input.
  - [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md): closing a tab that holds work; the `stopped` outcome.
  - [ADR-0116](./0116-the-spine-has-two-writers.md): a claim does not check itself.
  - [ADR-0117](./0117-mcp-trust-by-provenance.md): in-process MCP trust.
  - [ADR-0124](./0124-shell-reads-worktree-graphs-and-a-seeded-plan-spine.md): a graph per worktree.
  - [ADR-0126](./0126-a-model-for-every-helper-role.md): role models.

## Context

### What exists today

Robert directs his MARVIN tabs through an **external** supervisor: a Claude Code session in his terminal, with a mod that calls the sidecar's HTTP API:

- `GET /api/sessions/watch` to observe every tab;
- `POST /api/chat` to send;
- `POST /api/confirm` to answer questions and confirms;
- `POST /api/chat/cancel`;
- `/api/worktrees` (actions `preview`, `sweep`, `drop`, `merge`, `merge-all`, `prepare-mr`);
- `/api/models/roles`;
- `POST /api/sessions/close`;
- `PUT /api/sessions/meta`.

It works and is used every day. Two gaps showed up in practice:

1. **No route changes a tab's posture without sending a turn.** The chat route takes posture from every POST body and never reads it from the meta (`chat/route.ts:276-297`), and `PUT /api/sessions/meta` has no posture fields (`sessions/meta/route.ts:48-58`).
2. **A question can only be answered by hand-building `updatedInput.answers`.** The caller has to construct the `{ questions, answers }` shape ADR-0040 describes. `/api/confirm` checks only that `updatedInput` is an object (`confirm/route.ts:51`), and an allow without one resolves the question with no answers (`:49-53`).

More importantly, the external supervisor is **a model steering MARVIN sessions right now, outside every MARVIN mechanism**:

- its acts are in no ledger;
- it passes no policy;
- its messages arrive in a tab registered as `kind: "human"` (`chat/route.ts:445`);
- the transcript records no author for its confirm answers (`confirm/route.ts:94-103`);
- it can answer any confirm the user could, the ADR-0102 / ADR-0107 / ADR-0109 ones included (`sdk-runner.ts:1552, 1624, 1673, 1711`).

Golden Rule 1 says this cannot happen. It happens daily, in the least-governed form available.

There is a related fact the design must face. The only guard on those routes is `requireMarvinClient`: a static `X-Marvin-Client: 1` header plus loopback Origin checks (`src/lib/csrf.ts:152-170`). **A tab's own shell can present it.** So a tab can already answer its own confirms through `/api/confirm`. That hole predates this ADR, but a supervisor's routes would make it worse.

### What Golden Rule 1 says, and why

Three clauses forbid the external supervisor's shape:

- *"A standing supervisor agent was considered and rejected (2026-07-24) — that's ADR-0001's camp 2 … and a supervisor spawned/briefed by the executor it supervises is theater."*
- *"No model ever commands another model."* This is also in ADR-0059's Decision.
- *"Two sessions must still never be *dispatched* by a model."*

They were written against two real failure shapes:

- **ADR-0001's camp 2:** a supervisor decomposes one task into role-agents that hand off through tickets. The handoff tax was measured, and context is lost at every boundary.
- **ADR-0059's objection:** a supervisor spawned and briefed by the executor it supervises is not supervision.

### What changed

- **Anthropic now ships the shape, with the consent rules spelled out.** Claude Code documents five parallel patterns (code.claude.com/docs/en/agents): subagents, agent view (`claude agents`), agent teams, threads and dynamic workflows.
  - *Agent view* is the closest analogue. Sessions are grouped Pinned / Ready for review / Needs input / Working / Completed, with a one-line summary each. Questions can be answered from a peek panel; permission prompts need the user to attach to the session. Each dispatched session gets its own worktree, under "commit and push, never merge".
  - *Agent teams:* permission prompts bubble up to the lead. Messages from other agents "can't approve a permission prompt or supply consent on your behalf". Teams are not recommended for sequential or same-file work.
  - *Cross-session messaging:* messages cannot approve anything or change configuration. Inbound handling is `accept` / `hold` / `refuse`, with rate limits, repeat-drop and a 50-message cap.
  - *Agent SDK:* `canUseTool` always receives `AskUserQuestion`, answered with `{questions, answers}`. `setPermissionMode()` and `setModel()` work on a live query. Sessions resume by id.
- **Anthropic's engineering posts say how to do it safely.**
  - "Building effective agents": start simple; add stopping conditions and human checkpoints.
  - The multi-agent research post: +90 % on parallelisable work at about 15× the tokens, and coding has fewer parallel parts than research.
  - "Harness design for long-running apps": agents over-praise their own work, so evaluation belongs to a separate agent.
- **The industry converged on one shape.**
  - GitHub Agent HQ / mission control: assign, steer and track in one place; steering applied after the current tool call; the human steers.
  - The VS Code Agent Sessions view: local, CLI and cloud sessions in one list.
  - Cursor 3's Agents window and the Codex app: a worktree per agent or thread.
  - Devin: a manager over child agents plus a clean-context reviewer works; parallel writers fail.
  - The common shape across all of them: **an inbox grouped by state, a worktree per task, and the human merges.**
- **The risk numbers argue for a coordinator, not against one.**
  - Independent agents amplify errors 17.2×; centralised coordination holds it to 4.4× (Google Research, December 2025, arXiv 2512.08296).
  - Sequential tasks lose 39–70 % under multi-agent. That is the cost of *splitting one sequential task across agents*, which this design never does.
  - The remaining risks are named: runaway loops, cost and consent laundering.

### What did not change

The failure modes. Parallel writers on shared state still corrupt each other. A message from a model still must not become the user's approval. Loops still burn money while nobody watches. Each of those is answered below in code, not in a prompt.

**Robert's decision (2026-10-30), recorded rather than re-litigated:** the three clauses above are a year old and are superseded, because models and Anthropic's tooling have moved on. Keep what still protects: no parallel writers on shared state, every tab behind the same gates, and a supervisor message never counts as the user's consent.

## Decision

**A user-started Supervisor session per project, woken by a deterministic runtime loop, may watch every tab, answer its questions and — where the user allows — its ordinary confirms, steer it with messages tagged as the supervisor's, narrow its posture and prepare its integration. It acts only through a policy-checked `marvin-supervise` MCP server and records every act in an append-only ledger the session auditor reviews. Every consent-shaped decision goes to the user. Every turn it starts or steers is held to a stricter gate than the user's own.**

### 1. Golden Rule 1 — what is superseded and what remains

**Superseded:**

- the 2026-07-24 rejection of a standing supervisor;
- "No model ever commands another model";
- "Two sessions must still never be dispatched by a model". It is replaced by: *a model never creates a session; the supervisor steers sessions the user opened, within limits the user set.*

**Remains, each enforced in code rather than in the supervisor's prompt:**

- **No parallel writers on shared state.** Tabs keep their own worktrees (ADR-0107, ADR-0122). The supervisor writes no file itself. It never starts a turn in a shared-checkout tab while another live session works in that checkout; it escalates instead.
- **Every tab stays behind the same gates, and a supervisor-started or supervisor-steered turn behind stricter ones** (§5).
- **A supervisor message is never the user's consent** (§4, §5).
- **The subagent invariants are unchanged** (ADR-0007, 0014, 0030, 0054, 0081). The supervisor is not a subagent: no executor can spawn it, brief it, message it, or read its ledger, whether by tool or through MARVIN's own API (§5).
- **No role decomposition, task assignment or handoff pipelines.** The supervisor never splits a task across tabs or assigns work between them. Each tab's task stays the one the user gave it. That is the part of camp 2 ADR-0001 measured, and it stays rejected; what is superseded is camp 2's rejection of any supervising model at all.
- **New authority needs a new ADR.** Any new subagent type, and any widening of the supervisor's authority beyond this ADR, requires one.

### 2. Shape — a session the user starts, woken by the runtime

- **One supervisor per project, off by default, started by the user.** Today that is an API call; later it is the Sessions pane.
  - It is its own SDK session with its own system prompt (not `personality.ts`), on a new **`supervisor`** helper role (ADR-0126, default Sonnet tier).
  - Its working directory is the project root, so it reads the main checkout. It reads a tab's files by that tab's worktree path, and the tab's own graph through ADR-0124.
  - It is stored as a session of kind `supervisor`, so its transcript can be inspected. `POST /api/chat` refuses a supervisor session id: the supervisor is never run as an ordinary tab with a tab's tools. The user talks to it through its own route.
- **Runtime-dispatched, like the ADR-0059 auditor.** It is never an executor subagent and never on an executor's agents map. No tool any tab holds can start, brief or message it.
- **No write tools of its own.** Its only effects go through `marvin-supervise`, and those effects are real: they resolve confirms, start turns and change posture. It *is* a dispatcher in the sense ADR-0059 §5 forbade the auditor to be, and the authority is bounded by §3–§6, not by a label. Containment is belt and braces:
  - **The SDK layer.** `disallowedTools` refuses Edit, Write, NotebookEdit, Bash, every subagent-dispatch tool name, WebFetch, WebSearch and TodoWrite before the model sees them. This is the auditor's mechanism, `session-auditor.ts:385-397`.
  - **A `canUseTool`.** It applies the ADR-0036 read-only collapse plus a **secret-path read deny** (`.env*`, key and credential files — patterns taken from `sidecar/packages/tools/src/fs-constants.ts`, the one home REVIEW.md allows for them), so Read, Grep and Glob ground answers without reading secrets.
  - **Its tool surface.** `mcpServers` is exactly `marvin-supervise` plus the read-only `marvin-graph`. There are no `marvin-control` tools, so it cannot schedule its own wakeups, start background jobs or create worktrees.
- **Woken by code, not by itself.** A sidecar loop subscribes in-process to the project event bus (`subscribeProjectEvents`, `turn-registry.ts:157`; the events are `turn.ended`, `confirm.pending`, `confirm.resolved` and `session.activity`). It reads the rows `buildSessionWatch` produces. A watch row carries neither background jobs nor wakeups, so the loop asks `background-jobs.ts` and `wakeup-scheduler.ts` directly what each tab is waiting on. It wakes the supervisor when a delegated tab has:
  1. a question or confirm pending;
  2. a turn that ended — completed, failed or interrupted. A turn the user **stopped** (ADR-0111) never triggers a nudge: the user stopped it on purpose;
  3. gone idle with its plan open: no turn running, no recent `TodoWrite`, and **no background job or wakeup of its own pending** (ADR-0038, ADR-0031). A tab waiting on its own build is left alone;
  4. emitted a scope-met handoff. The supervisor reads the claim against the evidence, which is the separate-evaluator pattern, and either says what is missing or marks the tab ready for the user's review.

  Trigger 2 fires on every turn. ADR-0059 refused per-turn triggers for its auditor, and this ADR does not pretend `turn.ended` is rare. What bounds it is the loop:
  - wakes are coalesced, so one wake carries every pending item;
  - wakes are debounced;
  - events that arrive mid-wake are queued for the next wake, never dropped;
  - a wake is skipped while the supervisor is paused, over budget or already mid-wake;
  - the caps in §6 apply.
- **Each wake is one bounded turn.** It has a `maxTurns` cap and a max-actions breaker, and carries a runtime-assembled packet per item:
  - the tab's plan spine and DoD;
  - the pending question or confirm;
  - the turn outcome, posture and delegation level;
  - the ledger tail for that tab;
  - a transcript tail, **wrapped and labelled as untrusted data**, because it contains tool output a tab never vetted.

  Correctness never depends on what the supervisor remembers; the ledger is the record. The SDK session is resumed across wakes and rotated by a rule the plan fixes, and every rotation is ledgered.

### 3. Delegation — per tab, set by the user, enforced by the verb layer

| Level | The supervisor may |
|---|---|
| `off` | nothing; the tab is not watched |
| `observe` | read, summarise, and escalate with a recommendation; it never acts on the tab |
| `answer-questions` — **the default when a tab is delegated** | everything in `observe`, plus: answer `AskUserQuestion` when grounded; send follow-ups and nudges inside the tab's approved plan; cancel a runaway turn; narrow the tab's posture |
| `answer-confirms` | everything above, plus allow or deny **ordinary** permission confirms — a gated tab's Edit / Write / unsafe-Bash card — that are not on the human-only list (§4) |

- **A project-wide mode sits above the levels:** `off` → `shadow` → `autonomous`. Autonomy is switched on **per category** (questions, nudges, posture, confirms). Enabling the supervisor starts it in `shadow` (§8).
- **Authority lives in the runtime, keyed by project.**
  - Delegation, the user's charter (their stated goals) and the caps are held in the sidecar's memory.
  - They persist to `<MARVIN_DATA_DIR>/supervisor/<projectId>/` — keyed like `sessions/<projectId>/`, one supervisor for every worktree of the project — and the file is re-read **only at boot**.
  - They change only through the supervisor routes (§5). **They are never read from the project's `.marvin/`.** A file in the user's repository is written by whoever wrote the repository (REVIEW.md, ADR-0110), and a cloned repo must not be able to grant its own supervisor `answer-confirms`.
- **Every act carries its grounds.** `answer`, `confirm`, `send`, `cancel` and `set_posture` all take `grounds[]`. Each entry cites one of: a plan step, a DoD bullet, an ADR, a memory fact, the user's charter, or `file:line` in a named tree.
  - **Citations must resolve.** The verb refuses an act with no grounds and resolves each citation, because a claim does not check itself (ADR-0116).
  - **Grounds carry provenance.** **Strong:** the user's charter; a plan the user approved; artifacts on the main checkout that the tab did not author. **Weak:** anything the tab wrote itself, such as its own worktree's files, memory facts it `remember`ed, or plan steps added after approval. An act needs at least one strong ground or it escalates.
  - **Unresolvable grounds escalate.** When the supervisor cannot ground an answer in the tab's plan, DoD, ADRs, memory or the user's stated goals, it escalates.
  - **Support is the auditor's question.** Whether the grounds actually support the act is not checked by the verb; the auditor checks it (§7).

### 4. Always human-only — at every delegation level, in every posture

The supervisor never performs an act on this list. Its verb turns the act into an **escalation**, which records the raw act (tool, input, digest) and the supervisor's recommendation separately:

1. **Integration and money.**
   - Merging into the main line or the branch the user is on: `worktree_merge`, merge-all, Prepare MR.
   - Pushing, opening or merging a merge request, starting CI.
   - ADR-0109's metered-CI confirm and its tab-branch publish deny stay exactly as they are.
2. **Containment.**
   - ADR-0102's HEAD-moving or history-rewriting confirm.
   - ADR-0107's session-worktree gate, which fires when a tab reaches into the main checkout.
   - Lane confirms.
3. **Discarding work.**
   - Rejecting or reverting changes.
   - Dropping a worktree that holds commits or uncommitted work.
   - Closing a tab that holds work (ADR-0111).

   Sweeping provably spent trees is not discarding. That means exactly what `worktree_sweep` reclaims today — never a `session` tree of an open tab, which ADR-0109 leaves to tab close.
4. **Boundary paths.** Auth, credentials, CI configuration, `.env`, sudoers and migrations. This is one list, shared with the ship-review gate (ADR-0104), not a second copy.
5. **Widening a posture** (ADR-0108, ADR-0115).
   - gated → auto → full.
   - Ask or Plan → Agent.
   - A pricier or unpriced model.
   - Higher effort.
6. **Scope.** Approving a plan, or changing a tab's DoD or scope.
   - ADR-0036's plan approval is the user's consent to a scope.
   - Today approval exists only in the client: `approvePlan` switches the tab to Agent and sends ordinary chat text (`ChatPreviewView.swift:3528-3541`), and the server-side `maybePlanApproval` is a no-op (`sdk-runner.ts:1386-1400`).
   - So approval is caught mechanically, as item 5's Plan → Agent, never by recognising the text.
7. **Topology.** Creating a tab (`new_session` is only a proposal to the user), and anything that targets a supervisor session.

**How the list is applied.**

- **Acts: deterministic.** The policy reads the act itself, never the supervisor's description of it:
  - the confirm's kind, which the registry records from the rule that raised it;
  - the tool name and input;
  - the target posture.
- **Questions: a heuristic, and labelled as one.** The policy escalates a question whose text or options name an act on the list — push, merge, merge request, deploy, delete, credentials, migrate, approve the plan. Wording evades a keyword list ("publish the branch", "sync with origin"). Shadow mode measures how often it misses. The line that holds regardless is §5: answering a question performs nothing, and the act the answer leads to meets the gate inside a turn the supervisor has now steered.

### 5. A supervisor message is never the user's consent

- **Tagged at the source.** The supervisor's messages enter a tab through a server-side send path with `author: "supervisor"`.
  - The author is recorded in the transcript, the turn registry and the watch row. The message is shown as the supervisor's, never as the user's bubble.
  - The tab's model receives it in an envelope that names the sender and says what a supervisor message cannot authorise.
  - Answers the supervisor gives to `AskUserQuestion` reach the tab marked as the supervisor's, with their grounds.
  - Every `confirm.decision` the transcript records gains `answeredBy: "user" | "supervisor"`.
- **The gate knows when the supervisor has touched a turn.** A turn is marked **supervisor-touched** when either of these happens:
  - a supervisor message started it;
  - the supervisor answered a question or confirm inside it.

  From then on, every act on the §4 list raises a confirm that **only the user** can answer. This holds:
  - in every posture, `full` included;
  - for the containment confirms ADR-0115 waives in `full`;
  - for acts a user-started turn would run unasked, such as a `git push` from a shared-checkout tab in `auto`.

  The supervisor's verbs refuse to answer such a confirm. This gate ships **before any supervisor autonomy does**.
- **It never talks over the user.**
  - A supervisor message is never injected into a live turn and never preempts one. It waits for the turn to end and then starts its own turn, which any user message preempts (ADR-0069).
  - It starts that turn through the server-side resume path (`resumeSession`, `session-recovery.ts:275`) with the tab's stored posture, **including its mode**.
  - That path drops the mode today. `runDetachedTurn` (`turn-orchestrator.ts:725-745`) passes none, so `sdk-runner.ts:2158` runs every wakeup, job-completion and resume turn as `agent`. A supervisor turn in an Ask or Plan tab must stay Ask or Plan.
- **Consent is given where the act is.** Telling the supervisor "approve X" in its own chat does not approve X. It produces an escalation. The inbox shows that escalation as the **raw act** — tool, input, a digest, and for a merge the `git merge-tree` preview — with the supervisor's recommendation beside it, never in place of it. The user's click on the raw act is the consent. This is agent teams' rule: messages from other agents cannot approve a permission prompt or supply consent.
- **The supervisor's routes need a capability a tab cannot present.**
  - **The capability.** Supervisor-authority routes require a **per-boot capability token**:
    - mutations under `/api/supervisor/*` (start, pause, kill, delegate, charter, inbox accept and override);
    - `POST /api/confirm/answer` with `actor: "supervisor"`;
    - `author: "supervisor"` on `POST /api/chat`.
  - **Who holds it.** The sidecar generates the token at boot and writes it to `<MARVIN_DATA_DIR>/supervisor/token` (0600) for the app and for an external client the user points at it. It is never placed in a turn's environment.
  - **What the gate refuses a tab.** In every posture, the gate denies a tab's tool call that:
    - names the supervisor data directory;
    - addresses the running sidecar's control routes (`/api/supervisor`, `/api/confirm`, `/api/chat`, `/api/sessions/*`, `/api/worktrees`, `/api/models/roles`). `/api/health` stays open.

    This also closes the pre-existing self-answer hole described in Context.
  - **What a declared downgrade can do.** A caller with the token may act as the supervisor. The external prototype opts into the same policy and ledger that way.
  - **The app's routes keep the user's authority.** `/api/confirm`, `/api/chat` without an author, and the rest are the app's hand.
- **What this does not defend against, stated plainly.** Code a tab *executes* — a repository's test script, a build step — runs as the user. It can defeat any same-user measure, the same way it can read `~/.ssh` today. The defences above stop a tab's *model* from using MARVIN's own API or data as a side door. They do not stop arbitrary code execution, which needs OS-level isolation this ADR does not add.

### 6. Guardrails — stopping conditions in code

- **Rate limits** apply per tab and project-wide.
  - An identical send to the same tab within a window is dropped.
  - **Two nudges at the same plan step without spine progress escalate**, instead of a third nudge.
  - Repeated failed outcomes escalate rather than retry.
- **A daily spend cap** counts the supervisor's own tokens *and* the tab turns it started, because a nudge spends the tab's money too. At the cap the loop pauses and escalates.
- **Per-wake caps.** A max-actions-per-wake breaker and a `maxTurns` cap per wake.
- **No recursion.** A supervisor session is never watched or targeted. It cannot create sessions or spawn agents. There is one per project.
- **Secret hygiene.** The text of `send` and `answer` is scanned for secret-shaped strings (API keys, tokens, private keys) and refused on a match. This backs up the secret-path read deny in §2.
- **Pause and Kill are available at all times.** Pause stops waking; Kill aborts the in-flight wake, then pauses.
- **The ledger.** Append-only JSONL at `<MARVIN_DATA_DIR>/supervisor/<projectId>/ledger.jsonl`.
  - **What a line records.** One line per proposal, act, refusal, drop, escalation and outcome, with these fields: time, wake id, tab, verb, argument digest, mode (shadow or autonomous), decision (act, escalate, refuse or drop), reason and grounds with provenance. Where the supervisor proposed an answer, the line also records what was actually answered and by whom, which is what the shadow measurement compares.
  - **Who writes it.** The runtime writes it, with the auto-audit log's discipline: `O_APPEND`, fsync and mode 0600 (`auto-audit.ts:184-232`). The supervisor's tools never write it.
  - **Where it lives, and why.** It is deliberately **not** beside the auto-audit log, which lives in the project's own `.marvin/auto-audit.jsonl` (`auto-audit.ts:11`). `.marvin/` is committed in some projects. The ledger feeds both the supervisor's packets and the shadow agreement numbers, so a repository must not be able to forge it. It sits with the practice loop's data (ADR-0105), because it is a record about MARVIN rather than the user's artifact. The gate's data-directory deny (§5) keeps a tab's model out of it.

### 7. The session auditor reviews the supervisor (ADR-0059 amended)

The auditor gains a target: the supervisor ledger over a window, set against the transcripts of the tabs it acted on. The new finding classes are:

- `ungrounded`: grounds that do not support the act;
- `overreach`: an act at the edge of the human-only list;
- `loop`: repeated nudges or answers;
- `consent`: a tab that treated a supervisor message as the user's approval.

Everything else in ADR-0059 holds:

- it is user-initiated by default; a scheduled ledger audit is opt-in and off by default;
- it is read-only and has zero enforcement authority;
- **the report goes to the user, never to the supervisor.** The reviewed is not briefed by its reviewer, and the reviewer commands nobody.

### 8. Rollout — off, then shadow, then autonomy (measure first, ADR-0104)

- **Ships off.** Enabling it starts **shadow**. In shadow:
  - every act passes the policy and is ledgered as a proposal, but is **not performed**;
  - tabs keep waiting for the human;
  - the ledger records what was then answered and by whom;
  - a stats route reports agreement per category, plus the question heuristic's misses.
- **The comparison is only as good as its label.** Answers through `/api/confirm` are recorded as the user's, because that route carries the user's authority. An external client that lets its own model decide must use the supervisor routes, not `/api/confirm`, or it contaminates the user's column.
- **Autonomy is the user's switch, per category.** MARVIN ships no automatic graduation. A suggested bar is shown beside the switch but not enforced:
  - at least 20 proposals in the category;
  - at least 90 % agreement with the user's answers;
  - no human-only act ever proposed as `act`.

### 9. The two API gaps

- **Posture without a turn: `PUT /api/sessions/posture`.**
  - **What it sets.** Model, effort, permission strategy and mode. It validates them, writes the session meta with a **revision** and a **source**, and applies from the next turn.
  - **A live turn is not promised.** Applying to a live turn is a milestone question:
    - MARVIN's strategy and mode are enforced in `canUseTool`, which is chosen once per turn while the SDK's `permissionMode` stays fixed at `"default"` (`sdk-runner.ts:2267-2268`). A live narrowing therefore means the gate reading a mutable turn posture.
    - The model can change through the SDK's `setModel()` once that is verified against the pinned SDK.
  - **Precedence over the app.** An API-set posture holds over the posture the app posts until the app has seen that revision. The Swift side adopts revisions in the UI milestone. Until then, a user who never uses this route is unaffected.
  - **The supervisor actor narrows only.** For the `supervisor` actor (token required), narrowing passes and widening escalates.
- **A first-class answer: `POST /api/confirm/answer`.**
  - **Request.** The question, by text or index, plus the option label(s) or "Other" text.
  - **What the server builds.** `updatedInput: { questions, answers }`, constructed from the input the registry already keeps (`PendingEntry.originalInput`, `confirm-registry.ts:22-26,171-177`), byte-for-byte as `AskQuestionSheet` does (`AskQuestionSheet.swift:248-266`).
  - **Validation.** Every label is checked against the question's options.
  - **One service.** The `answer` verb uses the same service.

### 10. Surface and sequencing

This machine has no Swift 6.1 toolchain, so the work is sequenced **sidecar first**:

- **First:** the engine, routes and verbs, fully covered by vitest. The external Claude Code mod is the interim UI through the routes.
- **When the toolchain arrives:** the native surface, a **Supervisor strip in the Sessions pane** in the ADR-0114 vocabulary. It holds:
  - the escalation inbox, with one-click accept or override on the raw act;
  - the ledger;
  - a per-tab delegation chip;
  - a budget meter;
  - Pause and Kill.

  Tab cards mark supervisor-sent messages and supervisor-given answers.

`macos/Package.swift` is not modified to work around the toolchain.

## Consequences

- **Positive.**
  - The supervision Robert already relies on moves inside MARVIN's gates, policy and ledger, and becomes auditable after the fact.
  - Tabs stop stalling on questions the plan already answers.
  - Every rule that protected the old design survives as a coded check rather than a sentence.
  - The control-route deny closes a pre-existing hole: a tab answering its own confirms through the API.
- **Negative / trade-offs.**
  - **Wrong answers can travel.** A model now steers models: a wrong answer can run through a tab's next hours of work before anyone looks. Grounding with provenance, shadow mode, the stricter gate on touched turns, the auditor and the inbox all reduce this; none makes it impossible.
  - **Cost** rises with every wake and every nudge, bounded by the cap.
  - **Injection.** The supervisor reads tab transcripts that contain untrusted tool output. So its authority is bounded by deterministic policy rather than by its own judgement, and its recommendations are never what the user consents to.
  - **The question classifier is a heuristic**, and is measured as one.
  - **Interim posture surprise.** Until the Swift side adopts posture revisions, an API-set posture overrides what the app posts. That can surprise a user who changes posture in the toolbar after using the route.
  - **Same-user code execution stays out of scope** (§5).
- **Follow-ups created.**
  - The milestone plan in `docs/plans/supervisor.md`.
  - The documents that still state the superseded clauses as current describe the shipped product, which has no supervisor yet. The milestone that ships it updates them: `docs/concepts/single-assistant.md`, the white paper and Technical Reference, and the README's "Single assistant, not an agent team" bullet.

## Alternatives considered

- **Keep the rule and leave supervision outside MARVIN.** Rejected. The external session already steers tabs with no policy, no ledger and full user authority. The status quo is the least-governed version of the thing the rule forbids.
- **A supervisor as an executor subagent.** Rejected, for the reason ADR-0059 gave and this ADR keeps: a supervisor spawned and briefed by what it supervises is theater.
- **A supervisor that can write or implement.** Rejected: it would be a parallel writer on whatever tree it touched.
- **A resident model polling the tabs.** Rejected on cost and on loop risk. A deterministic loop decides when to wake; the model decides only what to say.
- **A rules engine with no model.** Partly adopted. The wake loop, the policy, the act classifier, the rate limits and the ledger are all deterministic. What a rules engine cannot do is answer "which of these two schemas does the plan imply" — the judgement the model is admitted for.
- **An agent-teams lead that decomposes work into tabs.** Rejected. Sequential coding loses 39–70 % under that split, and Anthropic does not recommend teams for sequential or same-file work.
- **Delegation stored in the project's `.marvin/`.** Rejected: project-controlled input could grant itself authority.
- **Authenticating the whole loopback API.** Deferred. The capability token covers the routes that carry supervisor authority, and the gate's control-route deny covers a tab's model. Authenticating the app's own routes is a separate decision.
- **Automatic graduation from shadow to autonomy.** Rejected. Widening the supervisor's authority is a widening like any other, and widening is the user's act.

## Scope of Done

- [x] Phase A:
  - this ADR;
  - Golden Rule 1 in `AGENTS.md`, the `personality.ts` subagents section and the firm-surfaces table say the same thing;
  - amendment notes on ADR-0001, 0040, 0059, 0067, 0077, 0107, 0108 and 0115;
  - the milestone plan is committed.
- [ ] **Containment.**
  - A user-started supervisor, woken only by the runtime loop, runs with the SDK-level disallowed list plus the `canUseTool` read deny, and acts only through `marvin-supervise`.
  - No executor tool, and no tab tool call against MARVIN's own API or data directory, can start, brief, message or reconfigure it.
  - Tests pin the tool set, the gate deny and the token requirement.
- [ ] **Human-only acts.** Every act on the §4 list is escalated and never performed, at every delegation level and in every posture. Inside a supervisor-touched turn it raises a user-only confirm even in `full`. Covered by a table test over the classifier plus gate tests.
- [ ] **Consent.** Supervisor messages and answers reach a tab tagged as the supervisor's, and the gate never treats them as the user's consent. Covered by integration tests from the server-side send path and through `POST /api/chat` with `author: "supervisor"`.
- [ ] **Ledger and rollout.**
  - Every proposal, act, refusal, drop and escalation is in the append-only ledger, and the auditor can review it.
  - The supervisor ships off, and shadow precedes autonomy per category.
  - `PUT /api/sessions/posture` and `POST /api/confirm/answer` exist.

## Related

- Plan: [`docs/plans/supervisor.md`](../plans/supervisor.md).
- The external prototype's routes: `sidecar/src/app/api/{sessions/watch,chat,confirm,chat/cancel,worktrees,models/roles,sessions/close,sessions/meta,sessions/resume}`.
- Reused:
  - `session-watch.ts` (`buildSessionWatch`);
  - `turn-registry.ts` (`subscribeProjectEvents`);
  - `confirm-registry.ts`;
  - `session-meta.ts`;
  - `session-recovery.ts` (`resumeSession`);
  - `session-auditor.ts` (dispatch, `AUDITOR_DISALLOWED_TOOLS`);
  - `worktrees.ts` (`reconcileWorktrees`, `mergeAllWorktrees`);
  - `wakeup-scheduler.ts`, `background-jobs.ts`;
  - `@marvin/tools/policy` (`TRUSTED_INPROCESS_MCP_PREFIXES`, `mcpToolPolicy`);
  - `role-models.ts`;
  - `auto-audit.ts` (the append discipline);
  - the ADR-0104 brakes.
- Research cited above:
  - code.claude.com/docs/en/agents (agent view, agent teams, cross-session messaging);
  - Agent SDK `canUseTool`, `setPermissionMode`, `setModel`;
  - Anthropic engineering: "Building effective agents", the multi-agent research system post, "Harness design for long-running apps";
  - GitHub Agent HQ, VS Code Agent Sessions, Cursor 3, the Codex app, Devin;
  - Google Research, arXiv 2512.08296.

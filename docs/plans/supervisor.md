# Supervisor — implementation plan

- **Decision:** [ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md)
- **Written:** 2026-10-30 (Phase A). Nothing below is implemented yet.
- **Branch discipline:** each milestone lands on a tab branch; the user merges.

## Constraint that shapes the order

This machine has no Swift 6.1 toolchain. It has Command Line Tools 15.3 and Swift 5.10, so the macOS app cannot be built here.

- **Milestones 1–5 are sidecar-only:** engine, routes and verbs, fully covered by vitest. Robert's external Claude Code mod is the interim UI, through the routes.
- **Milestone 6 is the native surface** and waits on the toolchain.
- `macos/Package.swift` is not modified to work around this.

**Order rule:** the gate that holds supervisor-touched turns to the user's consent (milestone 3) lands **before** any category can leave shadow mode (milestone 4).

## Every milestone, in addition to its own DoD

- The whole workspace typechecks, and the runtime and sidecar suites are green.
- At least one new test covers each behaviour changed. Where the change crosses the route → runtime boundary, that test is an integration test.
- No test fixture shows the supervisor performing anything ADR-0127 §4 lists as human-only.
- `REVIEW.md`'s always-check list holds:
  - every new route has its entry in `docs/reference/api.md`;
  - `marvin-supervise` has its entry in `docs/reference/mcp-servers.md` and the `personality.ts` "prefer `marvin-*`" note;
  - secret and deny path patterns come only from `sidecar/packages/tools/src/fs-constants.ts`;
  - every new persisted field or event (`answeredBy`, `author`, `supervisorTouched`, ledger lines) ships with its writer and a round-trip test, in the same milestone that declares it.
- The ADR's `## Scope of Done` boxes are ticked only for what actually happened.

## Definition of Done for the whole plan

- **Containment:**
  - A user-started supervisor, woken only by the runtime loop, runs with the SDK-level disallowed list plus a `canUseTool` read deny.
  - It acts only through `marvin-supervise`.
  - No executor tool, and no tab tool call against MARVIN's own API or data directory, can start, brief, message or reconfigure it.
- **Human-only acts:** every ADR-0127 §4 act is escalated, never performed, at every delegation level and in every posture. Inside a supervisor-touched turn it raises a user-only confirm, even in `full`.
- **Consent:** supervisor messages and answers reach tabs tagged as the supervisor's. The gate never treats them as the user's consent.
- **Ledger and rollout:**
  - Every proposal, act, refusal, drop and escalation is in the append-only ledger, and the auditor can review it.
  - The supervisor ships off.
  - Shadow precedes autonomy, per category.
- **API gaps:** `PUT /api/sessions/posture` and `POST /api/confirm/answer` exist and serve both the external prototype and the supervisor.

## Milestones

### [1] The shadow spine, end to end in the sidecar

The thinnest path through every layer:

project event bus → wake loop → runtime-dispatched supervisor turn → `answer` verb → policy → ledger → a route that shows it.

**Verbs in this milestone:**

| Verb | Behaviour |
|---|---|
| `sessions`, `read` | Work for real. |
| `answer` | Policy-evaluated and ledgered. Performs nothing. |
| All other verbs | Arrive with the milestone that can classify them. |

**Touchpoints — new.** All are flat files in `sidecar/packages/runtime/src/`, matching `session-auditor.ts` and `memory-mcp.ts`:

- **`supervisor-state.ts`** — the authority store.
  - Held in memory and persisted to `<MARVIN_DATA_DIR>/supervisor/<projectId>/state.json`. The file is re-read only at boot.
  - Fields:
    - mode: `off` / `shadow`. `autonomous` is typed but unreachable in this milestone.
    - per-tab delegation.
    - the user's charter.
    - caps.
  - Never reads the project's `.marvin/`.
  - Generates the per-boot capability token at `<MARVIN_DATA_DIR>/supervisor/token` (0600).
- **`supervisor-ledger.ts`** — append-only JSONL beside the state. Same discipline as `auto-audit.ts:184-232`: `O_APPEND`, fsync, mode 0600.
- **`supervisor-policy.ts`** — the checks every verb passes through:
  - delegation check;
  - grounds required, every citation resolved, and provenance tagged strong or weak;
  - per-tab and global rate limits;
  - per-wake action breaker;
  - recursion refusal;
  - for questions, the §4 keyword heuristic. It is labelled a heuristic, and its hits are counted.
- **`supervisor-loop.ts`** — decides when to wake:
  - sources: `subscribeProjectEvents` (`turn-registry.ts:157`), `buildSessionWatch` rows, and lookups in `background-jobs.ts` / `wakeup-scheduler.ts`;
  - triggers: a pending question;
  - coalescing and debounce;
  - events arriving mid-wake are queued, never dropped;
  - pause and kill.
- **`supervisor-dispatch.ts`** and **`supervisor-prompt.ts`** — its own `query()`, like `runSessionAudit` (`session-auditor.ts:630-720`):
  - `SUPERVISOR_DISALLOWED_TOOLS`: Edit, Write, NotebookEdit, Bash, every `SUBAGENT_DISPATCH_TOOLS` name, WebFetch, WebSearch, TodoWrite;
  - a `canUseTool` with the ADR-0036 read-only collapse plus a secret-path read deny built from `fs-constants.ts`;
  - `mcpServers` is exactly `marvin-supervise` + `marvin-graph`;
  - `cwd` is the project root;
  - `maxTurns`;
  - the packet, with the transcript tail wrapped as untrusted data;
  - the rotation rule.
- **`supervisor-mcp.ts`** — the `sessions`, `read` and `answer` verbs.

**Touchpoints — modified.**

- **`role-models.ts`** — adds a `supervisor` role, Sonnet tier by default.
- **`@marvin/tools/policy`:**
  - `marvin-supervise` is admitted only with `source: "sdk"` (ADR-0117), and only in the supervisor session.
  - The gate denies a tab tool call that names the supervisor data directory or addresses the running sidecar's control routes (`/api/supervisor`, `/api/confirm`, `/api/chat`, `/api/sessions/*`, `/api/worktrees`, `/api/models/roles`). `/api/health` stays open. This deny applies in every posture.
- **`confirm-registry.ts`** — each pending entry records which rule raised it.
- **`chat/route.ts`** — refuses a supervisor session id.
- **New routes:**
  - `src/app/api/supervisor/route.ts`: GET state; POST `start` / `pause` / `kill` / `delegate` / `charter`, with the token required.
  - `src/app/api/supervisor/ledger/route.ts`.
- **Boot** — re-arms an enabled supervisor, the way wakeups are re-armed.

**Decisions this milestone fixes.** Each is an initial value to be measured in shadow, not a contract:

| Setting | Initial value |
|---|---|
| Debounce | 5 s after a tab's last event. |
| Idle-with-open-plan | 10 min with no `TodoWrite` and no turn running. Not used until milestone 5. |
| Session rotation | A fresh SDK session once the resumed one passes half its context window, or at the first wake of a new day. It starts from the charter, the packet and the last 50 ledger lines. Every rotation is ledgered. |
| Budget | USD per day, from `cost-tracker`. Initial cap $10, user-set. |
| Talking to the supervisor | `POST /api/chat` refuses its session id. The conversational route (`POST /api/supervisor/message`) arrives with the inbox in milestone 5. Until then the user steers it through `charter` and `delegate`. |

**DoD.**

- **One question, one proposal.** A supervisor is started in shadow mode, and a fixture tab sits at `answer-questions`. One `confirm.pending` for an `AskUserQuestion` then produces:
  - exactly one wake;
  - one supervisor turn (stubbed model);
  - one ledger line `{decision: "propose", verb: "answer", grounds: […]}`, with provenance on each ground.

  Afterwards, the tab's question is still pending.
- **Shadow performs nothing.** Spies on confirm resolution record zero calls.
- **Every refusal path is tested.** An ungrounded answer, a weak-grounds-only answer, an unresolvable citation and a heuristic-flagged question each produce `escalate` or `refuse` with a reason.
- **Containment is pinned:**
  - the disallowed list;
  - the `canUseTool` secret-path deny;
  - the exact `mcpServers`;
  - `marvin-supervise` absent from every executor turn's options;
  - a supervisor session is never woken or targeted, and `/api/chat` refuses one;
  - a `.marvin/supervisor*` file planted in the project is ignored;
  - a tab tool call naming the supervisor data directory or the control routes is denied in `auto` and in `full`;
  - supervisor routes refuse a request without the token.
- **Guardrails work.** Pause stops wakes. Kill aborts an in-flight wake. The per-wake breaker and the rate limits each have a test. Events during a wake reach the next wake.

### [2] The two API gaps — a first-class answer, and posture without a turn

Both routes serve the external prototype now, with the user's authority. The supervisor's verbs reach them only as proposals until milestone 4.

**Touchpoints — the answer.**

- **`src/app/api/confirm/answer/route.ts`** (new), over a shared `answerQuestion()` service. The service reads `getPendingOriginalInput` (`confirm-registry.ts:171-177`) and builds `{questions, answers}` exactly as `AskQuestionSheet.swift:248-266` does.
- **`answeredBy`** — `/api/confirm` and the new route record it on `confirm.decision`.

**Touchpoints — posture.**

- **`src/app/api/sessions/posture/route.ts`** (new; `actor: "user" | "supervisor"`, with the token required for `supervisor`).
- **`session-meta.ts`** gains `postureRevision` and `postureSource`.
- **`chat/route.ts:276-297`** keeps an API-set posture until the client echoes its revision. Watch rows carry the revision.
- **`mode` reaches server-started turns** — `runDetachedTurn`, `WakeupRecord` and `buildResumeRecord` carry it (`turn-orchestrator.ts:725-745`, `sdk-runner.ts:2158`). This closes the parked backlog item on dropped modes.
- **Live narrowing:** the gate reads strategy and mode from a mutable turn posture, so a narrowing applies at the next tool call (`sdk-runner.ts:2267-2268`). For the model, `setModel()` on a live query is used only if it is verified against the pinned SDK; otherwise the change applies from the next turn.
- **`isNarrowing(from, to)`** uses explicit orders:

  | Dimension | Order, widest first |
  |---|---|
  | Strategy | full > auto > gated |
  | Mode | agent > plan ≥ ask |
  | Effort | max > xhigh > high > medium > low |
  | Model | a pricier **or unpriced** model counts as widening |

**Touchpoints — the supervisor's verbs.** The `set_posture` verb arrives, and with `answer` is policy-evaluated in shadow.

**DoD.**

- **Answering by label works.** `POST /api/confirm/answer {marvinSessionId, toolUseId, answers: {"<question text>": "Option B"}}` resolves the question with an `updatedInput` identical to the `AskQuestionSheet` golden fixture, multi-select and "Other" included.
  - An unknown label answers 400, listing the valid labels.
  - An already-resolved question answers 409.
  - The transcript records `answeredBy`.
- **Posture changes without a turn.** `PUT /api/sessions/posture` with no turn running changes the stored posture and sends no turn. The next turn — user-sent or server-started — runs under it.
- **A live narrowing is immediate.** A narrowing applied during a live turn takes effect at the next tool call: to `gated`, the next write raises a confirm; to `ask`, it is denied. Covered by an integration test on the gate.
- **The chat route respects the revision.**
  - It keeps an API-set posture over a posted one from a client that has not echoed the revision.
  - It yields once the client echoes it.
  - A project that never used the route behaves exactly as before (regression test).
  - A wakeup, job-completion or resume turn in an Ask or Plan tab runs read-only.
- **Narrowing passes; widening escalates.** For the `supervisor` actor, every narrowing passes and every widening escalates. Covered by a table test that includes Plan → Agent and an unpriced model.

### [3] Authorship and the consent line

The gate learns who touched a turn, and holds touched turns to the user's consent. The send path is built here, and sends stay proposals until milestone 4.

**Touchpoints.**

- **`sendAsSupervisor()`** over `resumeSession` (`session-recovery.ts:275`). It:
  - waits for a live turn to end, never injecting or preempting;
  - starts a turn with `author: "supervisor"` in the turn registry, transcript and watch row;
  - wraps the message in the supervisor envelope.
- **`POST /api/chat`** accepts `author: "supervisor"` (token required) onto the same path.
- **The `supervisorTouched` mark** is set when a supervisor message starts a turn, or when the supervisor answers a question or confirm inside one.
- **The gate:**
  - inside a touched turn, every §4 act raises a user-only confirm, in every posture including `full` — the containment confirms ADR-0115 waives included;
  - the supervisor's verbs refuse such a confirm.
- **The act classifier over confirm kinds**, read from the registry's raising-rule record.
- **Send refusals:**
  - a shared-checkout tab while another live session works in that checkout;
  - a tab the user stopped;
  - a tab waiting on its own job or wakeup.
- **The nudge cap per plan step.**
- **Spend attribution** of supervisor-started tab turns, via `cost-tracker`.
- **The secret-shape scan** on `send` and `answer` text.
- **The `send` and `cancel` verbs**, in shadow.

**DoD.**

- **Authorship is visible.** A supervisor send to an idle tab starts one turn whose transcript, turn-registry entry and watch row read `author: "supervisor"`, and whose message reaches the model inside the envelope. A send to a tab with a live turn waits and never injects.
- **Touched turns ask the user.** Inside a supervisor-started turn, and inside a user-started turn after the supervisor answered a question in it:
  - `git push`, a merge-request command, an `.env` edit and an ADR-0102 HEAD-moving command each raise a confirm only the user can resolve;
  - this holds in `auto` and in `full`;
  - the supervisor's `confirm` verb refuses it.

  Covered by gate integration tests.
- **The chat route matches.** `POST /api/chat` with `author: "supervisor"` gets identical treatment. Without the token it is refused. A user message during a supervisor-started turn preempts it (ADR-0069).
- **Sends are refused where they should be,** in the three cases above. A third nudge at one plan step without spine progress is an escalation. A send carrying a secret-shaped string is refused.
- **Spend is attributed.** Tab turns the supervisor started count against its daily cap. At the cap, the loop pauses and ledgers an escalation.

### [4] Autonomy for questions, nudges and narrowing

The first time the supervisor performs anything. Each category is switched by the user.

**Touchpoints.**

- **Per-category autonomy** in state: questions, nudges, posture.
- **Acting verbs** — `answer`, `send`, `cancel` and `set_posture` perform through the milestone 2 and 3 services when their category is autonomous. Each act marks the turn touched.
- **Shadow pairing** — each proposal is paired with the actual answer on `confirm.resolved`, by `answeredBy`.
- **`GET /api/supervisor/stats`** — agreement per category, plus the question heuristic's misses.
- **Headless questions** — `maybeAskUserQuestion` (`sdk-runner.ts:1421-1454`) lets a headless turn's question in a delegated tab wait a bounded time for the supervisor, before ADR-0040's deny.
- **New wake triggers** — turn ended (except `stopped`), and idle with an open plan and nothing of its own pending.

**DoD.**

- **Grounded questions are answered.** With questions autonomous, a grounded question in an `answer-questions` tab is answered through `answerQuestion()`.
  - The transcript reads `answeredBy: "supervisor"` with the grounds.
  - The tab's model sees the answer marked as the supervisor's.
  - The turn is now touched.
- **Unsafe questions wait for the user.** A heuristic-flagged, ungrounded or weak-only question is never answered. It stays pending for the user, and the ledger reads `escalate`.
- **Nudges and narrowing perform once switched on.**
  - A nudge to an idle tab with an approved, unfinished plan starts one supervisor-authored turn.
  - A narrowing changes posture through the milestone 2 route.
  - Neither happens while its category is still in shadow.
- **Stats compare against the user.** `GET /api/supervisor/stats` reports agreement per category from a fixture ledger. Answers through `/api/confirm` are counted as the user's.
- **Headless questions fall back cleanly.** A headless turn's question in a delegated tab waits a bounded time for the supervisor, then falls back to ADR-0040's proceed-on-your-recommendation deny.

### [5] The escalation inbox, the remaining verbs, and the auditor's review

**Touchpoints — the inbox.**

- **The store and its route** — an inbox store beside the ledger, and `src/app/api/supervisor/inbox/route.ts`, token required:
  - GET;
  - POST `accept` / `override` / `dismiss`. Accept performs the raw act with `actor: "user"`.
- **Items show the raw act** — tool, input, digest, and a `git merge-tree` preview for merges — with the recommendation beside it.
- **Items resolve on their own** when their underlying confirm or question resolves anywhere.
- **`POST /api/supervisor/message`** — the user's conversation with the supervisor. It cannot grant consent.

**Touchpoints — the remaining verbs.**

- **Confirms autonomy** for `answer-confirms` tabs, through the `/api/confirm` service with `answeredBy: "supervisor"`.
- **The `worktrees` verb:**
  - list and preview, live;
  - sweep, performed — exactly what `worktree_sweep` reclaims, never a `session` tree of an open tab;
  - merge, merge-all, Prepare MR and drop-with-work, escalated.
- **`close_session` and `new_session`**, both escalated.
- **The wake trigger on scope-met handoffs.**

**Touchpoints — the auditor and docs.**

- **`POST /api/audit`** gains a supervisor target over a ledger window (`session-auditor.ts`), with the `ungrounded` / `overreach` / `loop` / `consent` finding classes.
- **`docs/guides/supervisor.md`** (new).

**DoD.**

- **Escalations become inbox items.** Every §4 act the supervisor recommends appears as an inbox item showing the raw act, with the recommendation separate.
  - `accept` performs the act as the user and resolves the item.
  - An item whose confirm the user answered in the tab resolves on its own.
- **Confirm autonomy respects the level.** With confirms autonomous:
  - an ordinary Edit confirm in a gated `answer-confirms` tab is answered by the supervisor;
  - the same confirm in an `answer-questions` tab is not;
  - no containment or metered-CI confirm is answered at any level.
- **Worktree acts escalate, except a safe sweep.** Merges, merge-all, Prepare MR and drops of work always escalate, with a preview attached. A sweep reclaims empty or merged non-session trees and leaves an open tab's tree alone.
- **The auditor reviews without reaching the supervisor.** A supervisor-target audit produces a report over the ledger window with the four new finding classes. Nothing reaches the supervisor session; a test pins the absence.
- **Docs catch up.**
  - `docs/guides/supervisor.md` explains delegation, shadow, the human-only list, the inbox, the token and what same-user code execution can still do.
  - The documents that still state the superseded clauses describe the supervisor as shipped: `docs/concepts/single-assistant.md`, the white paper and Technical Reference, and the README bullet.

### [6] The native surface — blocked on the Swift 6.1 toolchain

**Touchpoints.**

- **A Supervisor strip in `SessionsPane`**, in the ADR-0114 vocabulary:
  - the escalation inbox, with one-click accept or override on the raw act;
  - the ledger;
  - a per-tab delegation chip;
  - a budget meter;
  - Pause and Kill.
- **Transcript marking** for supervisor-sent messages and supervisor-given answers.
- **Posture revisions** — the app echoes `postureRevision` and adopts an API-set posture. ADR-0108's hydration rule is amended to match.
- **The app reads the capability token.**
- **The `supervisor` role** appears in the Models dialog's Helpers section.

**DoD.**

- **It builds.** `swift build` and the MARVINLogic assertions are green on a Swift 6.1 toolchain, with no change to `macos/Package.swift` made to work around a missing toolchain.
- **The Sessions pane is enough.** From the Sessions pane alone, the user can:
  - enable the supervisor;
  - set a tab's delegation;
  - accept and override an inbox item;
  - read the ledger;
  - see the budget;
  - pause or kill it.

  Each state is captured in a screenshot — measured, not assumed.
- **Supervisor output looks different.** A supervisor-sent message and a supervisor-given answer render visibly differently from the user's.
- **Posture stays in sync.** A posture changed in the toolbar after an API-set one sends the new revision. The toolbar shows an API-set posture within one watch refresh.

## Not in this plan

- **New authority.** Each of these would need a new ADR:
  - any write capability for the supervisor;
  - any task decomposition across tabs;
  - a supervisor that creates tabs on its own.
- **Whole-API authentication.** Authenticating the app's own loopback routes is out of scope. The capability token covers only supervisor-authority routes (ADR-0127 §5).
- **OS-level isolation** from code a tab executes. Same-user code execution is out of scope (ADR-0127 §5).
- **Automatic graduation** from shadow to autonomy.

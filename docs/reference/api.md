# HTTP API

All routes are Next.js route handlers under `sidecar/src/app/api/`. They run on `localhost:3030`. No auth layer — binding is localhost-only and treats every caller as the logged-in user.

Conventions:

- **Content-Type**: `application/json` unless noted (SSE streams use `text/event-stream`).
- **Errors**: `{ error: string }` with appropriate 4xx / 5xx status.
- **SSE events**: `event: <name>\ndata: <json>\n\n` framing.
- **CSRF guard on every mutating route**: `POST` / `DELETE` / `PUT` / `PATCH` handlers require the header `X-Marvin-Client: 1`. Without it the route returns `403 csrf-guard` without executing. The header forces a CORS preflight so a drive-by tab at another origin cannot trigger the request. `GET` routes are not gated — cross-origin reads are blocked by SOP. Client code should use the `marvinFetch` wrapper in `sidecar/src/lib/csrf.ts`, which attaches the header automatically on mutating methods. ADR-0009 originally established this for multipart uploads; the universal enforcement is the generalisation.

## Chat

### `POST /api/chat`

Start a new turn. Streams the Agent SDK's events back as SSE.

**Request body:**

```json
{
  "message": "...",
  "cwd": "/absolute/path/to/project",
  "projectId": "optional-id",
  "marvinSessionId": "optional-uuid-for-continuing-a-session",
  "model": "claude-sonnet-4-6",
  "advisorModel": "claude-opus-4-7",
  "personality": "marvin",
  "permissionStrategy": "auto",
  "runtimeMode": "opus",
  "skipProjectContext": false
}
```

All fields except `message` are optional. Resolution for `model` / `advisorModel`: explicit body wins, then `resolveRuntimeMode(runtimeMode)`, then `defaultModel()` ([see advisor strategy](../concepts/advisor-strategy.md#resolution-order)).

**Response:** `text/event-stream` with events:

| Event | Payload | Fires when |
|---|---|---|
| `turn.started` | `{ turnId, model, advisorModel, marvinSessionId }` | Turn begins |
| `cli.event` | `{ event: <SDKMessage> }` | Every Agent SDK event — assistant content, tool calls, tool results |
| `confirm.request` | `{ turnId, toolUseId, toolName, input, reason }` | Gate intercepted an Edit / Write / Bash (gated mode only) |
| `turn.completed` | `{ sessionId, durationMs, costUsd, tokenUsage }` | Turn finished |
| `turn.error` | `{ error: string }` | Turn failed (exception, not a tool denial) |

**Refusal — `409 { error, code: "worktree-failed", reason, hint }`.** A new tab that wants its own worktree (the default in a repository with a commit, or `tree: "worktree"`) and whose worktree cannot be created or prepared — a full disk, free space below the floor (`MARVIN_WORKTREE_MIN_FREE_GB`, default 10 GB), a failing `git worktree add` — is refused **before** any session meta or transcript is written. It is never run in the shared checkout; pass `tree: "shared"` to ask for that explicitly ([ADR-0122](../decisions/0122-a-tab-gets-its-worktree-or-is-refused.md)). `PUT /api/sessions/meta` answers the same 409 when a switch to a worktree cannot be made.

SSE connection close does **not** cancel the turn — see [Sessions](../operations/sessions.md). Use `POST /api/chat/cancel` to abort explicitly.

**A supervisor message — `author: "supervisor"`** ([ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md) §5, milestone 3). Needs the per-boot token in `x-marvin-supervisor-token` (`403` without it); any other `author` than `user` / `supervisor` is a `400`. Body: `{ author: "supervisor", message, projectId, marvinSessionId, supervisor?: { kind: "nudge" | "instruction", grounds?: [{ kind, ref }] } }` — an existing tab only. It takes the same server-side send path as the supervisor: the message is wrapped in an envelope that names the sender, recorded as `turn.user` with `author: "supervisor"` and `supervisor: { kind, ledgerId, grounds }`, and starts a `machine` turn (`turn.started.author: "supervisor"`) in the tab's stored posture, mode included, which is **supervisor-touched**: every human-only act in it raises a confirm only the user can answer, in every posture. It never injects into or preempts a live turn — it waits for it — and a user message preempts the turn it starts (ADR-0069). **Response:** `202 { ok: true, queued }` (no SSE; the turn announces itself on the feed), or `409 { error, detail }` with `error` one of `stopped` (the user stopped the tab), `waiting-on-own` (its own job or wakeup is pending), `shared-busy` (another session is working in the shared checkout), `secret` (a secret-shaped string), `closed`, `no-session`, `worktree-missing`, `supervisor-session`, `empty`, `too-long`. A queued message is checked again when it fires and dropped — with a ledger `drop` line — if the tab was stopped, put to waiting or closed meanwhile, the supervisor paused, or the tab stayed busy through every deferral.

### `POST /api/chat/cancel`

Abort an in-flight turn.

**Request body:** `{ marvinSessionId: string }`
**Response:** `{ ok: true }` or `{ ok: false, reason: "no active turn" }`

### `GET /api/chat/resume?marvinSessionId=…`

Reconnect an SSE stream to an already-running turn (e.g. after browser reload). Returns `204 No Content` when there's no live turn for that session — the client should fall back to the on-disk JSONL transcript.

### `GET /api/chat/announce?projectId=…`

Always-on SSE the client holds open for the whole time a project is loaded (ADR-0043). Emits `announce.attached` on connect, then a `turn.registered` `{ marvinSessionId, projectId, turnId, startedAt }` event for **every** turn registered in that project — including server-initiated ones (background-job completion, ADR-0038; timed wakeups, ADR-0031). An idle client that holds no live stream uses this to learn a turn it didn't start has begun and re-attach via `/api/chat/resume`, so the result renders without a session switch. A ~25 s heartbeat keeps the connection warm; read-only — it never starts/cancels/mutates a turn.

## Confirm gate

### `POST /api/confirm`

Resolve a pending confirm card.

**Request body:** `{ turnId: string, toolCallId: string, decision: "allow" | "deny", denyMessage?: string }`
**Response:** `{ ok: true }` or `{ ok: false, reason: string }`

The server looks up the pending resolver in [`confirm-registry`](../../../sidecar/packages/runtime/src/confirm-registry.ts) and resolves it — the SDK's `canUseTool` promise returns `{ behavior: decision, message: denyMessage }`.

For an **AskUserQuestion** decision (ADR-0040) the `allow` reply carries `updatedInput` (the `{ answers, questions }` the user chose) which becomes the tool result. Such confirms register with **no** auto-deny timeout — a decision waits for the human (fixed in v0.1.40; the 5-min default used to silently deny a slow decision).

Since ADR-0127 milestone 2 an `allow` on a question **must** carry `updatedInput.answers` — keys are pending question texts, values strings, at least one non-empty — or it answers `400` and the question stays pending (it used to resolve with the original input and nothing chosen). `questions` is taken from the registry, not the caller. Every decision is recorded on the transcript as `confirm.decision` with `answeredBy: "user"`.

### `POST /api/confirm/answer`

Answer a pending AskUserQuestion by label, so no caller hand-builds `updatedInput` ([ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md) §9). CSRF-guarded; user authority only.

**Request body:** `{ marvinSessionId, toolUseId, answers?: { [questionText]: label | label[] }, other?: { [questionText]: string }, turnId? }`.
**Response:** `{ ok: true, updatedInput }` — built exactly as the native sheet builds it (`AskQuestionSheet.swift`): every question keyed by its full text, picked labels in option order then the trimmed "Other" text, joined with `,`; an unanswered question is `""`; the original `questions` echoed. A single-select takes one answer (an option or "Other", not both).
**Errors:** `400` an unknown label (the message lists the valid ones), a question that was not asked, no answer, or a confirm that is not a question · `409` no live turn, a `turnId` that disagrees with the session's live turn, or already answered · `403` CSRF.

## Session posture

### `PUT /api/sessions/posture`

Change a tab's posture without sending a turn ([ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md) §9, ADR-0108 amendment). CSRF-guarded.

**Request body:** `{ projectId, marvinSessionId, posture: { model?, thinkingMode?, permissionStrategy?, mode? }, actor?: "user" | "supervisor", grounds? }`.
**Response:** `{ posture, postureRevision, postureSource, changes, liveApplied }` — `changes` lists each field with its direction (`narrow` / `widen` / `same`); `liveApplied` names the fields that reached a live turn.

- **No turn is sent.** The session meta is written with `postureRevision` (+1) and `postureSource`, and `postureOverride` holds the fields set here.
- **The app's next post does not undo it.** `POST /api/chat` keeps the held fields over the posture a client posts until the client sends `postureRevision` back (watch rows carry it as `postureRevision`, with `postureSource`; a client cannot acknowledge a revision the server never issued). The held fields and their source are recorded on the turn's `turn.started`. A session that never used this route behaves as before.
- **The supervisor narrows only; the user may also widen (since milestone 6).** A `supervisor` widening answers `409` with `widened` naming the dimensions, is ledgered as an escalation, and changes nothing. A `user` widening is accepted: the app now adopts an API-set posture within one feed event and echoes its revision, so the change is not hidden from the toolbar. It reaches the next turn, never a live one (`liveApplied` carries narrowings only). `postureBeforeSupervisor` on the session meta keeps, per field, what the supervisor narrowed away; a field the user sets drops out. `postureSetAt` records when the route last changed the posture. A tab cannot call this route: `sessions` is a control path the gate denies to tab tool calls (ADR-0127 §5).
- **Announced.** Every stored change emits `session.posture` (`{ marvinSessionId, projectId, postureRevision, postureSource }`) on the project feed — ids and the revision only. The app re-reads the watch rows on it and adopts the posture (ADR-0108 amendment, milestone 6).
- **A narrowing reaches a live turn** at its next tool call (strategy and mode); a model or effort change applies from the next turn. Queued, wakeup, job-completion and resume turns run the narrower of what armed them and what the tab holds now.
- **Orders:** strategy `full` > `auto` > `gated`; mode `agent` > `plan` / `ask`, with Plan ↔ Ask judged by the cost of the model each runs on (Plan runs the advisor); effort `max` > `xhigh` > `high` > `medium` > `low`; a model narrows only when the active catalogue knows it costs no more — an unpriced model is a widening.
- **`actor: "supervisor"`** needs the per-boot token (`x-marvin-supervisor-token`) and is ledgered with the given grounds: a narrowing as a performed act, a widening as an escalation.

**Errors:** `400` invalid patch or actor · `403` CSRF or a missing token · `404` unknown session · `409` a supervisor widening (`{ error, changes, widened }`).

## Supervisor

[ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md). Ships off; starts in shadow (proposes, performs nothing). From milestone 4 the user switches **autonomy per category** — `questions` (`answer`), `nudges` (`send`, `cancel`), `posture` (`set_posture`, narrowing only), and from milestone 5 `confirms` (`confirm`, ordinary gated cards in `answer-confirms` tabs). What the supervisor may not do becomes an item in the escalation inbox; the user's click on the raw act there is the consent. Every route needs the per-boot capability token in `x-marvin-supervisor-token`, read from `<MARVIN_DATA_DIR>/supervisor/token` (0600, minted at boot). Without it: `403`. A tab's model cannot reach these routes — the gate denies a tab tool call that names MARVIN's control API.

### `GET /api/supervisor?projectId=…`

**Response:** `{ state, status }`.

- **`state`** — `mode` (`off` | `shadow` | `autonomous`, derived: autonomous when any category is), `autonomy` (`{ questions, nudges, posture, confirms }`: `shadow` | `autonomous`), `revision` (increments on every change), `paused`, `pause` (`{ reason: "user" | "kill" | "budget" | "breaker" | "refusals" | "repeated-failures", at, detail? }` or `null`), `delegation` (`{ [marvinSessionId]: "observe" | "answer-questions" | "answer-confirms" }`), `charter`, `charterUpdatedAt`, `caps`, `lastWake`, `supervisorSessionId`, `spend` (`{ day, usd, ownUsd, tabsUsd }` — `usd` is what the daily cap reads; at the cap it pauses with `pause.reason: "budget"` and escalates).
- **`status`** — the design brief's §10.1 object: `projectId`, `revision`, `mode`, `autonomy`, `run` (`idle` | `waking` | `paused`), `pause`, `currentWake` (`{ wakeId, startedAt, itemCount }` or `null`), `queuedEvents`, `lastWake` (`{ wakeId, at, outcome: ok | failed | aborted | breaker, error? }`), `health` (`ok` | `stale` | `failed`, derived: `failed` when the last wake errored, `stale` when events have waited over five minutes with no wake running) with `healthSince`, `watchedTabs`, `openEscalations` (open inbox items), `budget` (`{ capUsd, spentUsd, spentOwnUsd, spentTabsUsd, resetsAt, level: ok | near (≥ 80 %) | reached }`), `charter` (`{ text, updatedAt }`), `model` (`{ role: "supervisor", resolved, label }`), `stats` (per category, as `/api/supervisor/stats`), `suggestedBar` (`{ minProposals: 20, minAgreement: 0.9 }` — a suggestion, never a gate), `confirmsEligible` (a tab is at `answer-confirms`), `caps` (`{ maxActionsPerWake, maxTurnsPerWake, perTabRate, globalRate }`), and from milestone 7.2 `messageRetry` (`{ state: retrying | failed, messageIds, attempts, nextRetryAt }` or `null`): user messages a message wake failed to answer, or ended without answering, are retried after 10 s, 60 s and 5 min; past that they are `failed` until Restart (`wakeNow`), a resume or a boot queues them again (ADR-0128 §6). A killed wake is not retried on its own.


Milestone 7.1: `budget` also carries `spentConversationUsd` (the supervisor's own spend in wakes the user's messages started) and `spentWatchingUsd` (the rest of its own spend); one cap still covers both and the tab turns it starts. The default cap is $20 (measured, plan [7.1]).
### `POST /api/supervisor`

CSRF-guarded (`X-Marvin-Client: 1`) and token-gated.

**Request body:** `{ projectId, action, … }` — `action` is one of:

- `start` — shadow mode, every category in shadow. Optional set-up fields, all checked before any applies: `charter`, `capUsd` (0 < cap ≤ 1000), `delegations: [{ sessionId, level }]` (≤ 50).
- `stop` / `disable` (the brief's name) — off; every category back to shadow.
- `pause`, `kill` (abort the wake in flight, then pause), `resume`, `wakeNow` (resume and wake at once, re-scanning pending questions). `resume` and `wakeNow` answer `409` while over the daily cap, or while off.
- `mode` — `{ mode: "off" | "shadow" }`; autonomy is per category, not here.
- `autonomy` — `{ category: "questions" | "nudges" | "posture" | "confirms", value: "shadow" | "autonomous" }`. `409` while off, and for `confirms` → `autonomous` (milestone 5).
- `cap` — `{ capUsd }`, 0 < cap ≤ 1000.
- `delegate` — `{ marvinSessionId, level }`; level `off` removes it; the supervisor's own session answers `400`.
- `charter` — `{ text }`, ≤ 4000 chars.

**Response:** `{ state, status }`, or `{ error }` with `400` / `403` / `409` / `413`. Every accepted action is a `control` line in the ledger.

### `GET /api/supervisor/stats?projectId=…`

Token-gated. **Response:** `{ stats, suggestedBar }` — per category: `proposals` (shadow proposals), `agreed`, `agreedBlind` (agreed without the user having revealed the proposal first), `agreementRate` (`agreed / paired`, `null` with nothing paired), `humanOnlyProposedAsAct` (the supervisor tried to act and the policy stopped a human-only act: a heuristic hit, a §4 confirm, a widening), `heuristicMisses` (a question the heuristic passed in a turn that then raised a human-only confirm). Agreement counts only the **user's** answers — the sheet, `/api/confirm`, `/api/confirm/answer`.

### `POST /api/supervisor/reveal`

CSRF-guarded and token-gated. **Body:** `{ projectId, ledgerId }`. A shadow proposal is blind on the watch row until revealed (brief open decision 1); the reveal is a ledger line, and the pairing records whether it came before the answer. Idempotent. **Response:** `{ ok: true }` · `404` no such shadow proposal · `409` already answered.

### `GET /api/supervisor/ledger?projectId=…&before=<seq>&limit=50&sessionId=…&decision=…`

Token-gated. **Response (milestone 5, brief §10.5):** `{ entries, hasMore, nextBefore, todayCount }` — the newest page of the append-only ledger (`<MARVIN_DATA_DIR>/supervisor/<projectId>/ledger.jsonl`), oldest first inside it; `before` pages backwards by `seq` (`nextBefore` is the cursor for the next page), `limit` defaults to 50 (max 500), `sessionId` (or milestone 1's `tab`) and `decision` filter. Each entry is a projection — lines on disk are never rewritten: `seq` (the line's position), `id`, `at`, `wakeId`, `actor` (`supervisor` for verbs, `user` for controls, inbox acts, messages and reveals, `runtime` for wakes, rotations, pairings, boot and auto-pause), `sessionId`, `tabTitle` (snapshotted when written; `null` on older lines), `verb`, `decision`, `mode`, `argDigest`, `argSummary` (server-built), `reason: { code, text }` (`code: "unspecified"` on lines from before milestone 3), `grounds` (full Grounds: `kind` — `plan-step` | `dod` | `adr` | `memory` | `charter` | `file` — `ref`, `tree`, `label`, `provenance`, `resolved`, `excerpt` ≤ 200 chars, `openTarget`; a secret file is never excerpted or opened), `pairing` (`{ actualAnswer, answeredBy, agreement: agree | disagree | pending, proposalSeenBeforeAnswer }` on an `answer` / `confirm` proposal), `inboxItemId`, `costUsd`. The stored line, for reference: `id` (from milestone 4; the brief's `ledgerId`), `at`, `kind` (`verb` | `wake` | `rotation` | `control` | `pairing` | `reveal` | `heuristic-miss`), `verb`, `tab`, `wakeId`, `mode`, `decision` (`propose` | `act` | `escalate` | `refuse` | `drop`), `reason`, `reasonCode` (a stable code, on lines written from milestone 3 on), `argsDigest`, `grounds` (with `provenance`), `heuristic`, `planSignature` (a `send` nudge's plan step, `done/total@lastTodoAt`), `costUsd`; from milestone 4 `turnId`, `toolUseId` and `answer` (the proposed labels per question, or `[allow|deny]`) on `answer` / `confirm` lines, `proposalId` on `pairing` / `reveal` / `heuristic-miss` lines, and `pairing` (`{ actualAnswer, answeredBy, agreement: agree | disagree, proposalSeenBeforeAnswer }`); from milestone 5 `kind` also `inbox` (the user acted on an item) and `message`, plus `tabTitle`, `inboxItemId` and `argSummary`.

### `GET /api/supervisor/inbox?projectId=…&state=open`

Milestone 5, brief §10.2. Token-gated. **Response:** `{ items }`, oldest first; `state` is `open` (default), `resolved`, `dismissed`, `superseded` or `all`. An item whose confirm or question is no longer pending is expired on read (`superseded`, `resolvedBy: "expired"`). Each item: `id`, `revision`, `createdAt`, `wakeId`, `sessionId` (`null` for a supervisor row — a new tab, a guardrail, a worktree act), `tabTitle`, `kind` (`question` | `confirm` | `integration` | `containment` | `discard` | `boundary-path` | `posture-widen` | `scope` | `new-tab` | `guardrail`), `escalatedBecause` (`{ code: human-only | ungrounded | weak-grounds-only | unresolvable-citation | heuristic | delegation-observe | nudge-cap | budget | breaker | refusals | repeated-failures, label, rule? }`), `heuristic` (`{ matched }`), `rawAct` (`{ toolName, input, digest, summary, outward, destructive, paths? }` — `summary` is built by the server from the tool and input, never from the supervisor's prose), `preview` (`{ kind: "merge-tree", verdict: clean | behind | conflict | unknown, behind?, added, removed, conflictFiles }`), `question`, `linkedConfirm` (`{ sessionId, turnId, toolUseId, raisingRule }`), `recommendation` (`{ actionId, answer?, text }`, text capped at 500), `grounds` (full Grounds, as the ledger), `actions` (`[{ id, label, role: consent | refuse | edit | dismiss, recommended, requiresExpanded }]` — the server's labels), `newTab` (`{ firstMessage, tree: { baseRef, baseSha, mode: "worktree" }, posture: { model, modelLabel, effort, strategy, mode }, wider, requestedBy: { kind: "user-message", ref, at } }`), `postureChange` (`{ from, to, widenedDimensions }`), `guardrail` (`{ kind, detail, verb?: raise-cap | resume }`), `modeAtCreation`, `state`, `resolvedBy` (`user` | `tab` | `expired`), `resolvedAt`, `burstRank` (age order among the tab's open items), `ledgerId`, and from milestone 7.2 `origin` (`{ kind: "message", messageIds }` on an item a conversation wake raised — assigned by the runtime from the wake, never by the model — else `null`). `escalatedBecause.code` also takes `message-hold` (7.1) and `shadow` (7.2: asked for in the conversation, the category in shadow). A `send` item offers `perform`, `edit` and `dismiss`.

Items resolve on their own when the confirm or question they are about is answered anywhere (`resolvedBy: "tab"`). A user or supervisor turn in a tab supersedes its close-with-keep item. Lifting a pause supersedes its guardrail item.

### `POST /api/supervisor/inbox`

Milestone 5. CSRF-guarded and token-gated. **Body:** `{ projectId, id, actionId, edits? }`. The user's click on the raw act **is** the consent: the item's stored act is performed with the user's authority — a question answered `answeredBy: "user"`, a confirm allowed or denied by the user, posture through `actor: "user"` (so a widening is still refused until the native milestone shows API-set posture), a merge local and unpushed, Prepare MR pushing only when the act said so, a close with `keep` committing a dirty tree first, a guardrail's cap raised and the supervisor resumed. `edits`: for a question's `answer-edit`, `{ answers?, other? }`; for a guardrail's `raise-cap`, `{ capUsd }`; for a `new-tab` item's `open` / `edit`, `{ firstMessage?, title?, posture? }` — the posture may only **narrow** what the card showed (`409` with the widened dimensions otherwise), and an edited first message stays the supervisor's, marked `editedByUser`; for a `send` item's `edit` (milestone 7.2, ADR-0128 §4), `{ text }` — the text only, never the tab or the kind; it is checked again for secret-shaped strings (`400`, `code: "secret"`) and the tab's send refusals, a scope-met tab refused (`409`, `code: "scope-met"`) unless the item is a scope review's, and it is delivered as `author: "supervisor"` with `editedByUser: true` on the transcript's `supervisor {}` block and on the `inbox` ledger line. A new tab is created through ADR-0122's atomic path in a **fresh worktree** (never the shared checkout or an existing tree, no fallback); its first turn is `author: "supervisor"` with `supervisor.kind: "first-message"` and supervisor-touched; one request opens one tab. **Response:** `{ ok: true, item, outcome: { message?, marvinSessionId? } }` · `400` an action the item does not offer, or bad edits · `404` no such item · `409` already settled, the act failed (the item stays open), a widening edit, a used request, or `code: "worktree-failed"` (ADR-0122: nothing opened).

### `POST /api/supervisor/message` · `GET /api/supervisor/message?projectId=…`

Milestone 5. The user's conversation with the supervisor. CSRF-guarded (POST) and token-gated. **Body:** `{ projectId, text }` (1–4000 characters; a secret-shaped string is refused). Records the message, ledgers a `message` line (without the text) and wakes the supervisor with it. It **cannot grant consent**: "approve X" here resolves no confirm and no inbox item — at most the supervisor escalates X. Its `id` is the only request `new_session` accepts. **Response:** `{ id, at }` · `409` the supervisor is off. **GET** answers `{ messages }` — the last 100, `{ id, at, from: user | supervisor, text }`, oldest first; the supervisor answers with its `reply` verb. **Milestone 7.1 (ADR-0128):** a message wakes the supervisor at once (no debounce) in a wake of its own; one arriving mid-wake turns that wake's remaining acts into escalations and is carried by the next wake; a message no reply answers is queued again on resume, on start and at boot. A reply also carries `wakeId` and `origin` (`{ kind: "message", messageIds }` — the user messages its wake carried), and every ledger line of that wake carries the same `origin`. Each new line is announced on the feed as `supervisor.message` (`{ projectId, id, from }`). **Milestone 7.2:** a reply may carry `items` — the inbox item ids its wake raised for its own messages (the server drops any other id: another wake's, a tab's escalation, an unknown one); the app renders each as the inbox card under the reply. In a message wake, a request the supervisor may not perform becomes such a card instead of a refusal: an act above an `observe` (or higher) tab's level (`delegation-observe`), or one whose category is in shadow (`shadow`); the same act from a tab-event wake is still refused or only proposed. Chat-origin ledger lines are left out of the shadow agreement stats and still count in `humanOnlyProposedAsAct`.

**Milestone 7.3 (ADR-0128 §5):** a supervisor reply may be a follow's **report** — `kind: "report"`, `origin: { kind: "follow", followId }`, written only in a wake one of the followed tab's existing triggers started (a human or supervisor turn ended, a scope-met handoff, an escalation on the tab; never a machine turn or the idle timer). A reply may carry `refs` — `[{ kind: tab | ledger | item, id, label }]`, resolved by the server (unknown ids are dropped; `label` is the server's: a tab's title, a ledger line's verb, an item's raw-act summary). A report answers no user message. A new-tab item's `newTab` gains `delegation` (`answer-questions` by default) and `follow` (`{ until: scope-met | merge-ready }`); on the accept `edits.delegation` may lower it to `observe` or `off` (raising it answers `409 widening`), the tab is delegated before its first message is sent, and — unless `off` — followed. A `merge-ready` follow's merge card is an integration item with the follow's `origin`; settling or dismissing it ends the follow.

**Milestone 7.4 — the native client.** The app's pinned Supervisor tab is a client of these routes and adds none: it posts the composer to `POST /api/supervisor/message`, re-reads the `GET` on each `supervisor.message` event, fetches each reply's `items` from `GET /api/supervisor/inbox` and settles them through `POST /api/supervisor/inbox` (one item, two views: the chat and *Needs you*), lists `GET /api/supervisor/follows` with *Stop following* as the `stop` action, and, while the open inbox holds the budget `guardrail` item, shows it at the foot of the conversation with its `raise-cap` action (ADR-0128 §7). The reply's own text is drawn with every link removed; only `refs` are links.

### `GET /api/supervisor/follows?projectId=…` · `POST /api/supervisor/follows`

Milestone 7.3 (ADR-0128 §5). The tabs the supervisor follows for the user. Token-gated; POST is CSRF-guarded. **GET** answers `{ follows }` — the open follows and the last 20 ended, oldest first: `{ id, revision, createdAt, sessionId, tabTitle, until: scope-met | merge-ready, requestId, state: open | ended, endedAt, endedBy: scope-met | merge-settled | merge-dismissed | closed | unfollow | user }`. **POST** `{ projectId, id, action: "stop" }` is the *Stop following* chip: it ends the follow (`endedBy: "user"`) and ledgers a `control` line `follow.stop`. **Response:** `{ follow }` · `404` no such follow · `409` already ended. Stored append-only in `<MARVIN_DATA_DIR>/supervisor/<projectId>/follows.jsonl` (0600), each line validated where it is read. Each change is announced on the feed as `supervisor.follow` (`{ projectId, id, sessionId, state }`). At most 5 open per project; a follow ends at its scope-met review (`scope-met`), when its merge card is settled or dismissed (`merge-ready`), when its tab closes, on `unfollow`, or on this chip.

### `POST /api/audit` with `{ target: "supervisor" }`

Milestone 5 (ADR-0127 §7, ADR-0059 amended). CSRF-guarded and token-gated. **Body:** `{ target: "supervisor", projectId, since?, until?, model? }` (ISO dates). One bounded, read-only auditor session — `AUDITOR_DISALLOWED_TOOLS`, the read-only graph only, never the supervisor's SDK session — over the ledger window, the inbox it raised, and the transcripts of the tabs it acted on, with deterministic leads for the four classes `ungrounded`, `overreach` (including an act with no wake behind it), `loop` and `consent`. The report goes to the user and is persisted 0600 under `<MARVIN_DATA_DIR>/supervisor/<projectId>/audits/`; it writes no ledger line, sends the supervisor nothing and starts no wake. **Response:** the session audit's shape (`{ ok, report, path, findingCount, findings, costUsd }`) · `400` nothing in the window · `403` no token.

**Watch rows** (`GET /api/sessions/watch`) carry, from milestone 5, `supervisor.openEscalations` (open inbox items about the tab) and, from milestone 4, `supervisor.lastActAt` and, on each pending confirm, `supervisorProposal` (`{ ledgerId, actionId, answer?, grounds }` — `answer` and `grounds` only once revealed) and `proposalRevealed`. `answer` is the labels per question in question order (the brief sketched a map). The project feed's `confirm.resolved` carries `answeredBy` (`user` | `supervisor`), `ledgerId` for a supervisor answer, and a question's `answerValues`; `turn.ended` carries `kind` (`human` | `machine`) and `author`. From milestone 5 the feed also carries `supervisor.inbox` (`{ change: added | updated | resolved, id, revision, sessionId, kind, state, resolvedBy }`), `supervisor.ledger` (`{ seq, id, sessionId, verb, decision, inboxItemId }`) and `supervisor.state` (`{ revision, mode, paused }`), and from milestone 7.1 `supervisor.message` (`{ projectId, id, from: user | supervisor }`) — ids and states only: the feed holds no token, so a client fetches the body from the routes above.

`POST /api/chat` answers `409 { error: "supervisor-session" }` for the supervisor's own `marvinSessionId`: it is never run as an ordinary tab.

**The watch row (`GET /api/sessions/watch`) — milestone 3 fields.** Each row carries `supervisor: { delegation, sharedCheckout, touchedTurn: { turnId, at, by: "message" | "answer" } | null, waitingOnOwn: "job" | "wakeup" | null, stoppedByUser }` (design brief §10.4); a live `turn` carries `author: "supervisor"` when a supervisor message started it; each `pending[]` confirm carries `userOnly` — only the user may answer it (a containment, money or touched-turn confirm in a supervisor-touched turn). The transcript gains `turn.supervisor-touched` lines, and `confirm.decision` carries `grounds` and `ledgerId` when the supervisor answered. The session meta keeps `supervisorTouched`, so a resume after a restart inherits the touch.

## Backlog

The project backlog (ADR-0044) — actionable deferred work parked under `<workDir>/.marvin/backlog/`. All verbs delegate to the shared `backlog.ts` store, the same code the `marvin-backlog` MCP tool writes through. Mutating verbs are CSRF-guarded and validate `workDir` against the registered-project set.

### `GET /api/backlog?workDir=…&status=…`

List backlog items, optionally filtered by `status` (`open` | `doing` | `done` | `dismissed`). **Response:** `{ workDir, items: BacklogItem[] }`.

### `POST /api/backlog`

Add an item (manual UI add — the model path is the MCP tool). **Body:** `{ workDir, title, body?, severity? }`. **Response:** `{ ok: true, item, created }` or `400 { error }`.

### `PATCH /api/backlog/[id]`

Set an item's status (`done` / `dismissed` / `doing` / `open`). **Body:** `{ workDir, status, note? }`. **Response:** `{ ok: true, item }` or `404`.

### `POST /api/backlog/promote-issue`

Optional export — file an item as a GitHub issue via `gh` (needs an `origin` remote). The backlog stays the source of truth. **Body:** `{ workDir, id }`. **Response:** `{ ok: true, url }` or `409` (no remote) / `502` (gh failed).

## Projects

### `GET /api/projects`

List registered projects + active id.

**Response:** `{ projects: ProjectRecord[], active: string | null }` where

```ts
interface ProjectRecord {
  id: string;
  name: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
}
```

### `POST /api/projects`

Add a project.

**Request body:** `{ name: string, workDir: string }`
**Response:** `{ project: ProjectRecord }` or 400 with `{ error }` if path doesn't exist / isn't a directory.

### `DELETE /api/projects?id=…`

Remove a project from the registry. Does NOT delete any files.

**Response:** `{ ok: true }`

### `GET /api/projects/active`

Get the currently-selected project id.

**Response:** `{ active: string | null }`

### `PUT /api/projects/active`

Set the active project.

**Request body:** `{ id: string }`
**Response:** `{ active: string }`

### `GET /api/projects/verify?path=…`

Check whether a path would be a valid `workDir`. Called by the add-project dialog for live validation.

**Response:** `{ exists: boolean, isDirectory: boolean, readable: boolean, displayName: string | null }`

## Sessions

### `GET /api/sessions?projectId=…`

List saved session transcripts for a project, newest first.

**Response:**

```ts
{
  sessions: Array<{
    sessionId: string;
    firstUserTurn: string;  // truncated preview
    updatedAt: string;
    byteSize: number;
  }>
}
```

### `GET /api/sessions/[sessionId]?projectId=…`

Return the full JSONL transcript (parsed into an array).

**Response:** `{ record: SessionRecord }` where `SessionRecord.turns` is an array of `turn.user`, `cli.event`, `turn.completed`, `turn.error`, and `confirm.*` entries in timestamp order.

The chat-stream hook (`useChatStream.hydrateFromSession`) consumes this to rebuild the UI from history.

## Cost

### `GET /api/cost?projectId=…`

Aggregated spend for a project. Each request also refreshes the cached
OpenRouter account balance and key usage (`/api/v1/credits` + `/api/v1/key`,
3 s bounded each, best-effort) when the configured provider is `openrouter`.

Every figure is **per turn**: the SDK's `total_cost_usd` / `modelUsage` are
cumulative across a resumed session, and the tracker records each turn's
delta. Entries recorded before 2026-10-31 stored the cumulative total and are
reported only in `legacy`, never added into the periods.

**Response:**

```ts
type AuthMode = "subscription" | "anthropic-api" | "openrouter" | "gateway" | "cloud-provider" | "other" | "unknown";
type Aggregate = {
  costUsd, turns,
  inputTokens /* uncached only */, cacheReadTokens, cacheCreationTokens,
  cacheWrite5mTokens, cacheWrite1hTokens, outputTokens,
  estimatedTurns, unpricedTurns,
};
{
  today:    Aggregate & { byAuthMode: Partial<Record<AuthMode, Aggregate>> };  // costUsd sums modes: never show it unlabelled
  week:     { /* same shape */ };
  lifetime: { /* same shape */ };
  daily:    Array<{ day: string /* YYYY-MM-DD */, costUsd, turns }>;  // last N active days
  byModel:  { today: ModelRow[], week: ModelRow[] };  // { authMode, model ("unknown model" for old entries), costUsd, turns, tokens…, estimated }
  legacy:   { costUsd, turns, from, to } | null;      // pre-2026-10-31 entries; overstated, not comparable
  openRouter:    { totalCredits, totalUsage } | null;
  openRouterKey: { usage, usageDaily?, usageWeekly?, usageMonthly?, limitRemaining?, fetchedAt } | null;  // OpenRouter's own billed figures, key-wide
  account:  { subscriptionType?, tokenSource?, apiKeySource?, apiProvider?, at } | null;  // SDK accountInfo(); never email or organization
  claudeRateLimits: Array<{ type, status, utilization?, resetsAt?, at /* last reported */, label, inLatestReport: boolean | null }>;
    // a window whose resetsAt passed with no report since is omitted;
    // inLatestReport=false: absent from the newest report that sized windows (shown dimmed)
}
```

Returns zeroes for unknown `projectId` (safe default, not an error).

## Audit

### `GET /api/audit/auto?cwd=…&limit=…`

Returns the tail of `<cwd>/.marvin/auto-audit.jsonl` — one entry per
auto-allowed mutating tool call (Edit / Write / Bash) under the
`auto` permission strategy. Surfaced in the Settings panel so users
can review what MARVIN actually ran without prompting them.

Read-only Read / Grep / Glob / WebFetch / WebSearch are deliberately
**not** logged — they have no audit value and would drown the file.
Hard-denied calls (the `BASH_HARD_DENY` regex set) are also absent
because they never reach the log path.

**Query params:**

- `cwd` (required) — absolute path to the project root. Sandboxed
  through `checkFsPath`; same rules as every other file route.
- `limit` — newest-N to return. Default `50`, hard cap `500`.

**Response:**

```ts
{
  entries: Array<{
    at: string;          // ISO-8601 timestamp
    tool: "Edit" | "Write" | "Bash";
    reason: string;      // why the gate auto-allowed (regex match label, etc.)
    descriptor: string;  // short, redacted descriptor — first 200 chars of the command / file path
    turnId: string;      // correlate to the chat transcript
    toolUseId: string;   // SDK tool-use id
  }>;  // newest-first
}
```

**Errors:**

- `400 missing-cwd` — `cwd` query param absent or empty.
- `400 <fs-sandbox error code>` — `cwd` failed `checkFsPath` (e.g.
  `cwd-not-absolute`, `not-found`, `not-a-directory`).

Implementation: [`sidecar/src/app/api/audit/auto/route.ts`](../../sidecar/src/app/api/audit/auto/route.ts);
the writer lives at [`sidecar/packages/runtime/src/auto-audit.ts`](../../sidecar/packages/runtime/src/auto-audit.ts).
See [ADR-0015](../decisions/0015-auto-mode-policy-floor-and-audit-log.md)
for the policy rationale.

## Files

All file routes share a single path sandbox: `checkFsPath` in [`sidecar/packages/runtime/src/fs-sandbox.ts`](../../sidecar/packages/runtime/src/fs-sandbox.ts). Paths outside `cwd`, symlinks (target or ancestor), paths containing NUL, and paths longer than 1024 bytes are rejected before I/O. See [ADR-0008](../decisions/0008-user-initiated-write-channel.md). The ignore list lives in [`sidecar/packages/tools/src/fs-constants.ts`](../../sidecar/packages/tools/src/fs-constants.ts) and is shared with the user-initiated write policy (M2).

### `GET /api/files/tree?cwd=…&depth=…`

Project-scoped file tree walker.

**Response:** `{ root: string, tree: FsNode, truncated: boolean, count: number }`

- Default `depth: 6`, max `MAX_ENTRIES: 2000`.
- Ignores: the shared `IGNORE_DIR_NAMES` set — `node_modules`, `.git`, `.next`, `.turbo`, `venv`, `__pycache__`, `target`, `dist`, `build`, `coverage`, `.DS_Store`, caches, `vendor`.
- Symlinks are skipped during the walk (matches the sandbox's reject-by-default policy for read routes).

### `GET /api/files/content?cwd=…&path=…`

Read one file. Path must be inside `cwd`; symlinks are rejected.

**Response:** `{ path, size, mtime, maxSize, binary, truncated, content }`

- 4 MB cap (`maxSize`). Larger files return `truncated: true` with the first 4 MB of content — the editor mounts these read-only so the user can scan the prefix without risking a save that would overwrite the tail of the real file.
- Binary detection via null-byte + non-printable heuristic on the sampled prefix. Binary files return `binary: true, content: null`.
- `mtime` (`fs.stat.mtimeMs`) is the CAS token for subsequent `/api/files/write/save` requests.
- Error codes returned via `{ error: "<sandbox-error-code>" }`: `404 not-found`, `400 path-escapes-cwd | symlink-rejected | symlink-escapes-cwd | is-directory`, `500 io-error`.

### `GET /api/files/status?cwd=…`

`git status --porcelain=v1` + current branch name, 5s per-call timeout.

**Response:** `{ isGit: boolean, branch: string | null, status: Record<absolutePath, porcelainCode> }`

Returns `{ isGit: false, status: {} }` outside a git work tree *or* when the sandbox check on `cwd` fails. Consumed by the file tree (dirty-file badges + branch pill) and the header's `<BranchBadge>`.

### `GET /api/files/raw?cwd=…&path=…`

Stream the raw bytes of a sandbox'd file with a best-effort `Content-Type` header. Used by the binary-file preview (images, PDFs) embedded in the file viewer. Text files should use `/api/files/content` instead so the editor gets the binary + truncation metadata in JSON.

**Caps:** 10 MB. Larger payloads return `413 too-large` rather than streaming gigabytes through the handler.

### `GET /api/files/search?cwd=&q=&caseSensitive?=&wholeWord?=&useRegex?=&include?=`

Ripgrep-backed full-text search across the project. ripgrep honours `.gitignore` / `.ignore`, so results exclude `node_modules`, `dist`, etc. automatically. Optional `include` is a comma-separated glob list forwarded as `--glob` flags (e.g. `*.ts,*.tsx` or `src/**`).

**Response:** `{ results: [{ file, matches: [{ line, col, text }] }], truncated }`

**Caps:** 500 matching files, 50 matches per file, 10 s timeout.

Consumed by the macOS app's Find in Files sidebar tab (`FindInFilesView`) — see ADR-0021 milestone M2.

### `POST /api/files/reveal`

Reveal a file or directory in the OS file browser:

- macOS: `open -R <path>` (Finder)
- Linux: `xdg-open <parentDir>` (no portable "select" recipe; opens the parent directory as the pragmatic fallback)
- Windows: `explorer /select,<path>`

Not a write channel — doesn't mutate files — but it spawns a subprocess against a user-supplied path, so it still gates on `checkFsPath` and passes the canonical path as a positional argv entry (no shell interpolation).

**Request body:** `{ cwd: string, path: string }`
**Response:** `{ ok: true }` on success, `{ error: string }` otherwise.

## Files — write channel

User-initiated write endpoints under `/api/files/write/*`. Parallel to the LLM write channel (`canUseTool` + `toolPolicy`): paths go through the shared sandbox (`checkFsPath`), ops go through `fsWritePolicy`, and `confirm`-classified ops require an `X-Marvin-Confirmed: <token>` header minted by `/api/files/write/confirm`. See [ADR-0008](../decisions/0008-user-initiated-write-channel.md).

**Shared error codes** (all `POST` bodies are JSON; all responses are JSON):

| Status | Body shape | Meaning |
|---|---|---|
| `400` | `{ error: "<code>" }` | Bad request or sandbox rejection (`path-escapes-cwd`, `symlink-rejected`, `path-contains-null`, `path-too-long`, `is-directory`, `not-a-directory`). |
| `403` | `{ error: "policy-deny", reason }` | `fsWritePolicy` denied (deny-list segment, project-root, oversize). |
| `404` | `{ error: "not-found" \| "parent-not-found" }` | Required path missing. |
| `409` | `{ error: "needs-confirm", reason, severity, tokenError? }` | Policy returned `confirm` without a valid token. |
| `409` | `{ error: "exists" }` | Create / rename target already exists (no implicit overwrite). |
| `409` | `{ error: "stale", currentMtime, size }` | Save CAS: on-disk mtime differs from `expectedMtime`. |
| `409` | `{ error: "collisions", collisions: string[] }` | Move: at least one destination exists; whole batch aborted. |
| `500` | `{ error: "io-error", detail }` | Unexpected OS error. |

### `POST /api/files/write/confirm`

Mint a one-shot token for a `confirm`-classified op. Tokens are scoped to the exact op+cwd, expire in 60 s, and are consumed on first use.

**Request body:** `{ cwd: string, op: FsWriteOp }`

**Response (confirm required):** `{ needsConfirm: true, reason, severity: "warn"|"danger", token, expiresIn: 60 }`

**Response (policy auto-classified):** `{ needsConfirm: false, reason }` — caller can run the op directly without a token.

**Response (policy deny):** `403 { error: "policy-deny", reason }`.

### `POST /api/files/write/create`

Create a new file or empty directory.

**Request body:** `{ cwd, path, kind: "file"|"dir", content?: string, overwrite?: boolean }`

- `kind: "file"`: writes UTF-8 `content` (default `""`). Uses `wx` flag unless `overwrite: true`.
- `kind: "dir"`: `fs.mkdir` non-recursive; parents must exist.

**Response:** `{ ok: true, path }` or an error code above.

### `POST /api/files/write/save`

Save an edit to an existing file. Supports optimistic-concurrency via `expectedMtime`.

**Request body:** `{ cwd, path, content, expectedMtime?: number }`

- Caps content at 5 MB (`WRITE_SIZE_MAX_BYTES` in `fs-write-policy.ts`); larger payloads 403.
- On mtime mismatch returns `409 stale` with `currentMtime` so the UI can surface the conflict.

**Response:** `{ ok: true, path, mtime, size }`.

### `POST /api/files/write/rename`

Rename a file or directory. Case-only renames on APFS/HFS+ are a `confirm` class (the operation otherwise no-ops silently).

**Request body:** `{ cwd, from, to }` — `to` must not already exist unless it's a case-only collision that was confirmed.

**Response:** `{ ok: true, from, to }`.

### `POST /api/files/write/move`

Move one or more files/dirs into a destination directory. Batched for multi-select DnD. Pre-flights all collisions; aborts the whole batch on any collision.

**Request body:** `{ cwd, from: string[], to: string }`

**Response:** `{ ok: true, moved: Array<{ from, to }> }`.

### `POST /api/files/write/delete`

Delete one or more files/dirs.

**Request body:** `{ cwd, paths: string[], mode: "trash"|"permanent" }`

- `mode: "trash"` → routes through the `trash` npm package (macOS Trash / Windows Recycle Bin / XDG trash). Auto-classified (reversible).
- `mode: "permanent"` → `fs.rm({ recursive: true, force: false })`. Always `confirm danger`; always requires a fresh token.

**Response:** `{ ok: true, deleted: string[], mode }`.

### `POST /api/files/write/upload`

OS → tree file upload via multipart. Used by drag-and-drop from Finder onto the tree root or a directory. See [ADR-0009](../decisions/0009-file-uploads-from-os.md).

**Request** (`multipart/form-data`):

- `cwd` — project root (form field).
- `destDir` — destination directory path (form field).
- `file` — one or more file parts.
- **Required header: `X-Marvin-Client: 1`** — forces a CORS preflight so cross-origin drive-by POSTs are blocked by the browser before reaching the route. Without it the route returns `400 missing-x-marvin-client`. Non-negotiable; see ADR-0009.

**Caps:** 50 files per batch · 10 MB per file · 50 MB total batch.

**Response:** `{ ok: true, uploaded: Array<{ name, path, bytes }>, skipped: Array<{ name, reason }>, destDir }`.

Over-cap or policy-rejected files appear in `skipped[]` with a human-readable reason; the rest of the batch still lands. Secret-bearing files (`.env*`, keys) are skipped rather than prompted — users who want to upload one should drag it alone or paste via New File + save.

## Source control

Git is MARVIN's **third mutation channel** — parallel to the LLM tool channel and the user-initiated filesystem channel. Every mutating route runs `checkFsPath(cwd)` → `gitWritePolicy(op)` → (on `confirm` class) require `X-Marvin-Confirmed: <token>` minted by `/api/git/confirm`. See [ADR-0012](../decisions/0012-source-control-mutation-channel.md).

Every git invocation goes through [`runGit`](../../sidecar/packages/git/src/exec.ts) (`execFile` with `shell: false`); user-supplied refs / paths / remotes pass through [`argv-guards`](../../sidecar/packages/git/src/argv-guards.ts) before appending to argv; commit messages travel via stdin, never argv.

**Read routes:**

### `GET /api/git/status?cwd=…`

Branch metadata + per-file status, parsed from `git status --porcelain=v2 --branch -z`.

Success: `{ enabled: true, branch: { oid, name, upstream, ahead, behind }, files: Array<{ path, indexStatus, workingStatus, entryType, renamedFrom, ordinary }> }`.

`enabled: false, reason: "not-a-git-repo"` when the path isn't inside a git worktree. `oid`, `name`, `upstream`, `ahead`, `behind` are all nullable (`null` for initial repos, detached HEAD, no upstream). `entryType` is one of `ordinary | rename-copy | unmerged | untracked | ignored`. `indexStatus` / `workingStatus` are single-char porcelain-v2 codes (`M A D R C U T .`).

**Caching:** responses carry a weak `ETag` derived from the raw porcelain bytes. Clients that send `If-None-Match: <etag>` receive a `304 Not Modified` with an empty body when nothing structural has changed — the 2 s panel poll uses this to avoid re-parsing / re-rendering on an idle tree. Note: porcelain v2 is content-agnostic on the working tree, so unstaged content changes within a file that's already in the list don't invalidate the ETag; the panel picks them up when the file's bucket changes (stage / unstage / save-to-disk transitions).

### `GET /api/git/diff?cwd=&path=&mode=working|staged|head`

Per-file diff. Default `mode=working`. 2 MB cap on response body; larger returns `truncated: true` with empty `diff`.

Success: `{ path, mode, diff: string, binary: boolean, truncated: boolean }`.

Binary files return `binary: true` with `diff: ""`. Path is rejected with `400 invalid-pathspec` if it fails `isSafePathspec` (leading `-`, NUL, magic `:` prefix).

### `GET /api/git/branch?cwd=…`

Success: `{ enabled: true, current: string | null, locals: Array<{ name, isCurrent, upstream, ahead, behind }>, remotes: string[] }`.

Formatted from `git for-each-ref` using `%00`-separated field strings so branch names containing `|` / tabs / unicode parse cleanly.

### `GET /api/git/log?cwd=&limit=50&path?=`

Recent commits. Default `limit=50`, hard cap 500. Optional `path` filters to commits touching that file.

Success: `{ enabled: true, commits: Array<{ sha, shortSha, author, email, date, subject }> }`.

Initial repos (no commits yet) return `commits: []` rather than an error.

**Mutation routes:**

Every mutation route goes through `checkFsPath(cwd)` → `gitWritePolicy(op)`. If the policy returns `confirm`, the route returns `409 needs-confirm` with `{ severity, reason, op }`; the client round-trips to `/api/git/confirm` for a token and replays the original request with `X-Marvin-Confirmed: <token>`. Tokens are one-shot and validate the op structurally — the stored op must match the executing op or the replay is rejected with `409 token-rejected`.

### `POST /api/git/stage` — `{ cwd, paths: string[] }`

`git add -- <paths>`. Every path passes `isSafePathspec` (rejects leading `-`, pathspec-magic `:`, NUL, oversize). Auto-class.

Success: `{ ok: true, staged: number }`.

### `POST /api/git/unstage` — `{ cwd, paths: string[] }`

`git restore --staged -- <paths>`. Working tree unchanged. Auto-class.

Success: `{ ok: true, unstaged: number }`.

### `POST /api/git/discard` — `{ cwd, paths: string[], mode: "working" | "staged" }`

- `mode: "staged"` — `git restore --staged` (auto). Same effect as unstage.
- `mode: "working"` — `git restore` (confirm **warn**). Resets working tree to index; edits are gone.

Success: `{ ok: true, discarded: number, mode }`.

### `POST /api/git/commit` — `{ cwd, message, amend?: boolean }`

Message travels via stdin (`git commit -F -`). Never via argv. `isSafeCommitMessage` rejects empty / NUL / > 16 KB. The route detects `hasPushedHead` by `rev-parse @{u}` + `merge-base --is-ancestor HEAD @{u}`; amend with `hasPushedHead: true` is `confirm danger`.

Amending with no new message passes `--no-edit` so git keeps the existing message.

Success: `{ ok: true, amend, hasPushedHead }`. `409 nothing-to-commit` when the index is empty and `--amend` wasn't set.

### `POST /api/git/branch/create` — `{ cwd, name, from?: string }`

`git branch <name> <from>`. `from` defaults to `HEAD`. `name` and `from` (unless `HEAD`) must pass `isSafeRef`. Auto-class.

Success: `{ ok: true, name, from }`. `409 branch-exists` when the branch is already present.

### `POST /api/git/branch/switch` — `{ cwd, name }`

`git switch <name>`. The route probes `git status --porcelain`; non-empty output denies as `policy-deny` with reason "working tree is dirty". v1 does not stash-on-switch.

Success: `{ ok: true, name }`. `404 branch-not-found` when the target doesn't exist.

### `POST /api/git/branch/delete` — `{ cwd, name, force?: boolean }`

`git branch -d <name>` (or `-D` when `force: true` or when the branch is unmerged). The route probes `git symbolic-ref HEAD` + `git branch --merged` to populate the policy op. Current branch is hard-denied; unmerged is `confirm danger`.

Success: `{ ok: true, name, merged, forced }`.

### `POST /api/git/confirm` — `{ cwd, op }`

Mints a one-shot token for a `confirm`-class op. Returns `{ token, expiresIn: 60, severity, reason }`. Rejects with `400 policy-auto` when the op doesn't actually need confirming, and `403 policy-deny` when the op is always-denied.

**Remote routes (ADR-0013):**

Credentials are inherited from the user's git configuration — MARVIN never stores, proxies, or prompts. `GIT_TERMINAL_PROMPT=0` turns any interactive credential prompt into immediate stderr. See [`sidecar/src/lib/git-remote-errors.ts`](../../sidecar/src/lib/git-remote-errors.ts) for the stderr classifier.

### `POST /api/git/fetch` — `{ cwd, remote?: string }`

`git fetch <remote>`. Default `remote = "origin"`. Auto-class.

Success: `{ ok: true, remote, note }` (`note` is the trimmed progress output on stderr).

### `POST /api/git/pull` — `{ cwd, strategy: "ff-only" | "rebase" | "merge" }`

- `ff-only` (auto): `git pull --ff-only`. Fails cleanly on divergence.
- `rebase` (confirm warn): `git pull --rebase`.
- `merge` (confirm warn): `git pull --no-rebase --no-ff`.

Refuses on a dirty working tree with `409 dirty-working-tree`.

Success: `{ ok: true, strategy, note }`.

### `POST /api/git/push` — `{ cwd, remote?, branch?, forceWithLease?: boolean }`

Default `remote = "origin"`, `branch = <current>`, `forceWithLease = false`. Plain `--force` is never available — the policy layer hard-denies it from every channel. `--force-with-lease` is `confirm danger`. A regular push when upstream is ahead is `confirm warn`.

Success: `{ ok: true, remote, branch, forced, note }`.

**Remote error taxonomy** (returned from all three routes on failure):

| HTTP | `error` | Meaning | `remedy` |
|---|---|---|---|
| 502 | `auth-publickey` | SSH key rejected | check your SSH key is loaded and authorised |
| 502 | `auth-failed` | HTTPS auth failed or no credentials | configure a git credential helper |
| 502 | `network` | Could not resolve host / timeout / refused | check network connectivity |
| 409 | `non-fast-forward` | Push rejected, upstream has commits you don't | pull first or push --force-with-lease |
| 409 | `no-upstream` | No upstream configured | `git push -u <remote> <branch>` in the terminal |
| 409 | `merge-conflict` | Pull produced conflicts | resolve in editor, stage, commit (or `git merge --abort`) |
| 409 | `dirty-working-tree` | Pull refused — tree not clean | commit or discard changes first |
| 409 | `detached-head` | Push refused — not on a branch | check out a branch before pushing |
| 502 | `no-remote` | Remote URL not reachable | check `git remote -v` |
| 502 | `git-failed` | Unclassified git error | inspect stderr |

Every remote-error response includes `stderr` (raw git output) and `remedy` (one-line hint) alongside `error`.

**Errors:**

| HTTP | Error | Meaning |
|---|---|---|
| 400 | `not-a-git-repo` | `.git/` not found at or above `cwd`. |
| 400 | `invalid-ref` / `invalid-remote` / `invalid-pathspec` | Argv-guard rejected the input. |
| 403 | `policy-deny` | `gitWritePolicy` returned `deny`. Body carries `{ reason }`. |
| 409 | `needs-confirm` | `gitWritePolicy` returned `confirm`. Body carries `{ severity, reason, op }`. Client mints a token via `/confirm` then retries with `X-Marvin-Confirmed`. |
| 409 | `token-mismatch` | Token was minted for a different op or cwd. |
| 409 | `token-expired` | Token older than 60 s. |
| 502 | `git-exit-nonzero` | git exited non-zero; body carries `{ exitCode, stderr }`. |
| 504 | `git-timeout` | Operation exceeded 10 s (60 s cap). |

## Terminal

### `POST /api/terminal/run`

Spawn a shell command in the project `cwd`. Streams output as SSE.

**Request body:** `{ cwd: string, cmd: string }`

**SSE events:**

| Event | Payload |
|---|---|
| `started` | `{ cmd, startedAt }` |
| `stdout` | `{ data: string }` |
| `stderr` | `{ data: string }` |
| `exit` | `{ code: number \| null, signal: string \| null, durationMs: number }` |

- Spawns via `$SHELL -c`, so pipes, `&&`, env vars work.
- 10-minute cap. Request-abort kills the child.
- 8 KB `cmd` length cap.

Consumed by the embedded xterm.js terminal pane.

## Graph

### `POST /api/graph/query`

Query the active project's `graphify-out/graph.json`. Passthrough to [`@marvin/graphify-bridge`](../../sidecar/packages/graphify-bridge/).

**Request body:** `{ cwd: string, op: "summary" | "search" | "neighbors" | "path", args: {...} }`

### `GET /api/graph/query?cwd=&op=&q=&hops?=&from?=&to?=&limit?=`

Same passthrough, exposed as a GET so simple queries (search-by-label, single-node neighbors) can be hit without a body. The query-string form is what the macOS app's Symbol Search (⌘⇧T, ADR-0021 milestone M3) uses.

### `GET /api/graph/html?cwd=…`

Returns the project's pre-rendered `graphify-out/graph.html` as raw HTML for an `<iframe>` mount. Cached for 60 s; the graph itself is regenerated by `/graphify . --update`, not per-turn.

The HTML is served with a strict CSP (sandbox attribute + `frame-src 'self'` only) because the `graph.html` file lives inside the user's repo and a malicious PR could in principle land injected JS that hits MARVIN's same-origin API. See the route source for the full layered mitigation.

## Models

### `GET /api/models`

List available models. Attempts Anthropic's `/v1/models` endpoint with whatever credentials are readable — or OpenRouter's `/v1/models` when the configured provider is `openrouter` (that list additionally carries per-model `contextWindow` and `pricing`); falls back to a minimal static list when the models endpoint cannot be reached with the configured key.

**Response:**

```ts
{
  models: Array<{
    id: string;              // "claude-opus-4-7" | "z-ai/glm-5.3-flash"
    displayName: string;     // "Claude Opus 4.7"
    tier: "opus" | "sonnet" | "haiku" | "other";
    createdAt: string | null;
    live: boolean;           // true if from the live API, false if from fallback
    contextWindow?: number;  // OpenRouter only
    pricing?: { prompt: string; completion: string;
                input_cache_read?: string; input_cache_write?: string };  // OpenRouter only, USD per token
  }>;
  source: "anthropic-api" | "fallback";
  error: string | null;
  fetchedAt: string;
}
```

Consumed by the header's `<ModelPicker>` and by the per-turn cost
estimator (`calculateEstimatedCost`).

## OpenRouter proxy

### `POST /api/proxy/openrouter/[...path]`

Local bridge that lets the Claude Agent SDK talk to OpenRouter BYOK: the SDK insists on `x-api-key` + an `sk-ant-` prefix, so this route strips the prefix, re-injects the real key as `Authorization: Bearer …`, and proxies the request (streaming response passthrough) to `https://openrouter.ai/api/<path>`. Guarded by the loopback CSRF checks (Origin allowlist + `Sec-Fetch-Site`) — the CLI client sends no browser headers, but a drive-by browser tab can't pass the checks either.

**Request:** the SDK's Anthropic-shaped body, forwarded verbatim. Headers: `x-api-key: sk-ant-api03-<openrouter-key>` (the spoofed form the runner sets).

**Response:** OpenRouter's response, status + body + stream verbatim (`content-encoding` / `transfer-encoding` stripped).

## Health

### `GET /api/health`

Runtime status + auth detection + defaults.

**Response:**

```ts
{
  ok: boolean;
  auth: {
    mode: "api-key" | "host-credentials" | "none";
    credentialHint: string | null;
    error: string | null;
  };
  claudeBinary: string | null;
  binaryError: string | null;
  defaultModel: string;       // `defaultModel()` return — the fallback, NOT the live model
  dataDir: string;            // resolved MARVIN_DATA_DIR, or default ~/.marvin/
}
```

**Note:** `defaultModel` is the fallback used only when `/api/chat` doesn't get an explicit model. It is **not** what any active turn is using. See [Health checks](../operations/health.md) for how to inspect the actual live model.

## Authentication

UI-managed Anthropic credential mode for the Settings panel ("Authentication" section). The choice persists at `~/.marvin/auth-config.json` (file mode `0600`) and overrides every env-var path; see [Credentials](../security/credentials.md) for the full resolution chain. The raw key only travels in the `POST` body; every `GET` returns a redacted form (last-4 only).

### `GET /api/auth/config`

Returns the current config and the resolver's effective decision.

**Response:**

```ts
{
  config: {
    mode: "cli" | "api-key" | null;        // null = no file (default)
    keyHint: string | null;                 // "…wxyz" when api-key + key
    savedAt: string | null;                 // ISO timestamp of last write
    path: string;                           // absolute path of the config file
  };
  file: {
    exists: boolean;
    mode: number | null;                    // POSIX permission bits (0o600 expected)
  };
  effective: {                              // what getAnthropicAuth() will return
    mode: "host-credentials" | "api-key" | "oauth" | "none";
    credentialHint: string | null;
    error: string | null;
  };
}
```

### `POST /api/auth/config`

Persist a mode change (and optional key).

**Request body:**

```ts
{
  mode: "cli" | "api-key";
  apiKey?: string;       // required when mode === "api-key"; trimmed
}
```

**Response:** same shape as the `GET` payload, reflecting the new state.

**Errors:**

| Status | Body | Meaning |
|---|---|---|
| `400` | `{ "error": "mode must be 'cli' or 'api-key'" }` | Missing or unknown mode |
| `400` | `{ "error": "apiKey is required when mode is api-key" }` | mode=api-key without a key |
| `413` | `{ "error": "body too large" }` | `Content-Length` over 8 KB |

### `DELETE /api/auth/config`

Remove the config file. Resolution falls back to `ANTHROPIC_API_KEY` in the environment.

**Response:** same shape as `GET`, plus `removed: boolean` (false when the file didn't exist).

## Honeycomb (telemetry)

Per-project Honeycomb configuration for OpenTelemetry export. The raw API key only travels in a `POST` body; every `GET` returns the redacted form. Files are written with `0600` permissions to `<cwd>/.marvin/honeycomb.json`. Resolution precedence (highest first): `HONEYCOMB_*` env vars, per-`cwd` file, global `~/.marvin/honeycomb.json`. See [`honeycomb-config.ts`](../../sidecar/packages/runtime/src/honeycomb-config.ts) for the storage layout.

### `GET /api/honeycomb/config?cwd=…`

Masked status for the UI — answers "is Honeycomb configured for this project, and where is the config coming from?" without leaking the key.

**Response:** `{ status: "env" | "workdir" | "global" | "none", apiUrl, environment, dataset, keyHint }` where `keyHint` is the last 4 chars of the key.

### `POST /api/honeycomb/config`

Write `<cwd>/.marvin/honeycomb.json`.

**Request body:** `{ cwd: string, apiKey: string, apiUrl?: string, environment?: string, dataset?: string }`
**Response:** `{ ok: true }` on success.

### `DELETE /api/honeycomb/config?cwd=…`

Remove the per-project config file. Global config (and env vars) are unaffected.

**Response:** `{ ok: true }`.

### `POST /api/honeycomb/test`

Verify a Honeycomb config by hitting Honeycomb's `/1/auth` endpoint. Returns the team slug + environment so the UI can confirm the user keyed in the right credentials without leaving MARVIN.

Two modes:

- **Saved:** `{ cwd }` — resolves config via env → workdir → global precedence. `404` if nothing is configured.
- **Ad-hoc:** `{ cwd, apiKey, apiUrl?, environment? }` — tests the provided credentials without writing anything.

**Region fallback:** if the first attempt 401s on the default US cluster, the route retries the EU cluster (`api.eu1.honeycomb.io`). On EU success the response includes `regionFallback: true` and `suggestedApiUrl` so the UI can offer a one-click fix. Most Honeycomb 401s are region mismatches, not bad keys.

## Related

- [Session persistence](../operations/sessions.md) — how JSONL transcripts + resume work.
- [Confirm gate](../concepts/confirm-gate.md) — how `/api/confirm` integrates with the SDK's `canUseTool`.
- [Tool policy](../security/tool-policy.md) — what triggers a `confirm.request`.

## Practice (ADR-0105)

The practice loop's read model and verbs. All mutations require the `x-marvin-client: 1` header; every route keys on a **registered** `projectId`, never a path. See the [Practice guide](../guides/practice.md).

| Method | Route | Body / query | Returns |
|---|---|---|---|
| GET | `/api/practice` | `?projectId=` | `{ projectId, config, findings[], rules[], runs[], lastRun }` — seeds the four built-in gate rows on first read |
| POST | `/api/practice` | `{ config: { enabled?, hour?, thresholds?, verifyWindow?, weights?, costScale? } }` | `{ config }` |
| POST | `/api/practice/run` | `{ projectId, force? }` | `{ run, view }` — `force` ignores watermarks (the backtest) |
| POST | `/api/practice/findings` | `{ projectId, id, action: "approve", tier?, message?, global? }` · `{ …, action: "dismiss", reason }` · `{ …, action: "fixed", reason }` · `{ …, action: "escalate" }` | `{ ok, rule?, view }` |
| POST | `/api/practice/rules` | `{ projectId, id, tier?, status?, message?, global? }` | `{ ok, rule, view }` — built-in rows accept tier / status / message only |
| POST | `/api/practice/fit` | `{ projectIds?, apply? }` | `{ fit, config? }` — dry by default |
| POST | `/api/practice/draft` | `{ projectId, id }` | `{ ok, message, rationale, costUsd }` — one read-only model call over aggregates; nothing persisted |

Files: `~/.marvin/practice/config.json`, `~/.marvin/practice/rules.json`, `~/.marvin/practice/<projectId>/ledger.json`.

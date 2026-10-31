# Supervisor — implementation plan

- **Decision:** [ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md); milestone [7]: [ADR-0128](../decisions/0128-the-user-talks-to-the-supervisor.md)
- **Written:** 2026-10-30 (Phase A).
- **Status:** milestones [1]–[5] built 2026-10-30 (see "What milestone 1 changed" through "What milestone 5 changed" below). [1]–[3] are shadow only; [4] lets the user switch questions, nudges and posture to autonomous; [5] adds confirms autonomy, the escalation inbox, the remaining verbs and the auditor's review. Milestone [6], the native surface, built 2026-10-30 (see "What milestone 6 changed"). Milestones [3]–[6] reconciled with the UI design brief on 2026-10-30 (see "The UI's shapes" below). Milestone [7], the conversation ([ADR-0128](../decisions/0128-the-user-talks-to-the-supervisor.md)), planned and **shipped 2026-10-31**: [7.1]–[7.4] built, the last of them finishing the native surface (see "What [7.4] changed" under [7.4]).
- **Design brief:** [`docs/design/supervisor-brief.md`](../design/supervisor-brief.md). Its §10 is the contract milestones [3]–[5] produce and milestone [6] consumes.
- **Branch discipline:** each milestone lands on a tab branch; the user merges.

## What milestone 1 changed from the text below

Found while building it, mostly from the advisor's review of the security surface:

- **A tab's Read / Grep / Glob never reach `toolPolicy`.** The SDK auto-allows them. The side-door rule therefore also runs as an executor PreToolUse hook (`side-door-hook.ts`), registered ahead of the design hooks.
- **The control-route rule matches any host.** The sidecar binds loopback only, so `127.1`, `0`, a decimal IP and `lvh.me` all reach it. The rule also URL-decodes and collapses slashes first, and covers a network tool in command position (`nc`, `socat`, `node -e`, …) that names the port and a control path anywhere. The port is the one requests actually arrive on (`noteSidecarPort`), with the environment as a fallback.
- **The supervisor reads only inside the project.** Read / Grep / Glob paths resolve against the project root, symlinks are followed before the secret check, and only `marvin-graph`'s read verbs are admitted — `graph_save_result`, `graph_reflect`, `graph_export_callflow` and `graph_index_schema` write.
- **A `marvin-supervise` call refused for provenance is ledgered.** Three in one wake pause the supervisor and escalate.
- **The token is minted only at boot.** Verification fails closed before boot, and the GET routes need the token too.
- **Deferred to milestone 4, with the idle trigger that needs them:** the `background-jobs.ts` / `wakeup-scheduler.ts` lookups. Milestone 1's only trigger is a pending question.
- **Plan steps count as strong grounds only when the plan was seeded from the user's brief.** Plan approval is not recorded server-side yet (ADR-0127 §4 item 6), so a plan the tab presented is weak.

## What milestone 2 changed from the text below

Mostly from the advisor's review:

- **Queued turns** get the narrower-of rule too, not only wakeup, job-completion and resume turns: a narrowing set while a turn runs survives into the queued message that follows it.
- **A client cannot acknowledge a revision the server never issued** (`ackRevision` clamps it), and a held posture is recorded on `turn.started` (`postureHeld`, `postureSource`).
- **Plan ↔ Ask is judged by model cost.** Both are read-only at the gate, but Plan runs the advisor model; Agent → Plan / Ask stays a narrowing.
- **Server-started turns move only to a model known to cost no more** than the one that armed them; a pricier override does not elevate a wakeup.
- **`/api/confirm` refuses an `allow` on a question that carries no answer** — the hole the first-class answer exists to close.
- **`POST /api/confirm/answer` is user authority only.** The supervisor answers for real only after milestone 3's consent gate.
- **Model changes never apply to a live turn.** `setModel()` on a running query is not used; strategy and mode narrowings do reach the live turn.
- **The API refuses every widening, the user's included** (decided by the supervisor, 2026-10-30). Until milestone 6 the app neither echoes a revision nor shows an API-set posture, so a user's `permissionStrategy: "full"` through the route made a tab run full auto while its toolbar still read gated. That is a hidden widening, the worst case ADR-0127 §4 names. `applyPostureChange` now answers `409` for any widening with `widened` naming the dimensions; narrowing passes for both actors. Proved by `posture.test.ts` ("a user widening … is refused"), `m2-routes.test.ts` ("refuses a user widening until the app shows API-set posture") and `posture-gate.test.ts` ("a widening during the turn is refused"). **Milestone 6 follow-up:** re-allow a *user's* widening once the app shows API-set posture. A supervisor widening stays an escalation.

## What milestone 3 changed from the text below

Mostly from the advisor's review of the consent gate (go-with-caveats):

- **A touched turn turns containment back on.** `full` waives the lane, shared-tree and session-worktree confirms (ADR-0115); in a touched turn the gate runs those rules as `auto`, and each confirm they raise is the user's alone. A worktree tab's Edit into the main checkout is denied outright, as in `auto`.
- **The classifier (`supervisor-acts.ts`) reads the act, not a description of it,** and covers more than the DoD's four examples. It catches integration (push, merge, merge and pull requests, CI). It catches containment, scoped to a shared checkout; in a tab's own worktree, `git pull` / `stash` / `checkout -b` are routine. It catches discard commands, writes to the ship-review gate's boundary list (`matchShipBoundary` — one list, which already holds auth, migrations and `.github/workflows`), and plain shell writes to those paths: redirect, `tee`, `cp`, `mv`, `install`, `sed -i`. It catches tools on an MCP server MARVIN did not register, and the `marvin-control` merge and remove verbs. It also runs for subagent calls: an implementer's push inside a touched turn asks the user. The security audit found that git's global options (`-C dir`, `-c k=v`, `--git-dir=…`) hid the subcommand from it; they are stripped before classification.
- **The touched card does not double a gated one.** The user's allow runs the call through the ordinary gate at `auto`, so the hard-deny floor holds and no second gated card appears. A containment or money rule can still ask its own question after it: a known second card, kept for those rules' richer reasons.
- **User-only is decided when asked, not when raised** (`isUserOnlyConfirm`). It holds for the touched rule's own card, and for a containment or money confirm in a turn touched now, including one raised before the supervisor answered a question in the same turn.
- **The touch survives a restart.** It lives in memory for the gate, on the session meta (`supervisorTouched`) for readers, and in the transcript (`turn.supervisor-touched`). A resume of a touched, interrupted turn is touched too.
- **A queued supervisor message is checked again when it fires.** One dropped — the tab was stopped, put to waiting or closed, the supervisor paused, or the tab stayed busy through every deferral — leaves a ledger `drop` line, never only a console warning.
- **The nudge cap counts from the ledger** (`planSignature` on each nudge line), so a restart does not reset it.
- **A shadow `confirm` verb arrives here, not in milestone 5.** The DoD's "the supervisor's confirm verb refuses it" needs a verb to test. It evaluates and ledgers only; there is no confirms autonomy. Like every verb, it imports nothing that resolves a confirm or starts a turn: the send path's refusal rules reach the verbs as an injected dependency.
- **The loop's over-budget skip became a pause** (`pause.reason: "budget"`) with an escalation, as the DoD asks.
- **Spend counts completed turns.** A supervisor-started tab turn that fails or is preempted reports no cost to the tracker, so it does not reach `tabsUsd`.
- **Not caught, by design.** Obfuscated shell writes (ADR-0127 §5). A `git commit` whose diff touches a boundary file: each write met the gate when it was made, and writes from before the touch were the user's turn. Plan approval: no server-side approval exists yet (ADR-0127 §4 item 6).

## What milestone 4 changed from the text below

- **A category acts only when switched, and `start` always means shadow.** `start`, `disable` and `mode` reset every category to shadow; the switches persist across a restart. A state file claiming `autonomous` with no category behind it boots off, as in [1]. `confirms` is refused (`409`) until [5].
- **The tab's model reads a supervisor answer as the supervisor's.** The SDK renders an AskUserQuestion result as "User has answered your questions". So each value the supervisor gives carries a mark after the label ("… answered by the MARVIN supervisor on the user's behalf, not by the user"). Pairing compares the unmarked labels.
- **"Each act marks the turn touched" applies to the acts that put supervisor words into a turn.** `answer` touches it through `answerQuestion`, and `send` starts a touched turn ([3]). `cancel` ends the turn. A `set_posture` narrowing only removes authority. Neither touches.
- **The performing functions are injected** (`VerbDeps.perform`), as [3] did for the send refusals. `supervisor-mcp.ts` still imports nothing that resolves a confirm, starts a turn or changes a posture. A shadow fixture's `perform` throws, so the [1]–[3] suites now also prove nothing was performed.
- **An act names its ledger line before performing,** so `confirm.decision.ledgerId` and a `send`'s `supervisor.ledgerId` cite it. A perform that fails becomes a `refuse` line with the failure's code. Ledger lines gain `id` from [4]. Older lines have none, and the [5] projection keys them by `seq`.
- **Pairing is written as new lines, not edits:** `pairing`, `reveal` and `heuristic-miss` kinds name their proposal by `proposalId`. Agreement counts only the user's answers. The supervisor agreeing with its own act is not evidence.
- **`heuristicMisses` is defined deterministically.** A miss is a question the heuristic passed, answered or proposed, in a turn that then raised a human-only confirm.
- **The headless wait covers the no-UI path only.** Every production turn runs through `runDetachedTurn`, which always wires a UI callback, so a wakeup turn's question already waits for a person (ADR-0040's no-timeout rule), and the supervisor answers it through `confirm.pending`. The bounded wait (3 min, then ADR-0040's deny) applies where the gate has no UI. It needs a delegated tab, autonomous questions, and a supervisor that is running and under budget.
- **Idle tabs stay idle:** `scopeMetAt` and the trigger rules, from the day's supervision (see [4]'s touchpoints).
- **The wake packet states the categories every wake,** and the system prompt no longer claims shadow. A resumed SDK session must not act on yesterday's switches.
- **Status details.** `status.model.label` is the catalogue's display name. `supervisorProposal.answer` is the labels per question in question order; the brief sketched a map keyed by question text. `health` reads `stale` after five minutes of queued events with no wake.
- **From the advisor's review (go-with-caveats):**
  - *A user way back from a supervisor narrowing.* The app neither echoes revisions nor widens through the API before [6], so an autonomous narrowing would otherwise be permanent. The posture route now accepts one widening: a user restoring a field the supervisor narrowed to exactly its prior value (`postureBeforeSupervisor`, kept from the supervisor's first narrowing). Anything wider is still refused.
  - *A supervisor cancel is the supervisor's.* The transcript's `turn.error`, `lastTurn.stoppedBy` and the terminal event all name it, and the watch row's `stoppedByUser` stays false. It still parks the tab for the user: a runaway is not re-nudged on the supervisor's own say-so.
  - *Autonomous `cancel` stops only a machine or supervisor turn that has not begun writing.* A turn the user started, or a mid-write one (ADR-0069), escalates.
  - *A pause, a kill or the cap reached mid-wake stops every act not yet performed* (`paused` / `budget` refusals), as `headlessQuestion` already did.
  - *The state loader never boots wider than its file.* `mode: "shadow"` loads every category in shadow. Autonomy restored at boot is ledgered as a `boot` line.
  - *The answer mark* says the answer authorises nothing the user must decide, not "on the user's behalf".
  - *The heuristic also reads the supervisor's own words:* a `send` message and an "Other" answer naming a §4 act escalate.
  - *A scope-met claim the ADR-0057 guard rejects does not set `scopeMetAt`* (`reportsScopeMet`).
  - *The turn-ended and idle triggers need `answer-questions`.* An `observe` tab has nothing to act on and, before the inbox, nowhere to escalate.
  - *The headless wait is 10 minutes, not 3,* so it outlasts a wake already running. The pending question carries its payload, so the watch row shows it.
  - *A widening refused at perform time counts in `humanOnlyProposedAsAct`.*
- **From the security audit:** a `charter` or `dod` ground resolved whenever its `ref` was any substring of the charter or brief. One character made a strong ground, and since [4] a strong ground is what lets the supervisor act. A quote now needs at least 12 characters and two words (`MIN_QUOTE_CHARS`).
- **From the pre-landing review:** the polled watch route and every `confirm.resolved` now read the ledger. `readLedger` caches the parsed file on its (size, mtime); the file is append-only.
  - *Not done here, stated:* the act's ledger line is written after the act, so a crash between them loses the line while the transcript cites its id. ADR-0127 §2 trigger 4 (wake on a scope-met handoff and read the claim against the evidence) is deferred to [5]; until then a scope-met tab is the one the supervisor does not look at. Parked here, both since done (2026-10-31): charging cancelled or failed supervisor-started turns to the cap (the failure path records and charges the turn's cost), and escalating repeated failed outcomes (§6 — `send` escalates with `repeated-failures` once a tab's last two turns ended in error, counted in its meta as `failedTurnsInARow`).
- **A test-harness trap, recorded for the next milestone.** This worktree had no `node_modules`, so `@marvin/*` resolved to the main checkout's packages, and sidecar tests ran against main's runtime. With `isolate: false`, the global supervisor loop can also be subscribed to a `turn-registry` that another file reset. A route test that needs the loop starts its own.

## What milestone 5 changed from the text below

- **The inbox is event-sourced.** Each change writes the whole item again as a new line in `inbox.jsonl` beside the ledger (0600, the data dir). The newest line per id is the item. Settling is once. `dedupeKey` holds across every state, so a dismissed close item is not raised again for the same scope-met close.
- **The ledger line and the item name each other.** Both ids are chosen before either is written: `inboxItemId` on the line, `ledgerId` on the item.
- **Actions come from the server** (`actionsFor`), from the item's stored act: `answer` / `answer-edit`, `allow` / `deny`, `perform`, `open` / `edit`, `raise-cap` / `resume`, plus `dismiss`. Consent replays the stored act with the user's authority (`supervisor-inbox-actions.ts`); the performers are injected, as the verbs' are. While a consent is in flight its own `confirm.resolved` does not settle the item as the tab's.
- **The feed carries ids and states only.** `/api/chat/announce` holds no token, and the items, lines and state are token-gated. The `supervisor.inbox`, `supervisor.ledger` and `supervisor.state` events say what moved, and a client fetches the rest.
- **An item expires on read** when its confirm or question is no longer pending: a turn that unwinds clears its confirms without a `confirm.resolved`.
- **A refusal is not an item.** Refusals are the supervisor's mistakes. Escalations are the user's decisions.
- **Confirms autonomy acts only on the gated strategy's card** (`raisedBy: "gated"`). Any other rule, or none recorded, escalates. `resolveConfirm` checks it again, so the verb and the service each hold a lock.
- **`worktrees sweep` is performed in shadow too.** It reclaims exactly what `worktree_sweep` reclaims, which every tab close already does silently (ADR-0111), and §4 item 3 says it is not discarding. It is ledgered `act` with `reasonCode: "safe-sweep"`.
- **A new verb, `review_scope`,** answers the scope-met wake (§2 trigger 4). `send` refuses a scope-met tab ([4]), so the supervisor's answer is an item: `ready` is the same close-with-keep item the idle path raises, sharing its key; `missing` proposes sending the tab what is missing, on the user's click.
- **`reply`** is the supervisor's side of the conversation (`messages.jsonl`). It is not ledgered, because it is not an act.
- **`new_session`'s request is a user message** from `POST /api/supervisor/message`, cited by id. `requestedBy.kind: "approved-proposal"` is declared by the brief, but nothing writes it: approving a suggestion is the user replying in the conversation. One request is one tab: a request with an open or opened item refuses a second. The base posture is the user's most recently updated open tab, and `wider` is measured against it. When no posture is given, the base is used as it is.
- **The idle close item is deterministic**: no wake and no model. The loop arms the idle timer for every watched tab, `observe` included. A finished tab is offered for closing whatever its level. Its ledger line is the runtime's (`kind: "wake"`, `verb: "propose-close"`).
- **Consent with `keep` commits a dirty tree first** (`commitFirst`), so nothing kept can be lost to a sweep (ADR-0111). Close with `merge` does not: a dirty tree answers `worktree-dirty`.
- **A posture-widen item's consent goes through `actor: "user"`,** so until [6] it answers the [2] refusal like any API widening. This item is the one consent the inbox cannot perform yet.
- **The close route's logic moved to `session-close.ts`** unchanged, so the route and the inbox share one close.
- **Guardrail items** come from `pauseSupervisorForFault`. Raise-cap and resume perform through `applySupervisorAction` with the token, and any user action that lifts the pause supersedes the item.
- **The audit's report lives under the data dir** (`supervisor/<projectId>/audits/`, 0600), not the project's `.marvin/audits/`, for the reason the ledger does. The route needs the token. Its runner is injectable, and a test pins its options: the graph only, the auditor's disallowed list, no `resume`.
- **From the pre-landing review:**
  - *Two clicks on one item performed twice.* For a new-tab item that meant two tabs for one request. A consent is now refused while another on the same item is in flight (`code: "in-flight"`).
  - *A declared value nothing wrote.* `requestedBy.kind: "approved-proposal"` was dropped from the type. Round-trip tests were added for `supervisor.state`, the ledger's `message` line, `by: "confirm"` and `editedByUser`.
  - *Re-parsing.* Each ledger and inbox append made the next read re-parse the whole file. The caches now extend in place on our own appends.
  - *Pre-existing, left alone:* milestone 4 declared the ledger's `trigger` field, and nothing writes it.
- **From the security audit:**
  - *A symlinked secret.* A ground citing a link in the repository to a key outside it would have been excerpted. Symlinks are now resolved before the root and secret checks.
  - *A second lock in `resolveConfirm`.* For the supervisor it classifies the act against the human-only list again, so a gated card carrying a push is refused even if a caller skips the verb.
  - *The auditor's prompt* now wraps the inbox summaries as untrusted, because they can quote tool input.
- **Deferred, stated:** the brief's `burstRank` is computed per tab among open items; the "+N more" grouping is the app's. `heuristic-miss` is not wired for confirms the supervisor answered. Charging cancelled or failed supervisor-started turns to the cap, and escalating repeated failed outcomes, were parked from [4] and landed on 2026-10-31 (see [4]).

## What milestone 6 changed from the text below

- **A posture change is announced.** Nothing told the app that `PUT /api/sessions/posture` had run, and nothing refreshed the watch rows on a timer, so "the toolbar shows an API-set posture within one watch refresh" had no refresh to ride on. The route now emits `session.posture {marvinSessionId, postureRevision, postureSource}` (ids only — the feed holds no token); the app re-reads the rows on it and adopts.
- **User widening re-allowed, the restore rule folded in.** With the app adopting API-set posture, `applyPostureChange` accepts any user widening. Milestone 4's "restore exactly the prior value" exception is subsumed and removed; `postureBeforeSupervisor` still tracks what the supervisor narrowed. A user widening reaches the next turn only.
- **`confirm.resolved` carries `decision` through to the app,** so a supervisor's deny is chipped "denied by", not "allowed by".
- **The app's token handling.** The token is read from `<MARVIN_DATA_DIR>/supervisor/token` (the sidecar's own rule), sent only to the loopback sidecar, re-read once after a 403, and refused unless it is exactly 64 hex characters — a file carrying a CR/LF never reaches a header. The snapshot harness never reads it.
- **Departures from the brief** are recorded in the brief's §11.

## Constraint that shapes the order

- **Milestones 1–5 are sidecar-only:** engine, routes and verbs, fully covered by vitest. Robert's external Claude Code mod is the interim UI, through the routes.
- **Milestone 6 is the native surface, and it is not blocked.** This plan first said the Mac had no Swift 6.1 toolchain and could not build the app. Since 2026-10-30 it can, with the recipe in `macos/MARVIN/SurfaceSnapshot.swift`'s header:
  - Swift 6.4.2 from swift.org, against the Command Line Tools' 14.4 SDK;
  - a local SwiftTerm 1.20.0 pin;
  - the Metal `.process` → `.copy` patch in the SwiftTerm checkout;
  - `-DMARVIN_LEGACY_SDK`.

  All of it touches only untracked state (`Package.resolved`, `.build/`). `macos/Package.swift` is still not modified to work around the SDK.
- **The order still holds.** Milestone 6 consumes the shapes milestones 3–5 produce, so it comes last.

## The UI's shapes — the design brief's §10, reconciled

The brief lists every backend field and mutation the Supervisor UI reads. Each group lands in the milestone that owns the behaviour behind it, so no field is a placeholder with nothing writing it (REVIEW.md: a declared record needs its writer).

| Brief §10 group | Milestone | Notes |
|---|---|---|
| §10.7 transcript marking: `author`, `supervisor {kind, ledgerId, grounds}`, `answeredBy` + `grounds` + `ledgerId`, `supervisorTouched {at, by}` | **[3]** | `kind` is `nudge` / `instruction` in [3]; `first-message` arrives with `new_session` in [5]. `by: "confirm"` arrives with confirm autonomy in [5]. |
| §10.4 watch row `supervisor`: `delegation`, `sharedCheckout`, `touchedTurn`, `waitingOnOwn`, `stoppedByUser` | **[3]** | The send refusals need these exact facts. |
| §10.4 `lastActAt` | [4] | Nothing acts before [4]. |
| §10.4 `openEscalations` | [5] | It counts inbox items. |
| §10.1 inputs: spend split own / tabs, and a `pause {reason, at, detail?}` record | **[3]** | Spend attribution and the budget pause are [3]'s. |
| §10.1 the status projection: `GET /api/supervisor` returns `{state, status}`, `status` holding every §10.1 field (`revision`, `mode`, `autonomy`, `run`, `pause`, `currentWake`, `queuedEvents`, `lastWake`, `health`, `watchedTabs`, `openEscalations`, `budget`, `charter`, `model`, `stats`, `suggestedBar`, `confirmsEligible`, `caps`) | [4] | Server-derived values (`health`, `budget.level`) are computed by rule in the runtime. `openEscalations` reads 0 until [5]. |
| §10.1 mutations `start {charter, capUsd, delegations[]}`, `resume`, `disable`, `cap`, `autonomy {category, value}`, `wakeNow`; each returns the new state with its `revision` | [4] | `pause`, `kill`, `delegate` and `charter` exist since [1]. |
| §10.3 shadow "would answer": `supervisorProposal`, `proposalRevealed`, `POST /api/supervisor/reveal` | [4] | Pairs with shadow pairing. The brief's open decision 1, blind until revealed, is adopted. |
| §10.5 ledger `pairing` and §10.1 `stats` | [4] | — |
| §10.2 the inbox, whole, with the `supervisor.inbox` feed events | [5] | — |
| §10.5 the ledger read shape (`seq`, `actor`, `sessionId`, `tabTitle`, `reason {code, text}`, `argDigest`, `argSummary`, `inboxItemId`, `hasMore`, `nextBefore`, `todayCount`; query `before`, `limit`, `sessionId`, `decision`) and the `supervisor.ledger` / `supervisor.state` feed events | [5] | — |
| §10.6 `Ground`, full: `tree`, `label`, `resolved`, `excerpt`, `openTarget` | [5] | — |
| §10.8 the `supervisor` role in `/api/models/roles` | done in [1] | — |
| §10.9 the token file | done in [1] | — |

**Where the server differs from the brief, and why:**

- **`postureSource` has no `"api"` value.** The server records `"user"` or `"supervisor"`, and both mean the posture was set through the API; no `postureSource` means the app set it. The brief's `"api"` is the server's `"user"`. Renaming stored meta for a label the app can derive was not worth a migration. `postureSetAt` is added with [4].
- **Ground kind `plan`, not `plan-step`.** The `ref` (`plan:[3]`) already names the step. Stored ledger lines since [1] say `plan`.
- **Ground `provenance` is stored as `strong` / `weak` / `unresolved`.** The [5] projection splits it into the brief's `provenance: strong | weak` plus `resolved: bool`; an unresolved ground projects as `weak`, `resolved: false`.
- **The ledger stores `tab` and `argsDigest`.** The [5] read projection names them `sessionId` and `argDigest`. Lines on disk are never rewritten (append-only). `seq` is the line's position, and `actor` derives from the line's `kind`: `verb` → supervisor, `control` → user, `wake` / `rotation` → runtime.
- **`reason {code, text}`.** Lines written from [3] onward carry a `reasonCode`. Older lines project `code: "unspecified"`.
- **`tabTitle`** is snapshotted on lines written from [5]. Older lines project `null`.
- **The inbox mutation is `POST /api/supervisor/inbox {id, actionId, edits?}`,** as the brief has it, not the separate `accept` / `override` / `dismiss` verbs [5] first named. Those become action `role`s (`consent`, `refuse`, `dismiss`, plus `edit`), and the server supplies the labels.
- **`disable` is the brief's name for today's `stop`.** [4] accepts both and documents `disable`. The `mode` action is replaced by `autonomy {category, value}`; `mode: "autonomous"` is then derived (at least one category autonomous).

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
- **Tabs:** the supervisor opens a tab only from a user-confirmed escalation, always in a fresh worktree, at no more than the confirmed posture — one request, one tab.

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
- **The UI's shapes (brief §10.7, §10.4, §10.1 inputs):**
  - the transcript's user-message line carries `author: "supervisor"` and `supervisor: {kind: "nudge" | "instruction", ledgerId, grounds}`;
  - `confirm.decision` carries `grounds` and `ledgerId` beside `answeredBy` when the supervisor answered;
  - the turn record carries `supervisorTouched: {at, by: "message" | "answer"}`, written when the mark is set;
  - each watch row carries `supervisor: {delegation, sharedCheckout, touchedTurn, waitingOnOwn, stoppedByUser}`;
  - state records spend split `{ownUsd, tabsUsd}` and `pause: {reason, at, detail?}`;
  - ledger lines added here carry a `reasonCode`.

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
- **The shapes round-trip.** Every field in this milestone's "UI's shapes" bullet is written by its writer and read back by a test: a transcript line, a `confirm.decision`, a turn record, a watch row, and a state with `pause.reason: "budget"`.

### [4] Autonomy for questions, nudges and narrowing

The first time the supervisor performs anything. Each category is switched by the user.

**Touchpoints.**

- **Per-category autonomy** in state: questions, nudges, posture.
- **Acting verbs** — `answer`, `send`, `cancel` and `set_posture` perform through the milestone 2 and 3 services when their category is autonomous. Each act marks the turn touched.
- **Shadow pairing** — each proposal is paired with the actual answer on `confirm.resolved`, by `answeredBy`.
- **`GET /api/supervisor/stats`** — agreement per category, plus the question heuristic's misses.
- **Headless questions** — `maybeAskUserQuestion` (`sdk-runner.ts:1421-1454`) lets a headless turn's question in a delegated tab wait a bounded time for the supervisor, before ADR-0040's deny.
- **New wake triggers** — turn ended (except `stopped`), and idle with an open plan and nothing of its own pending.
- **Idle tabs stay idle (added 2026-10-30, from the day's external supervision).** Tabs that had finished their scope kept starting turns on their own: advisor-condition reconciliation, scope-met checkbacks, stale background-job completions. Each cost $12–57, because each carried the whole context. The supervisor must not add to that:
  - **`scopeMetAt` on the session meta.** Written when a turn ends with the scope-met marker. Cleared when a user or supervisor-authored turn starts, because that opens new scope. A machine turn (job completion, wakeup, resume, guard) never clears it. A job completion that arrives after the scope-met close is therefore superseded by it.
  - **The turn-ended trigger fires only for a turn a user or the supervisor started.** A machine turn the supervisor did not author never wakes it. Questions still wake it through `confirm.pending`.
  - **The idle trigger skips a scope-met tab,** and fires once per plan signature. An unchanged idle tab is not woken again.
  - **`send` refuses a nudge to a scope-met tab** (`reasonCode: "scope-met"`), and any send prompted by a superseded job completion. Closing such a tab is proposed in [5].
- **The `confirm.resolved` event carries `answeredBy`** (and `ledgerId` for a supervisor answer). Pairing reads it, and [6]'s sheet dismissal shows it.
- **The UI's shapes (brief §10.1, §10.3, §10.5 `pairing`, §10.4 `lastActAt`):**
  - `GET /api/supervisor` returns `{state, status}`, with `status` the brief's §10.1 object. `health` and `budget.level` are derived by rule in the runtime, and `revision` increments on every state change;
  - the mutations `start {charter, capUsd, delegations[]}`, `resume`, `disable` (alias of `stop`), `cap`, `autonomy {category, value}` and `wakeNow`. `autonomy` covers `questions`, `nudges`, `posture` and `confirms`; `confirms` is refused until [5];
  - each `pendingConfirms[toolUseId]` on a watch row carries `supervisorProposal` and `proposalRevealed`, with `POST /api/supervisor/reveal {ledgerId}`;
  - ledger `pairing` and `status.stats` (`proposals`, `agreed`, `agreedBlind`, `agreementRate`, `humanOnlyProposedAsAct`, `heuristicMisses`);
  - `lastActAt` on the watch row's `supervisor`, and `postureSetAt` on the session meta.

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
- **Idle tabs stay idle.**
  - A turn ending with the scope-met marker writes `scopeMetAt`; a user or supervisor turn clears it; a job-completion turn does not. Round-trip test.
  - A job-completion `turn.ended` in a delegated tab produces zero wakes. A user turn's `turn.ended` produces one.
  - An idle tab with an open plan wakes the supervisor once per plan signature. A scope-met tab never does.
  - A nudge to a scope-met tab is refused with `reasonCode: "scope-met"`, in shadow and when autonomous.
- **The status is the brief's.** A route test reads every §10.1 field from `GET /api/supervisor` for an idle, a waking, a paused-by-budget and a stale fixture. A shadow proposal stays hidden on the watch row until `reveal`, and the reveal is recorded on the pairing.

### [5] The escalation inbox, the remaining verbs, and the auditor's review

**Touchpoints — the inbox.**

- **The store and its route** — an inbox store beside the ledger, and `src/app/api/supervisor/inbox/route.ts`, token required:
  - `GET ?state=open`, oldest first;
  - `POST {id, actionId, edits?}` (brief §10.2). The server lists each item's `actions` with a `role` (`consent`, `refuse`, `edit`, `dismiss`); a `consent` action performs the raw act with `actor: "user"`.
- **Items carry the brief's §10.2 shape:** `kind`, `escalatedBecause {code, label, rule?}`, `heuristic`, `rawAct` (with a `summary` built by the server from the tool and its input, never from supervisor text), `preview`, `question`, `linkedConfirm`, `recommendation`, `grounds`, `actions`, `newTab`, `postureChange`, `guardrail`, `modeAtCreation`, `state` / `resolvedBy` / `resolvedAt`, `burstRank`. Budget, breaker and refusal pauses each become a tabless `guardrail` item.
- **The ledger read shape and the feed** (brief §10.5, §10.6): the ledger route's projection, and full `Ground`s (`tree`, `label`, `resolved`, `excerpt`, `openTarget`), per "The UI's shapes" above. The `supervisor.state`, `supervisor.inbox` (added / updated / resolved) and `supervisor.ledger` events go on the project event bus. Each watch row gets `openEscalations`.
- **Items show the raw act** — tool, input, digest, and a `git merge-tree` preview for merges — with the recommendation beside it.
- **Items resolve on their own** when their underlying confirm or question resolves anywhere.
- **`POST /api/supervisor/message`** — the user's conversation with the supervisor. It cannot grant consent.

**Touchpoints — the remaining verbs.**

- **Confirms autonomy** for `answer-confirms` tabs, through the `/api/confirm` service with `answeredBy: "supervisor"`.
- **The `worktrees` verb:**
  - list and preview, live;
  - sweep, performed — exactly what `worktree_sweep` reclaims, never a `session` tree of an open tab;
  - merge, merge-all, Prepare MR and drop-with-work, escalated.
- **`close_session`**, escalated.
- **`new_session`** (ADR-0127 §4 item 7):
  - proposed only on the user's direct request (through `POST /api/supervisor/message`) or as a proposal the user approves — never from a wake on its own initiative;
  - always an inbox item showing the proposed first message, tree and posture;
  - on `accept`, the tab is created with `actor: "user"` through ADR-0122's atomic worktree path — a fresh worktree, never the shared checkout or an existing tree, no fallback on failure;
  - the new tab's posture is at most the one confirmed on the item;
  - its first turn is recorded `author: "supervisor"` and is supervisor-touched;
  - one request, one tab: a proposal carries exactly one tab; openings count against the rate limits and the spend cap.
- **The wake trigger on scope-met handoffs.**
- **Close an idle, finished tab (added 2026-10-30).** A tab whose `scopeMetAt` is set, with no live turn and nothing pending past the idle threshold, gets one inbox item proposing `close_session` with `keep`. Closing with `keep` is reversible (ADR-0111: the branch and its commits stay), so the item is a one-click consent chip, not the two-step outward path. One item per scope-met close. A user or supervisor turn that clears `scopeMetAt` supersedes the item.

**Touchpoints — the auditor and docs.**

- **`POST /api/audit`** gains a supervisor target over a ledger window (`session-auditor.ts`), with the `ungrounded` / `overreach` / `loop` / `consent` finding classes.
- **`docs/guides/supervisor.md`** (new).

**DoD.**

- **Escalations become inbox items.** Every §4 act the supervisor recommends appears as an inbox item showing the raw act, with the recommendation separate.
  - `accept` performs the act as the user and resolves the item.
  - An item whose confirm the user answered in the tab resolves on its own.
- **A tab opens only from a confirmed item.**
  - `new_session` without the user's request or approval is refused.
  - An accepted `new_session` item opens exactly one tab, in a fresh worktree, with a posture no wider than the one confirmed. An item naming the shared checkout or an existing tree is refused.
  - The new tab's first turn reads `author: "supervisor"` and is supervisor-touched.
  - A worktree creation failure answers the ADR-0122 refusal, with nothing opened.
- **Confirm autonomy respects the level.** With confirms autonomous:
  - an ordinary Edit confirm in a gated `answer-confirms` tab is answered by the supervisor;
  - the same confirm in an `answer-questions` tab is not;
  - no containment or metered-CI confirm is answered at any level.
- **A finished idle tab is offered for closing.** A scope-met tab idle past the threshold produces exactly one `close_session` item recommending `keep`, with a single consent action. Accepting it closes the tab as the user, keeping the branch. A second wake over the same scope-met close adds no item. A user message to the tab supersedes the item.
- **Worktree acts escalate, except a safe sweep.** Merges, merge-all, Prepare MR and drops of work always escalate, with a preview attached. A sweep reclaims empty or merged non-session trees and leaves an open tab's tree alone.
- **The inbox and the ledger read as the brief says.** Route tests read every §10.2 field from an item of each `kind`, and every §10.5 field from a ledger page, including one line written before [3] (`reasonCode` absent) that projects `code: "unspecified"`. A feed subscriber sees `added`, then `resolved`, for an item answered in its tab.
- **The auditor reviews without reaching the supervisor.** A supervisor-target audit produces a report over the ledger window with the four new finding classes. Nothing reaches the supervisor session; a test pins the absence.
- **Docs catch up.**
  - `docs/guides/supervisor.md` explains delegation, shadow, the human-only list, the inbox, the token and what same-user code execution can still do.
  - The documents that still state the superseded clauses describe the supervisor as shipped: `docs/concepts/single-assistant.md`, the white paper and Technical Reference, and the README bullet.

### [6] The native surface — not blocked

Built from [`docs/design/supervisor-brief.md`](../design/supervisor-brief.md), on the toolchain recipe in "Constraint that shapes the order".

**Touchpoints.**

- **A Supervisor strip in `SessionsPane`**, in the ADR-0114 vocabulary, laid out as the brief's §5–§6 describe:
  - the escalation inbox, with one-click accept or override on the raw act;
  - the ledger;
  - a per-tab delegation chip;
  - a budget meter;
  - Pause and Kill.
- **Transcript marking** for supervisor-sent messages and supervisor-given answers.
- **Required fix (added 2026-10-30): an answer from elsewhere closes the in-chat surface.** When a confirm is resolved outside the chat, the chat's `AskQuestionSheet` and its confirm card must dismiss themselves on the `confirm.resolved` feed event, and say who answered (`answeredBy`, which the event carries from [4]; the brief's `resolvedBy`). "Elsewhere" means the API, the supervisor, or the Sessions pane. Today the Sessions pane clears its row (`SessionRegistry.swift:367`), but the sheet stays open after an API answer. Robert hit this live; a stale sheet invites a second answer to a question that is already settled.
- **Posture revisions** — the app echoes `postureRevision` and adopts an API-set posture. ADR-0108's hydration rule is amended to match.
  - **Follow-up from milestone 2:** once the app shows an API-set posture, re-allow a *user's* widening through `PUT /api/sessions/posture` (refused since 2026-10-30; see "What milestone 2 changed"). A supervisor widening stays an escalation.
- **The app reads the capability token.**
- **The `supervisor` role** appears in the Models dialog's Helpers section.
- **Supervisor fixtures in the snapshot harness** (`SurfaceSnapshot.swift` / `SurfaceSnapshotFixtures`), one per brief §7 state, fed with the server shapes from "The UI's shapes".

**DoD.**

- **Built from the brief.** The strip, cards, rows, chip, log, off line, transcript marking and Helpers row follow the brief's §5–§9. Each place the build departs from the brief is recorded in the brief's §11 with the reason.
- **It builds.** `swift build -Xswiftc -DMARVIN_LEGACY_SDK` and the MARVINLogic assertions are green on the recipe's toolchain (Swift 6.4.2, 14.4 SDK, local SwiftTerm 1.20.0 pin, Metal `.copy` patch), with no change to `macos/Package.swift` made to work around the SDK.
- **Supervisor fixtures exist in the snapshot harness,** one surface per brief §7 state, populated from neutral fixture data and listed in `COVERAGE.md` as "fixture", not "empty".
- **Every §7 state was rendered and looked at.** Each state is captured at 260 and 420 pt, in light and dark, and each PNG was opened and read. Defects found are fixed, or recorded with a reason. Measured, not assumed.
- **`/impeccable critique`, then `polish`, ran on those renders.** Critique findings are fixed or recorded in the brief's §11. Polish ran on the fixed surface, and the renders were re-captured afterwards.
- **User widening is re-allowed.** `PUT /api/sessions/posture` accepts a *user's* widening again once the app shows API-set posture (the milestone 2 follow-up). A test pins it; a supervisor widening still escalates.
- **The Sessions pane is enough.** From the Sessions pane alone, the user can:
  - enable the supervisor;
  - set a tab's delegation;
  - accept and override an inbox item;
  - read the ledger;
  - see the budget;
  - pause or kill it.
- **An external answer dismisses the sheet.** With a question's sheet open (or a confirm card shown) in the chat, an answer through `POST /api/confirm/answer` closes it within one feed event. A one-line note replaces it: "Answered by the supervisor" or "Answered elsewhere by you". Answering in the sheet afterwards is impossible, not a 409. Covered by a MARVINLogic assertion on the state transition and a snapshot of the note.
- **Supervisor output looks different.** A supervisor-sent message and a supervisor-given answer render visibly differently from the user's.
- **Posture stays in sync.** A posture changed in the toolbar after an API-set one sends the new revision. The toolbar shows an API-set posture within one watch refresh.

### [7] The conversation — talk to the supervisor in its own tab (ADR-0128)

- **Decision:** [ADR-0128](../decisions/0128-the-user-talks-to-the-supervisor.md), amending ADR-0127 §2, §5 and §10. No new authority: every act still passes a `marvin-supervise` verb, the policy, the tab's delegation, its category's switch, the budget and the ledger.
- **Already in place from [5]:**
  - `POST /api/supervisor/message`;
  - `messages.jsonl`;
  - the `reply` verb;
  - `trigger: "message"`;
  - `new_session` citing a message id.

  Milestone [7] gives them a surface, a consent view and a record.
- **Each sub-milestone is a vertical slice.** It runs from the composer, or the wake that produces it, through the route, the loop, the verb, the ledger and the inbox, to what the app renders. The brief is extended before the first line of Swift ([7.1]).
- **Shape rules every slice keeps:**
  - message wakes run alone (ADR-0128 §6);
  - `origin` is assigned by the runtime, never by the model;
  - every new persisted field (`origin`, `wakeId`, `items`, `refs`, `follows.jsonl` lines, `editedByUser` on a send) ships with its writer and a round-trip test in the slice that declares it (REVIEW.md);
  - every new route or event has its `docs/reference/api.md` entry, and every new verb its `docs/reference/mcp-servers.md` entry.

#### [7.1] The channel, end to end: composer → wake → reply → the Supervisor tab

**Touchpoints.**

- **`docs/design/supervisor-brief.md` gains §12, "The Supervisor tab", first** (Impeccable `shape`, in the brief's own vocabulary). It covers:
  - placement: pinned first in the strip, shown only while the supervisor is enabled;
  - the composer and its focus rule;
  - the transcript: user bubble, supervisor reply, the collapsed line per other wake;
  - the working indicator;
  - the empty conversation;
  - VoiceOver.

  It adds no new colour, radius or component family.
- **`supervisor-loop.ts`:**
  - `noteUserMessage` calls `flush` directly (no debounce);
  - a message wake carries only `message` refs, and tab refs stay queued;
  - a running wake's exit re-flushes a queued message;
  - a message arriving mid-wake sets an `actHold` that turns the rest of that wake's `act` decisions into `escalate`;
  - `kill` and `pause` no longer lose a queued message: on resume and at boot, the loop re-enqueues every `from: "user"` message with no later reply;
  - `postReply` is wired only for a wake whose trigger is a message (and, from [7.3], a follow).
- **Ledger and messages:**
  - `origin: { kind: "message", messageIds }` on every line a message wake writes (`supervisor-ledger.ts`);
  - `SupervisorMessage` gains `wakeId` and `origin` (`supervisor-messages.ts`);
  - the reply is ledgered.
- **`supervisor-policy.ts`:**
  - the new ground kind `message:<id>#<quote>`, under the charter's quote rule;
  - strong for an `act` only when the id is one of the current wake's messages, weak otherwise;
  - accepted for 24 h as the request behind `new_session`.
- **`supervisor-prompt.ts`:**
  - the message packet: on a resumed session, the messages since the last wake, open items and the named tabs' ledger tail; on a rotated session, the last 20 messages as well;
  - the rule that a message is a request and never consent.
- **`supervisor-dispatch.ts`:** the rotation threshold becomes a token figure, initially 40 % of the window. It is measured in this milestone.
- **The event and the meter:**
  - `supervisor.message {projectId, id, from}` on the project event bus;
  - the budget meter splits own spend into watching and conversation (`status.budget`).
- **Native:**
  - a `SupervisorChatView` in the tab strip, pinned, bound to the project;
  - it posts to `POST /api/supervisor/message` with the token;
  - it renders `GET /api/supervisor/message` and re-reads on `supervisor.message`;
  - it shows `currentWake` as the working indicator;
  - it reuses the chat transcript renderer and composer, and never `ChatPreviewModel`'s `/api/chat` path;
  - the reply renders with every URL neutralised.

**DoD.**

- **One message, one reply, end to end.** A message typed in the Supervisor tab starts exactly one wake with no debounce, and that wake carries no tab items. The wake's `reply` appears in the tab after one `supervisor.message` event. Every ledger line of that wake carries `origin.messageIds = [that id]`. Integration test (route → loop → stubbed model → verb → ledger → GET), plus a MARVINLogic assertion on the reduce.
- **`reply` is refused outside a conversation.** In a wake started by a tab's question, `reply` is refused and nothing is appended to `messages.jsonl`.
- **No message is dropped.** A message queued during a wake survives Kill and is answered after resume. A message with no reply at shutdown is answered after boot. A message arriving mid-wake turns that wake's remaining `act` decisions into `escalate`.
- **The ground is scoped.** `message:<id>#<quote>` is strong in its own wake and weak in the next. A quote that is not in the message does not resolve.
- **Unchanged where it should be.** `POST /api/chat` still refuses the supervisor id. The tab is absent while the supervisor is off, and the pane's off line is unchanged. Return in the composer sends and reaches no chip.
- **It builds.** The recipe in `macos/MARVIN/SurfaceSnapshot.swift`'s header builds, and the brief's §12 exists before the Swift does.
- **The cap is measured.** Ten real conversation wakes are measured for tokens and cost, and the default cap is set from that. Both are recorded here.

**Measured 2026-10-31** (`sidecar/scripts/supervisor-measure.ts`, ten user messages through the real loop, dispatch and supervisor-role model, against this repo, one SDK session resumed until it rotated):

| Wake | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 (rotated) |
|---|---|---|---|---|---|---|---|---|---|---|
| Context at end (tokens) | 35,218 | 51,636 | 55,675 | 59,463 | 63,079 | 67,094 | 73,058 | 77,138 | 80,622 | 38,892 |
| Cost (USD) | 0.073 | 0.180 | 0.234 | 0.290 | 0.335 | 0.396 | 0.485 | 0.552 | 0.602 | 0.085 |

All ten replied, 7–14 s each, $3.23 in total ($0.32 mean) at the planned 40 % threshold.

- **The measure was wrong first.** The `result` event's usage sums every model call of a wake (97K reported for a ~35K context), so `lastInputTokens` now reads the last `assistant` call's input. Measured that way, the planned 40 % would have rotated almost every wake.
- **Rotation: 22.5 % of the window (45K on 200K), not 40 %.** A resumed wake never cost less than a fresh one past the first resume, so the session rotates just above a fresh session's context. At 45K the mean conversation wake is about $0.13 (one fresh at ~$0.08, one resumed at ~$0.18). A rotated packet carries the last 20 messages, so this costs nothing in correctness (ADR-0128 §6).
- **Default cap: $20** (was $10). Fifty messages at ~$0.13 is ~$6.50 of conversation alone, before watching and the tab turns the supervisor starts, which the same cap counts. Existing supervisors keep the cap they have.

#### [7.2] In-chat cards are inbox items

**Touchpoints.**

- **`supervisor-inbox.ts`:**
  - items gain `origin` (runtime-assigned, from the wake);
  - `reply` gains `items[]`, and the server keeps only ids whose `origin.messageIds` equals the wake's messages.
- **`supervisor-policy.ts`:**
  - in a message wake, a delegation refusal becomes `escalate` with `reasonCode: "delegation-observe"`, for a tab at `observe` or higher (`evaluateSend`, `evaluateAnswer`, `evaluateConfirm`);
  - a tab-event wake still refuses;
  - a shadow-category act in a message wake is an item, as before.
- **`sessions` lists an `off` tab** as `{id, title, delegation: "off"}` and nothing more.
- **Send items:**
  - an `edit` action in `actionsFor` (text only; same `sessionId` and kind);
  - `perform` applies the edit, re-runs `containsSecretShape` and the send refusals, and records `editedByUser` on the transcript's `supervisor {}` block and on the ledger's inbox line (`supervisor-inbox-actions.ts`).
- **Stats:** chat-origin lines are excluded from agreement rates and still counted in `humanOnlyProposedAsAct`.
- **The auditor:** a chat-origin §4 act with no settled card behind it is a `consent` finding.
- **Native:**
  - the chat renders each `items[]` id with the inbox's escalation-card component and the server's `actions`, under the reply that raised it;
  - it settles through `POST /api/supervisor/inbox`;
  - outward and destructive acts expand first (brief discovery answer 2);
  - no card takes focus;
  - an `observe` send card names the level and says the message arrives as the supervisor's.

**DoD.**

- **"Merge tab X" is a card, and only a card.** It produces exactly one integration item with its merge-tree preview, in the chat and in *Needs you*. Nothing is performed before the click. Clicking in either place performs it once as the user and resolves both (one `supervisor.inbox` `resolved` event). A second click answers `in-flight` or `settled`.
- **No text consents.** "approve it", "yes, merge", "I consent": each resolves nothing, as a table test over message wakes shows. A human-only act's ledger line is `escalate`, never `act`.
- **Cards, not refusals, in a message wake only.** A requested `send` to a shadow-category tab, and one to an `observe` tab, each become one card. The same `send` from a tab-event wake is refused. An `off` tab produces no card, and the reply names it as not delegated.
- **The send card's edit.** An edited send card delivers the edited text as `author: "supervisor"`, with `editedByUser: true` in the transcript and the ledger. An edit carrying a secret-shaped string is refused at perform time. Round-trip tests.
- **A reply cannot pull in a foreign item.** A reply listing an item from another wake, another tab's escalation or a made-up id renders none of them.
- **Stats and audit.** Agreement rates ignore chat-origin lines, and `humanOnlyProposedAsAct` counts them. A fixture with a chat-origin §4 `act` and no card yields a `consent` finding.

#### [7.3] Following and reporting

**Touchpoints.**

- **`follow` and `unfollow` verbs** over an event-sourced `follows.jsonl` beside the inbox (0600, the data dir):
  - `until: "scope-met" | "merge-ready"`;
  - a `message:` ground within the request window;
  - a per-project cap of 5, refused at the cap with the open follows listed;
  - ended by scope-met review, merge settled or dismissed, close, `unfollow`, or the user's chip.
- **`new_session` from a message follows its tab automatically.** The new-tab item gains `delegation` (default `answer-questions`, lowerable to `observe` or `off`), set by the user's accept.
- **The follow's report:** `reply {kind: "report", origin: {kind: "follow", followId}}`. It is admitted only in a wake started by one of the followed tab's existing triggers. No new wake trigger is added, and machine turns stay silent.
- **`reply.refs`:** tab, ledger-line and inbox-item ids, resolved by the server; unresolved ones are dropped, and the rest are persisted on the message.
- **The merge offer:**
  - for `until: "merge-ready"`, when `review_scope` returns `ready`, the supervisor raises the `worktrees merge` escalation with the follow's `origin`;
  - for `until: "scope-met"`, the report links the `review_scope` item and the *Ready to integrate* row.
- **Native:** `refs` render as links (tab, log line, card); a follow chip with *Stop following*; report lines.

**DoD.**

- **Open, follow, report, merge.** "Open a tab to fix X, and merge it when it's done" yields:
  1. one new-tab card;
  2. on the user's accept, one tab in a fresh worktree at the confirmed posture and delegation, followed `until: "merge-ready"`;
  3. at its scope-met handoff, a report in the chat;
  4. when `review_scope` returns `ready`, one integration card in the chat.

  Nothing merges before the click. Integration test across the route, loop, verbs, inbox and messages, with a stubbed model.
- **Follow bounds.** A machine turn in a followed tab produces no wake and no report. A sixth follow is refused with the five listed. `unfollow` stops reports.
- **`refs` resolve or vanish.** Unknown ids are dropped, and the persisted message round-trips `refs` and `items`.

#### [7.4] Finish the native surface

**Touchpoints.**

- **Snapshot fixtures** in `SurfaceSnapshot.swift` / `SurfaceSnapshotFixtures`, one per brief §12 state:
  - an empty conversation;
  - a message sending;
  - a wake working;
  - a reply with a reversible card;
  - a reply with an outward card, collapsed and expanded;
  - a settled card ("Done — you merged …");
  - a card settled elsewhere;
  - an `observe` send card;
  - a report with refs;
  - an open follow;
  - the budget guardrail inline;
  - the cap reached mid-conversation.
- **`/impeccable critique`, then `polish`,** on the renders.
- **Docs:**
  - `docs/guides/supervisor.md` gains "Talking to the supervisor" (consent is a click; the chat card is the inbox item; follow; what is never consent);
  - `docs/reference/api.md`;
  - `docs/reference/mcp-servers.md`;
  - the README feature line.

**DoD.**

- **Every state was rendered and looked at.** Each brief §12 state is captured at 260 and 420 pt, light and dark, and each PNG was opened and read. Fixtures are listed in `COVERAGE.md` as "fixture". Defects are fixed or recorded in the brief's §11.
- **Critique, then polish.** Critique findings are fixed or recorded with a reason; polish ran afterwards, and the renders were re-captured.
- **VoiceOver.** A card in the chat is the same combined accessibility element as in *Needs you*, with the same custom actions, pinned by the existing `accessibilityActionNames` test. The supervisor's reply is never announced as "you".
- **The guide explains consent in one paragraph,** with the anti-goals intact: no "Approve all", and no Return on a consent chip.

**What [7.4] changed (2026-10-31).**

- **Fixtures.** `SurfaceSnapshotSupervisor.chatStates` holds one fixture per state in the list above, plus the couldn't-answer state and the send card's Edit… sheet; the report-with-refs and the open-follow states, one fixture in [7.3], are now two. `COVERAGE.md` labels in-process fixtures `fixture` (it said `populated` for both kinds).
- **Rendered and read.** All `sup-*` surfaces at 260 and 420 pt, light and dark (38 surfaces, 148 PNGs; the 15 Supervisor-tab surfaces are 58 of them). Every Supervisor-tab PNG was opened; the Sessions-pane ones were spot-checked, since the shared card changed.
- **Built where the renders showed a gap:** the budget `guardrail` inline at the foot of the conversation (ADR-0128 §7 — it was not drawn); a sending bubble at once (§12.6 — it appeared only after the route answered); *Resume* under the paused notice (§12.4); a new-tab or guardrail item in the chat drawn by its own component, not as an escalation card.
- **Critique 31/40, then polish.** Findings fixed or recorded in the brief's §11, departures 14–22. The backlog item for the composer's opaque block and the hyphenated gutter label is resolved.
- **VoiceOver.** A chat card is `SupervisorItemCard`, the same component, combined element and custom actions as in *Needs you* (`SupervisorActChips.accessibilityActionNames`, pinned). The labels moved to `SupervisorChat.accessibilityLabel`, and a test pins that a supervisor line starts "Supervisor", never "You".

## Not in this plan

- **New authority.** Each of these would need a new ADR:
  - any write capability for the supervisor;
  - any task decomposition across tabs — one request stays one tab;
  - a supervisor that opens tabs on its own initiative, in the shared checkout, or without the user confirming the brief, tree and posture. Opening a tab through a confirmed escalation is in milestone 5 (ADR-0127 §4 item 7).
- **Whole-API authentication.** Authenticating the app's own loopback routes is out of scope. The capability token covers only supervisor-authority routes (ADR-0127 §5).
- **OS-level isolation** from code a tab executes. Same-user code execution is out of scope (ADR-0127 §5).
- **Automatic graduation** from shadow to autonomy.

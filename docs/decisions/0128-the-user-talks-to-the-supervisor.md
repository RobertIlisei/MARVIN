# ADR-0128 — The user talks to the supervisor in its own tab, and every act the conversation leads to is a card the user clicks

- **Status:** Accepted — 2026-10-31 (decision, Phase A). Implementation follows [`docs/plans/supervisor.md`](../plans/supervisor.md) milestone [7]; nothing in this ADR is shipped yet.
- **Date:** 2026-10-31
- **Reviewed:** 2026-10-31 by the advisor, read cold (go-with-caveats). Its caveats are folded in:
  - `message:` grounds are scoped to their own wake and quoted (§2);
  - message wakes run alone (§6);
  - `reply` is admitted only in a message or follow wake (§5);
  - no queued user message is ever dropped (§6);
  - delegation refusals become cards only in a message wake (§4);
  - one off-state surface (§1);
  - URL neutralisation and composer focus (§1, §3);
  - `follow` is defined (§5);
  - the budget effect is stated (§7).
- **Amends:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md):
  - §2, "The user talks to it through its own route". That route becomes a tab.
  - §5, "Consent is given where the act is". The place can now be the conversation, and the object there is still the inbox item.
  - §10, the surface. A Supervisor tab is added beside the Sessions-pane strip.
- **Adds no authority to ADR-0127.** Every act still goes through a `marvin-supervise` verb, the policy, the delegation level, the per-category switch, the budget and the ledger. The conversation is a new **input channel** with an in-chat view of the inbox. It is not a new permission.
- **Related:**
  - [ADR-0112](./0112-one-place-for-each-thing.md): one place for each thing. An in-chat card is the inbox item, not a copy of it (§3).
  - [ADR-0069](./0069-never-drop-a-user-message.md): a user message is never dropped.
  - [ADR-0040](./0040-interactive-ask-user-question.md), [ADR-0102](./0102-multiple-sessions-one-worktree.md), [ADR-0109](./0109-batch-integration-and-metered-ci.md), [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md), [ADR-0116](./0116-the-spine-has-two-writers.md), [ADR-0122](./0122-a-tab-gets-its-worktree-or-is-refused.md).
  - The design brief: [`docs/design/supervisor-brief.md`](../design/supervisor-brief.md). Discovery answers 1 ("Needs you is the inbox") and 2 ("Outward acts expand first") bind this ADR.

## Context

### What Robert does today

Robert runs an external Claude Code session in his terminal as the **lead** over his MARVIN tabs. He tells it what he wants in plain words. It then does the rest:

- opens tabs with briefs;
- sends them instructions and answers their questions;
- follows each tab to its scope-met handoff and reviews the result;
- merges, and reports back.

The in-app supervisor (ADR-0127, milestones [1]–[6], shipped in v0.1.119) is the **watcher half** of that lead. It is woken by events. It answers grounded questions, nudges, escalates and keeps a ledger. Robert wants the **conversational half** as well, inside MARVIN's gates instead of outside them.

### What already exists, and what is missing

Milestone [5] shipped a conversation channel with no surface:

- `POST /api/supervisor/message` appends the user's message to `<MARVIN_DATA_DIR>/supervisor/<projectId>/messages.jsonl` and wakes the supervisor (`supervisor/message/route.ts:37-62`, `supervisor-messages.ts:60-62`).
- The loop enqueues it as `trigger: "message"` (`supervisor-loop.ts:197-205`). The packet carries the message text (`supervisor-prompt.ts:80-81, 110-116`).
- The `reply` verb appends the supervisor's answer (`supervisor-mcp.ts:1110-1118`).
- `new_session` accepts only a user message as its request, cited by id (`supervisor-messages.ts:68-71`; inbox `requestedBy`, `supervisor-inbox.ts:81`).
- The prompt already says that a message asking for approval is not consent (`supervisor-prompt.ts:50-52`).

What is missing:

1. **No one can talk to it in the app.** Only a client holding the token, such as Robert's external mod, can post a message. The brief's new-tab card links "Asked for by: your message" into a conversation the app has no view for (brief §6.3).
2. **A reply is text only.** An escalation raised while answering a message lands in *Needs you*, with nothing in the conversation pointing at it. The user who asked "merge tab X" has to go and find the card.
3. **A message waits like a tab event.** It goes through the 5 s debounce and is coalesced with tab events (plan [1], "Debounce").
4. **Nothing follows a tab on the user's behalf.** "Tell me when X is done" has no record. The supervisor would need to remember it.
5. **Chat-initiated acts are indistinguishable** in the ledger and in the shadow stats.

### Precedent

- **Claude Code agent teams** (code.claude.com/docs/en/agent-teams) have one **team lead** that you "tell what you want in natural language. It handles team coordination, task assignment, and delegation." You "can also talk to any teammate directly."
  - On consent: "Teammate permission prompts appear in the lead session, so approve them there yourself", and "a teammate can't approve a permission prompt or supply consent on your behalf."
  - On operation: the lead is there to "monitor and steer". Token cost scales with the number of agents. Sequential or same-file work is better done in a single session.
- **"Building effective agents"** (anthropic.com/engineering), orchestrator–workers: "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results". The post pairs this with human checkpoints and stopping conditions.

This ADR takes the lead's **conversation and consent surface**. Approvals surface where the user is talking, and nobody but the user approves. It does **not** take the lead's task decomposition (§8). ADR-0127 §1 still holds: one request, one tab, and no task split across tabs.

## Decision

**Each project gets one pinned Supervisor tab where the user talks to the supervisor. Its turns are the same runtime-dispatched, read-only supervisor wakes as ADR-0127's. The user's words there are recorded as the user's and may ground a request, but no text is ever consent. Every act the conversation leads to that the supervisor may not perform on its own appears in the chat as a card. The card is the inbox item itself, and the user's click on its raw act is the consent.**

### 1. The Supervisor tab

- **One per project, pinned.** It is the first tab in the strip and is bound to the project's supervisor session.
  - It cannot be opened twice, and it is never a worktree tab. It has no branch chip and no posture toolbar. The supervisor's model is the `supervisor` role's (ADR-0126); its permissions are ADR-0127 §2's and are not a posture.
  - Closing the tab hides it. It does not stop the supervisor; Pause and Kill do that.
- **It talks to the supervisor routes, not `/api/chat`.**
  - The composer posts to `POST /api/supervisor/message` with the capability token, as the app already does for the other supervisor routes (plan [6]).
  - `POST /api/chat` keeps refusing a supervisor session id (ADR-0127 §2). The tab reuses the chat transcript's renderer and composer. It does not reuse a tab's turn path or a tab's tools.
- **What the transcript shows.**
  - **The conversation itself:** the user's messages and the supervisor's replies, with their cards (§3).
  - **Every other wake, as one collapsed line:** "Woke for 3 items: answered a question in *fix-flags*, escalated a merge." Each line links to its entries in the Supervisor log.
  - It does not show the supervisor's raw tool calls. Those are in the log.
- **No tab while the supervisor is off.** The Sessions pane's off line (brief §6.7, discovery answer 4) stays the one place to start it. The Supervisor tab appears when the supervisor is enabled, and goes when it is disabled. It never carries a second *Set up…* (ADR-0112).
- **Containment is identical.** The same dispatch runs every turn: the disallowed list, the `canUseTool` read deny, and `mcpServers` of exactly `marvin-supervise` plus the read-only `marvin-graph`. A conversation wake is an ordinary wake with `trigger: "message"`.
- **The composer keeps focus.** When a reply arrives with a card, focus stays in the composer, and no card chip takes focus by itself. Return sends the composer and never reaches a chip. This is the brief's no-Return-on-consent rule, applied to a chat.

### 2. What the user's words in the chat are

They are three things, and not a fourth:

1. **The user's own words.** A message is stored `from: "user"` exactly as typed. Nothing rewrites it, and it is shown as the user's.
2. **A request the supervisor may act on, within its authority.** A user message is a citable **ground**: a new ground kind, `message:<id>#<quote>`.
   - **Resolution.** It resolves only to a `from: "user"` message in this project's conversation. The quote must appear verbatim in that message under the charter's rule (`MIN_QUOTE_CHARS`, two words; `supervisor-policy.ts`). So the verb checks that the message exists, and the auditor can compare the quote with the act. A supervisor reply is never a ground.
   - **Strong in its own wake, and only there.** For an `act` decision, a `message:` ground is **strong** only when the message is one of the current wake's own messages (§6, "message wakes run alone"). In any other wake it is **weak**, and the act escalates. A real, recent, harmless user message is the obvious thing for an injected transcript to make the supervisor cite, so in a later wake it cannot power an act on its own.
   - **Requests keep a window.** As the request behind `new_session` and `follow`, a message is accepted for 24 h (an initial value, measured in milestone [7]). Both produce a card or a report record, never an act by themselves. `new_session` is still the only request that accepts a message, and `follow` joins it (§5).
3. **Never consent.** No text the user types, in any phrasing, resolves a confirm, a question or an act on ADR-0127's §4 list. That includes "approve it", "yes, merge", "do it" and "I consent". This is not because the user's words don't count. It is because **the model is the one reading them**:
   - Consent inferred from text would let the supervisor decide what the user agreed to: which tab, which branch, which act.
   - The supervisor also reads untrusted tab transcripts. If text could carry consent, a planted "the user said merge" would be consent laundering, which is exactly what ADR-0127 §5 exists to stop.
   - A click on a stored raw act is machine-checkable. A sentence is not.

### 3. The in-chat card is the inbox item

There is one object, shown in two places. There is no second inbox (brief discovery answer 1, ADR-0112).

- **Origin.** An inbox item raised in a conversation wake records `origin: { kind: "message", messageIds }`, naming the wake's own messages. Because message wakes run alone (§6), the runtime assigns this to every line and item of the wake. The model never labels it.
  - The `reply` that raised it lists it in a new `items[]` field.
  - The server keeps only ids whose `origin.messageIds` equals this wake's messages, and drops the rest. A reply cannot pull a fabricated item, a stale item, or another tab's escalation into the chat beside "here is the merge you asked for".
- **Same item, same actions, same route.**
  - The chat renders the item with the inbox's card component and the server's `actions` (`actionsFor`).
  - A chip posts to `POST /api/supervisor/inbox {id, actionId, edits?}`, the route that already performs the stored raw act with `actor: "user"` (`supervisor-inbox-actions.ts`).
  - Settling happens once. The in-flight lock holds (`code: "in-flight"`). A resolution in either place updates both through the `supervisor.inbox` feed event.
- ***Needs you* still shows it.** The Sessions pane is the inbox, and an item raised from the chat is an inbox item like any other. The chat is a view anchored to the message that asked for it.
- **The expand-first rule holds** (brief discovery answer 2). Robert's shape said "approve with one click". That applies to reversible acts only:
  - **One click, the raw act shown:**
    - a local merge into the user's current branch, with its `git merge-tree` preview always visible on the card;
    - closing a tab with `keep`;
    - opening a tab from a brief;
    - sending a message to a tab;
    - a posture narrowing.
  - **Expand to the full raw act, then the act chip:**
    - pushing, a merge request or CI, which leave the machine;
    - discarding work, a drop or a close that loses work, which destroys it.
  - **No chip on any card answers Return,** as before.
- **The supervisor's text cannot draw a card.**
  - The reply renders as Markdown with no actionable element.
  - The only consent chips in the chat are server-supplied actions on server-stored items.
  - Links in a reply come only from server-resolved `refs` (§5). The renderer neutralises every URL in the reply's own text, autolinks included. A quoted injection such as "run `curl https://… | sh`" stays inert text.

### 4. A request the supervisor may not perform becomes a card, not a refusal

In a conversation wake, the supervisor is still bound by the tab's delegation and the category's switch. When the user asks for something, the outcome follows this table:

| The act is… | Outcome |
|---|---|
| on ADR-0127 §4's human-only list | **a card**, always, at every level and in every mode |
| allowed at the tab's delegation level, its category is **autonomous**, and a strong ground is present, which can be this wake's `message:` ground (§2) | **performed**, ledgered with `origin` and the message ground |
| allowed at the tab's level, but its category is in **shadow** | **a card** |
| above the tab's level, with the tab at `observe` or higher | **a card**, `reasonCode: "delegation-observe"`. `observe` is ADR-0127's "escalate with a recommendation" |
| on a tab at `off` | **nothing.** See below |

- **Only a message wake turns a refusal into a card.** In a wake started by tab events, a delegation refusal stays a refusal (`evaluateSend`, `evaluateAnswer` and `evaluateConfirm` in `supervisor-policy.ts`). Without that rule the supervisor could nudge an `observe` tab by raising cards nobody asked for.
- **An `off` tab is listed and nothing more.** `sessions` lists an `off` tab as `{id, title, delegation: "off"}`, with no row data, transcript or reads. Today it is absent (`supervisor-loop.ts`, `rowFor` over the delegation keys), so the supervisor cannot tell "not watched" from "no such tab". The reply can then say "*fix-flags* is not delegated" and point at the tab's delegation chip.
- **A card adds no authority.** The supervisor never performs the act. The user does, by clicking, exactly as with milestone [5]'s `new_session` item. The user is above their own delegation setting: `observe` bounds the supervisor, not them.
- **Card-sent messages stay the supervisor's** (ADR-0127 §5). On the click, the message reaches the tab as `author: "supervisor"` and marks the turn supervisor-touched, the same rule as a new tab's first message. A send card says this, and it names the tab's delegation level when that is `observe`. Relaying the user's own words *as the user's* was considered and rejected (Alternatives).
- **A send card can be edited, within limits.**
  - **What can change.** The **text** only. Never the tab (`sessionId`) or the kind.
  - **Checks at perform time.** `containsSecretShape` and the send refusals run again then: a stopped tab, a scope-met tab, a tab waiting on its own work, a shared checkout in use.
  - **The record.** The transcript's `supervisor {}` block and the inbox's ledger line record `editedByUser: true`, as `new-tab` items already do.
  - **What the server adds.** An `edit` action for `send` items in `actionsFor`. Today `perform` ignores `edits` for a send (`supervisor-inbox-actions.ts`).
  - **The §4 question heuristic** does not need to run on the edited text. The turn is touched, so any act it leads to meets the user-only gate.
- **Shadow stays a measurement.** Ledger lines with a conversation `origin` are excluded from the shadow **agreement** stats: the user asked for those acts, so they are not proposals paired with an independent user answer. They still count in `humanOnlyProposedAsAct`, which is a safety signal, not an agreement rate. They also appear in the log and in the auditor's window.

### 5. The conversation's verbs

`new_session`, `review_scope`, `worktrees` and `close_session` are unchanged. Their items render in the chat when the conversation raised them. Three additions:

- **`follow {sessionId, until: "scope-met" | "merge-ready", grounds}` and `unfollow {sessionId}`.** These are a runtime-held record of "tell me how X goes".
  - **Where it lives.** An append-only, event-sourced `follows.jsonl` beside the inbox: 0600, under the data dir, and the newest line per id is the follow. It follows the inbox's discipline, not `state.json`'s. It is never in the project's `.marvin/`.
  - **Request.** A follow needs a `message:` ground. The window is the request window in §2.
  - **A tab opened from the conversation.** It is followed automatically, citing the message that asked for it.
    - **Delegation.** The new-tab card shows the delegation the tab will receive and lets the user lower it: `answer-questions` by default (ADR-0127 §3's default for a delegated tab), or `observe`, or `off`. Accepting the card sets it, as the user's act through the token-gated inbox route.
  - **What it adds.** On the triggers ADR-0127 and plan [4] already have, the supervisor also reports into the conversation. Those triggers are a turn ended (by a user or the supervisor), a scope-met handoff, an escalation on the tab, and the tab being closed.
    - **No new wake trigger.** A machine turn still never wakes the supervisor ("idle tabs stay idle", plan [4]).
    - **No raised delegation.** Following an `observe` tab reports on it and acts on nothing.
  - **How it ends.** At the scope-met review (for `until: "scope-met"`), when the merge is settled or dismissed (for `until: "merge-ready"`), at the tab's close, on `unfollow`, or on the user's click on the follow's chip.
  - **The cap.** Open follows are capped per project, initially 5. At the cap, `follow` is refused, and the reply says so and lists the open follows with their *Stop following* chips. No follow is evicted silently.
- **`reply {text, items?, refs?}`.**
  - **When it is allowed.** Only in a wake whose trigger is a user `message`, or a followed tab's trigger. Any other wake has no one to talk to, and `reply` is refused there.
    - Today the "no conversation is open" branch in `reply` is dead in production (`supervisor-mcp.ts`, `reply`), because `defaultVerbDeps` wires `postReply` for every wake (`supervisor-loop.ts`). So an untrusted transcript in a tab-event wake could speak in the Supervisor tab with the supervisor's voice. Milestone [7.1] makes `postReply` conditional on the trigger.
  - **A follow's report.** It is the one reply with no user message before it. It is typed `kind: "report"` with `origin: { kind: "follow", followId }`.
  - **`items`.** The inbox items this wake raised for its own messages or follow (§3).
  - **`refs`.** Tab, ledger-line and inbox-item ids the reply mentions. The server resolves each one, drops any it cannot, and the app renders the survivors as links.
  - **What is stored.** The `SupervisorMessage` record persists `wakeId`, `origin`, `items` and `refs`, and the reply is ledgered with them.
  - **Reports on request.** A report is `sessions` and `read`, then a `reply` with `refs`. It adds no read authority. An `off` tab shows only its title and level (§4).
- **The merge offer, only when it was asked for.** "Tell me when X is done" is not "offer me the merge".
  - **`until: "scope-met"`.** The report links to the existing `review_scope` ready item and to the tab's *Ready to integrate* row.
  - **`until: "merge-ready"`** — the user asked for the merge, as in "merge it when it's done". When `review_scope` finds the scope met and verified, the supervisor raises the `worktrees merge` escalation with the follow's `origin`. The integration item renders in the chat with the target branch, the merge-tree preview and one consent chip.
  - **Either way, merging stays human-only** (ADR-0127 §4 item 1). The card is how the human's click reaches it from the conversation.

### 6. The turn runtime for the conversation

- **Same session, dispatch, containment and budget** as every wake (ADR-0127 §2).
- **Message wakes run alone.** A wake started by a user message carries the conversation only. Tab items stay queued for the next wake.
  - This is what makes `origin` deterministic. Within one SDK turn the runtime cannot tell which act was "for the message" and which was for a coalesced tab item, so a coalesced wake would either let the model label origin or stamp a tab's push escalation as chat-origin.
  - The cost is one extra wake when both are pending.
- **A user message wakes at once.**
  - It calls `flush` directly, skipping the 5 s debounce.
  - If a wake is already running, the message waits for the next wake. The running wake's exit path flushes it, also without the debounce.
  - Messages that arrive during a wake share the next wake's packet, so coalescing bounds a fast typist. No user message is refused for rate.
- **A message arriving mid-wake holds that wake's acts.** The newest human word wins (ADR-0069's spirit) without aborting anything.
  - The running wake may keep reading and escalating.
  - From then on, every `act` decision in it becomes `escalate`, through the existing `actHold`, as pause and budget already do.
- **No user message is ever dropped.**
  - Kill clears the loop's in-memory queue today (`supervisor-loop.ts`, `kill`), and pause holds it in memory, where a restart loses it. The message would survive in `messages.jsonl` with nothing ever answering it, which is ADR-0069's failure.
  - So on resume, and at boot, the loop re-enqueues every `from: "user"` message that has no later reply in the same conversation.
- **The conversation's continuity comes from records, not from the SDK session's memory.**
  - **On a resumed session**, a conversation wake's packet carries:
    - the messages since the last wake;
    - the conversation's open items and open follows;
    - the ledger tail for the tabs it names.
  - **On a rotated session**, the packet also carries the last 20 conversation messages.
  - This keeps ADR-0127 §2's rule that correctness never depends on what the supervisor remembers, and it makes rotation lossless for the chat.
  - **Disagreement with "fresh supervisor context per wake":** within the cache TTL a fresh session with the same system prompt still hits the prompt cache. The real saving of resuming is the tool results the session has already read. A conversation sends several messages a minute, so the session resumes within a conversation and rotates on ADR-0127's rule, tightened to a token threshold milestone [7.1] measures. Because the packet is self-sufficient on rotation, rotating more often costs money, not correctness.
- **Feed.** `supervisor.message {projectId, id, from}` goes on the project event bus, ids only, as with the other supervisor events. The app re-reads the conversation through the token-gated `GET`. `currentWake` drives the tab's working indicator.

### 7. Guardrails

- **One conversation per project.** `messages.jsonl` is per project, and the strip holds one Supervisor tab.
- **No recursion.**
  - The conversation cannot target the supervisor session.
  - `follow`, `send` and `new_session` refuse a supervisor id.
  - `new_session` cannot open a supervisor.
  - A tab cannot post to `/api/supervisor/message`: the ADR-0127 §5 control-route deny and the token both stand in the way.
- **Rate limits and the budget apply to everything the conversation starts.**
  - Chat-initiated acts pass the same per-tab and project-wide limits and the per-wake breaker as any act.
  - Conversation wakes count against the same daily cap. The budget meter splits the supervisor's own spend into *watching* and *conversation*. There is still one cap, so one number stops everything.
  - At the cap, the chat shows the budget `guardrail` item inline with its *Raise cap* chip.
  - **The default cap is expected to rise.** A conversation wake with its packet is plausibly 10–20k input tokens on the Sonnet-tier role, and the cap also counts the tab turns the supervisor starts, so a chatty afternoon can reach $10. Milestone [7.1] measures real conversation wakes and sets the default from the measurement, not from this estimate.
- **The ledger names the message.** Every line a conversation wake writes carries `origin: { kind: "message", messageIds }`: proposals, acts, refusals, escalations, follows and replies with their item lists. A follow's report carries `origin: { kind: "follow", followId }`.
  - The auditor gains one check on it: a chat-origin act on the §4 list with no settled card behind it is a `consent` finding.
- **Secrets are scanned in both directions,** as today: the message route and the reply verb. An edited send card is scanned again (§4).
- **Untrusted content stays data.** Replies can quote tab content. They render without actionable elements and with URLs neutralised (§3), and the packet still wraps tab content as untrusted.

### 8. What does not change

- the charter;
- per-tab delegation;
- off, then shadow, then autonomy per category, by the user's switch;
- the human-only list and the supervisor-touched gate;
- the capability token and the control-route deny;
- the ledger's discipline and location;
- the auditor's independence (its report goes to the user, never to the supervisor);
- one request, one tab;
- no task decomposition across tabs.

The external Claude Code session can keep working through the routes with the token, under the same policy and ledger.

## Consequences

- **Positive.**
  - The lead Robert runs in his terminal moves inside MARVIN, its acts reach the ledger, and its approvals surface where he is talking.
  - "Merge tab X" ends in the card for exactly that merge, with its preview, and a click. Nobody has to hunt in *Needs you*.
  - Shadow becomes usable from the chat. The user can try the supervisor before trusting it, because every act it may not perform is a card.
  - Follow-ups become a record instead of something the supervisor must remember.
- **Negative / trade-offs.**
  - **Cost.** Conversation wakes are user-driven and frequent. They are bounded by the cap, coalescing and the rotation rule. The default cap is expected to rise (§7). Agent teams' warning that tokens scale with agents applies.
  - **Two views of one item.** The chat and *Needs you* both show it. Settle-once and the feed keep them consistent, and a bug there would show a stale card. Milestone [5]'s in-flight lock is what stops a double perform.
  - **A strong ground the user did not mean.** A casual "sure" can still ground a non-human-only act in the wake it triggered. The quote rule, its confinement to one wake and the auditor bound this. In any later wake it is weak, and human-only acts never rest on it.
  - **One extra wake** when a message and tab items are both pending, because message wakes run alone.
  - **Excluding chat-origin lines** makes the shadow stats slower to accumulate.
- **Follow-ups created.**
  - Milestone [7] in `docs/plans/supervisor.md`.
  - The brief gains the chat surface before any Swift is written.

## Alternatives considered

- **Consent inferred from the user's text** ("merge it" performs the merge). Rejected (§2). The model would decide what was agreed, and a planted sentence in a transcript would launder consent.
- **A separate inbox in the chat.** Rejected: two inboxes for one decision violates ADR-0112 and the brief's discovery answer 1. The chat is a view of the item.
- **Relay the user's words into a tab as the user's** ("Send as me"). Rejected. The supervisor chooses what to relay and where, and a user-authored message in a tab carries the user's standing there: plan approval, scope. Messages into tabs stay the supervisor's (ADR-0127 §5). A user who wants to speak as themselves types in the tab.
- **Run the Supervisor tab as an ordinary chat tab through `/api/chat`.** Rejected. It would give the supervisor a tab's tools and gates, and ADR-0127 §2 deliberately refuses that.
- **A fresh SDK session per wake.** Rejected on cost for a conversation (§6). Correctness already does not depend on session memory.
- **Refuse what the supervisor may not perform.** Rejected. It makes the chat useless in shadow and at `observe`, and the user would turn to the external session again. A card adds no authority, because the user performs the act.
- **Coalesce message wakes with tab events.** Rejected: `origin` could then be assigned only by the model, or wrongly to every line of the wake (§6).
- **Rate-limit user messages by refusing them.** Rejected: that refuses a human message. Coalescing messages into the next wake bounds a fast typist without one (§6).
- **A `message:` ground strong for a fixed window in any wake.** Rejected: an injected transcript could make the supervisor cite a real, harmless, recent message for an act it never asked for (§2).
- **A lead that decomposes a request into several tabs.** Rejected again, for ADR-0127 §1's measured reasons. Agent teams' own guidance agrees for sequential or same-file work.

## Scope of Done

- [x] **Phase A:**
  - this ADR;
  - an amendment note on ADR-0127;
  - Golden Rule 1 and the firm-surfaces row in `AGENTS.md` say the same thing;
  - milestone [7] is in `docs/plans/supervisor.md`;
  - `personality-surfaces.test.ts` passes.
- [ ] **The channel.** A message posted in the Supervisor tab wakes the supervisor without the debounce. That wake carries no tab items. It produces a `reply` in the tab, and every ledger line of the wake carries the message's `origin`. `reply` is refused in a tab-event wake. A message queued when Kill is pressed is answered after resume, and a message queued at a restart is answered after boot. `POST /api/chat` still refuses the supervisor id. *(Milestone [7.1].)*
- [x] **Consent is a click.** A message asking for a human-only act ("merge tab X") produces exactly one inbox item, shown in the chat and in *Needs you*. Nothing is performed until its consent chip is clicked. A click in either place settles both. No message text resolves any confirm or act. *(Milestone [7.2].)*
- [x] **Cards, not refusals.** In a message wake, a requested `send` becomes a card when its category is in shadow or the act is above the tab's delegation. It sends as `author: "supervisor"`, with `editedByUser` when edited, only on the user's click. The same act in a tab-event wake is refused. An `off` tab gets nothing. A `message:` ground cited in a later wake is weak. *(Milestone [7.2].)*
- [x] **Follow and report.** A tab opened from the chat is followed, and its scope-met review is reported in the chat. A merge card appears only for `until: "merge-ready"`. `refs` and `items` the server cannot resolve to this wake are dropped. *(Milestone [7.3].)*
- [x] **The native tab** is built from the extended brief and rendered in every brief state at 260 and 420 pt, light and dark, and critique and polish ran on it. *(Milestone [7.1] builds it; milestone [7.4] finishes it.)*

## Amendment — 2026-10-31: placement only, the conversation moves into the Supervisor workspace

The user asked for the supervisor as one workspace, opened from the activity rail and using the centre of the window ([brief §13](../design/supervisor-brief.md)). This amendment changes **where** the conversation is drawn and nothing else: the channel, the routes, the verbs, the consent rule (no text is consent, the card is the inbox item, Return never reaches a chip), the containment and the guardrails are unchanged. The advisor reviewed the layout (go-with-caveats; brief §13.13).

Clauses moved or removed:

- **§1 "One per project, pinned … the first tab in the strip"** → the conversation is the centre of the Supervisor workspace (the editor slot, above the preview), opened by the rail's binoculars button or *Supervisor: Show Workspace* (⌃⌥⌘S). It is still one per project and still never a worktree tab.
- **§1 "Closing the tab hides it"** → closing the workspace hides it; it stays mounted, so the draft and the scroll position survive. Pause and Kill still stop the supervisor.
- **§1 "No tab while the supervisor is off; the off line is the one place to start it"** → while off, the rail button and the pane's off line both open the workspace on its set-up form. That form is the one set-up surface (ADR-0112), replacing the set-up sheet; it has no default button.
- **Brief §12.1 "the strip's first stop for VoiceOver"** → the rail button and the registry command.
- **Brief §12.1 "disabled while selected falls back to the last chat tab"** → disabling the supervisor closes the workspace.
- **Code retired:** `SupervisorModel.chatSelected` (now `workspaceOpen`), the pinned tab in `ChatPreviewView.sessionTabs`, and `supervisorChatOverlay`. The overlay *mechanism* is reused: the workspace's inspector covers the still-mounted chat column the same way.
- **The [7.4] fixtures' 260 / 420 pt chat columns** → the workspace composites at 960 / 1440 / 1920 pt windows (`sup-ws-*`); the chat-column fixtures stay as component renders.


## Related

- ADR-0127 and its plan, milestones [1]–[6].
- Code already in place:
  - `sidecar/packages/runtime/src/supervisor-messages.ts`;
  - `sidecar/src/app/api/supervisor/message/route.ts`;
  - `supervisor-loop.ts` (`noteUserMessage`);
  - `supervisor-mcp.ts` (`reply`, `new_session`);
  - `supervisor-inbox.ts` / `supervisor-inbox-actions.ts` (items, `actionsFor`, consent);
  - `supervisor-prompt.ts` (the message packet).
- Research:
  - code.claude.com/docs/en/agent-teams (the lead, talking to teammates, permission prompts in the lead, consent);
  - anthropic.com/engineering "Building effective agents" (orchestrator–workers, human checkpoints, stopping conditions).

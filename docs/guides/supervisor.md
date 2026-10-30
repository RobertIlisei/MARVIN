# The supervisor

The supervisor is a MARVIN session that watches the other tabs of one project for you. It answers a tab's questions when the answer is already decided, nudges a tab that stalled inside its approved plan, narrows a tab's posture, and answers ordinary permission cards. Everything else, it brings to you. It never stands in for your consent.

The decision behind it is [ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md). The build plan is [`docs/plans/supervisor.md`](../plans/supervisor.md).

> **Status.** The engine, the routes and the verbs are built (milestones 1–5). The native Sessions-pane surface is milestone 6. Until it ships, you drive the supervisor through its routes, for example from a Claude Code session in your terminal.

## Starting it

The supervisor ships **off**. You start it per project, and it starts in **shadow**:

```bash
TOKEN=$(cat ~/.marvin/supervisor/token)
curl -s -X POST localhost:3030/api/supervisor \
  -H "x-marvin-client: 1" -H "x-marvin-supervisor-token: $TOKEN" -H "content-type: application/json" \
  -d '{"projectId":"<id>","action":"start","charter":"What I want from this project…","capUsd":10,
       "delegations":[{"sessionId":"<tab>","level":"answer-questions"}]}'
```

- The **charter** is your stated goals. It is the strongest ground the supervisor can cite.
- The **cap** is a daily spend limit. It counts the supervisor's own turns *and* the tab turns it starts. At the cap it pauses and asks you.
- **Pause** stops it waking. **Kill** also aborts the wake in flight. Both work at any time.

## Delegation, per tab

You decide how much each tab is the supervisor's business:

| Level | What it may do |
|---|---|
| `off` | Nothing. The tab is not watched. |
| `observe` | Read, summarise, and escalate with a recommendation. It never acts on the tab. |
| `answer-questions` | Also: answer grounded questions, send nudges inside the approved plan, cancel a runaway turn it or a machine started, narrow the posture. |
| `answer-confirms` | Also: allow or deny the gated strategy's ordinary Edit / Write / shell card. |

Delegation lives in MARVIN's data directory, never in your repository's `.marvin/`. A repository you clone cannot grant its own supervisor anything.

## Shadow first, then autonomy, per category

In shadow, every call the supervisor makes is checked and recorded as a **proposal**, and nothing happens: the tab keeps waiting for you. When you answer, MARVIN pairs your answer with its proposal. `GET /api/supervisor/stats` reports how often it agreed with you, per category.

You switch a category to autonomous yourself, one at a time: `questions`, `nudges`, `posture`, `confirms`. MARVIN suggests a bar (20 proposals, 90 % agreement, no human-only act ever proposed as an act) and enforces none of it. Nothing graduates automatically.

## Grounds

Every act cites what it rests on: a quote from your charter, a line of the tab's first message (your brief), a plan step, an ADR, a memory fact, or `file:line`. Citations must resolve. Only grounds the tab did not write itself are **strong**, and an act needs one. Otherwise it escalates.

## What is always yours

The supervisor never performs these, at any level and in any posture. It brings them to you instead:

1. **Integration and money:** merging, merge-all, Prepare MR, pushing, opening or merging a request, starting CI.
2. **Containment:** the shared-checkout HEAD-moving confirm, a tab reaching into the main checkout, lane confirms.
3. **Discarding work:** rejecting changes, dropping a worktree that holds work, closing a tab.
4. **Boundary paths:** auth, credentials, CI configuration, `.env`, sudoers, migrations.
5. **Widening a posture:** gated → auto → full, Ask or Plan → Agent, a pricier model, more effort.
6. **Scope:** approving a plan, or changing a tab's DoD or scope.
7. **Topology:** opening a tab.

Questions are screened by a keyword heuristic for these acts. It is labelled a heuristic because wording evades it. The line that holds regardless is the **touched turn**: once the supervisor has sent a message into a turn or answered something in it, every act on this list in that turn raises a confirm only you can answer, in `full` too.

## The inbox

Everything the supervisor may not do lands in the escalation inbox, `GET /api/supervisor/inbox`. An item shows:

- the **raw act**: the tool, its full input, a digest, and a one-line summary MARVIN builds from them, never from the supervisor's prose;
- the supervisor's **recommendation**, beside the act and never in place of it;
- its grounds, and why it is here;
- for a merge, a `git merge-tree` preview: clean, behind, or the files that would conflict;
- the actions you can take, with their labels.

Your click on the act is the consent. `POST /api/supervisor/inbox {id, actionId}` performs the act **as you**: an answer is recorded as yours, a confirm is yours, a merge is local and unpushed. An item resolves itself when you answer its question or confirm in the tab. A finished tab left idle gets one item offering to close it and keep its branch. That is reversible, so it is a single click.

**A new tab** is the one topology act the supervisor may propose, and only when you asked for one. You write to it with `POST /api/supervisor/message`; it can cite that message, and only that, as the request. The item shows the first message, the base it would be cut from, and the posture, marking what is wider than your latest tab. On your click the tab opens in a fresh worktree, never the shared checkout, and with no fallback if the worktree cannot be made. You may edit the message and narrow the posture first; you cannot widen it there. The first turn is recorded as the supervisor's and is touched. One request opens one tab.

Telling the supervisor "approve X" in its conversation approves nothing. At most it escalates X, and you consent on the act itself.

## The ledger and the audit

Every proposal, act, refusal, drop, escalation and your own inbox acts are in an append-only ledger under `~/.marvin/supervisor/<projectId>/`. Read it with `GET /api/supervisor/ledger`.

The session auditor can review the supervisor: `POST /api/audit {"target":"supervisor","projectId":…}`. It reads the ledger window and the transcripts of the tabs the supervisor acted on, and looks for four things: grounds that do not support an act (`ungrounded`), acts at the edge of the list above or with no wake behind them (`overreach`), repeated nudges or answers (`loop`), and a tab that took a supervisor message as your approval (`consent`). The report is for you. The supervisor never sees it.

## The token, and what it does not protect against

The supervisor's routes need a per-boot token, written to `~/.marvin/supervisor/token` (mode 0600). It is never put in a turn's environment, and the gate refuses a tab's tool call that names MARVIN's control routes or the supervisor's data directory.

What that does **not** stop, stated plainly:

- **Code a tab executes.** A test script or build step runs as you, and can do anything you can, including reading that token. Only OS-level isolation would stop it, and MARVIN does not add any.
- **A model hiding what it names.** The gate matches what a tool call names. A path or URL built at run time can slip past it.

What the token and the ledger give you instead is **detection**: an act with no matching supervisor wake in the ledger is exactly what the audit's `overreach` class looks for.

# ADR-0133 — An approved queue: the user approves a list of briefs once, and the supervisor opens them as slots free

- **Status:** Accepted (2026-11-11), with the amendments under "Decisions" below; build plan in [`docs/plans/supervision-improvements.md`](../plans/supervision-improvements.md)
- **Amends:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §7 (one request, one tab; never on its own initiative)
- **Related:** [ADR-0122](./0122-a-tab-gets-its-worktree-or-is-refused.md) (atomic tab creation), [ADR-0108](./0108-per-session-posture.md), [ADR-0110](./0110-worktrees-isolate-the-filesystem-not-the-machine.md) (shared machine), [ADR-0128](./0128-the-user-talks-to-the-supervisor.md) (cards are the consent)
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md)

## Context

ADR-0127 §7 lets a supervisor open a tab only from a confirmed inbox item, one request to one tab. On a real project the owner worked differently: they approved a list ("queue wave 8 in the decided order", "keep five tabs busy") and expected a tab to open whenever one closed. About thirty tabs were opened that way in two days by an external dispatcher, with a cap the owner changed three times (4, 6, 5) and lowered automatically when a shared test machine dropped off the network.

Three things went wrong there that a design should prevent:

- A second dispatcher process, started by hand a day earlier, opened six tabs past the cap.
- The supervisor queued three items the owner's own plan had deferred to a later release. A tab caught it; the queue did not.
- Ordered work (step N needs step N−1 merged) was sequenced by the supervisor remembering to queue the next brief after each merge.

## Decision

**A queue is a list of briefs the user approved as a list. Opening a tab from it is the user's act, given in advance, bounded by a cap, and checked at open time.**

1. **The object.** `supervisorDir(projectId)/queue.json`: ordered entries `{ id, title, brief, posture, after?: id[], scopeRef?, approvedAt, approvedBy: "user" }`. The supervisor may **propose** entries (a card listing them, with each brief's first lines); only the user's click on that card approves them, all or a subset (ADR-0128: the card is the consent). An unapproved entry never opens.
2. **Opening.** The runtime, not the model, opens the next entry when: open tabs in the project < the cap; every `after` entry's branch is merged; the disk floor of ADR-0122 holds; and the resource guard passes (below). Each tab is a fresh worktree at the entry's approved posture, through ADR-0122's atomic path. One opener per project: a lock in the data dir, so a second process cannot open.
3. **The cap is the user's.** A per-project number set in the Supervisor workspace, default 1. The supervisor may *lower* it for the duration of a resource alarm and must say so in the ledger and restore it; it may never raise it.
4. **A resource guard, generic.** `.marvin/worktree.json` gains `openGuard`: a command whose exit code says "do not open now" (the project decides what that means: a remote runner unreachable, memory low). MARVIN ships no knowledge of any runner (Golden Rule 6). Project-controlled input: validated where read, run with the same environment rules as the `env` map (ADR-0110), with a timeout.
5. **Scope is checked, not remembered.** When an entry carries `scopeRef` (a path and heading in the project's own plan document), the runtime checks at open time that the entry's id still appears under that heading and not under a heading the project marks as deferred (`worktree.json: deferredHeadings`). A miss holds the entry and raises an escalation naming both lines. No model reads the plan to decide.
6. **What stays as it was.** A tab outside the queue still needs its own confirmed card. The queue never splits one entry into several tabs. Everything a queued tab does is behind the same gates; nothing here touches merging (ADR-0134).

## Consequences

- The owner approves once and sees a list drain, with the order, the cap and the holds on one screen.
- "Never on its own initiative" becomes "never beyond what the user approved as a list": a real widening, bounded by the card, the cap, the lock and the two checks.
- A project with no `openGuard` and no `scopeRef` gets the cap and the ordering only.

## Alternatives considered

- **Keep one card per tab.** Thirty cards in two days; the owner would approve them unread, which is worse than one list read once.
- **Let the supervisor model decide when to open.** A model opening sessions on its own judgement is the shape Golden Rule 1 bans.
- **Put the cap and the guard in MARVIN's settings.** The cap is per project and the guard is project knowledge.

## Open questions (recommended answer first)

1. May the supervisor reorder approved entries? **No**: order is part of what was approved; it may only hold one, with the reason.
2. Does an entry expire? **Yes, after 7 days unopened**: a brief written against an older tree is stale.
3. Is `scopeRef` required? **No, but a queue of more than five entries without one shows a warning on the card.**

## Decisions (2026-11-11, by the owner's delegation, after checking the text against the code)

The three open questions are answered as recommended. Three amendments:

1. **The guard command is the user's, not the repository's.** §4 puts `openGuard` in `.marvin/worktree.json`. That file is written by whoever wrote the repository, and a command the runtime executes cannot be made safe by validating it: cloning a hostile repository would run its code (the project-controlled-config rule in `REVIEW.md`). The guard is stored with the queue in the supervisor dir, set on a card that shows the command in full, and the user's click approves it. Any change to the text needs a new click. It runs with the `env` map's rules (ADR-0110) and a timeout. `deferredHeadings` stays in `worktree.json`: it is only compared against text, never executed, and is validated where read.
2. **The cap counts every open tab in the project** that is not the supervisor's own session, whoever opened it. A tab the user opens by hand takes a slot; the queue never closes a tab to make room.
3. **"Merged" for `after` is the derived worktree state** (`reconcileWorktrees`, ADR-0103), not a recorded one, so a branch the user merged in a terminal releases its successors.

## Scope of Done

- [ ] An entry opens only when approved by the user's click; a model-written entry with no approval never opens (test).
- [ ] Two opener processes cannot both open (lock test); the cap holds under a burst.
- [ ] `after` holds an entry until its predecessors' branches are merged.
- [ ] `openGuard` and `deferredHeadings` are validated at the read boundary; a failing guard holds and ledgers; a deferred `scopeRef` holds and escalates.
- [ ] The supervisor can lower the cap during an alarm and the ledger shows the lowering and the restore; raising is refused.

# ADR-0134 — A standing merge authorisation: finished tab branches merge behind the project's gate, without a click each

- **Status:** Accepted (2026-11-11), with the amendments under "Decisions" below; build plan in [`docs/plans/supervision-improvements.md`](../plans/supervision-improvements.md)
- **Amends:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §6 (merging is human-only) and [ADR-0109](./0109-batch-integration-and-metered-ci.md) (who starts `mergeAllWorktrees`)
- **Related:** [ADR-0103](./0103-implementer-branch-lifecycle.md) (derived worktree state), [ADR-0104](./0104-ship-review-gate.md), [ADR-0123](./0123-parallel-tabs-share-a-machine-and-a-numbering.md)
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md)

## Context

ADR-0109 gives the user one local pass that folds every `ready` branch into the current branch, oldest first, stopping at the first conflict. ADR-0127 keeps starting it human-only.

On a real project about forty-five branches merged in two days under a standing instruction from the owner, each behind the project's own full test gate, by scripts outside MARVIN. What those scripts had to do, and what went wrong, is the requirement:

- **Predict the conflict before spending a gate run.** A merge was tried in a scratch index first; a branch that conflicted went back to its tab with the file names. Nine bounces, none of which cost a gate run.
- **Hold some branches for a window.** The owner's rule: a branch that changes the gate itself merges only in the evening.
- **Refuse a branch with no hand-off note**, and let the supervisor override that with a recorded reason.
- **Survive a restart.** A lock left by a killed merge blocked the queue for two hours until someone looked.
- **Close the merged tab**, but never a tab that has not closed its scope.
- **Never merge onto, push, or tag the protected branches.** The standing instruction covered one integration branch only.

## Decision

**The user may give a project a standing authorisation to merge finished tab branches into one named local branch, behind a gate command the project names. The runtime performs it; the supervisor's only merge verb is to hold or release.**

1. **The authorisation.** A card in the Supervisor workspace, the user's click: `{ target: <one local branch>, gate: <command>, holds: [...], expiresAt }`. Stored in the supervisor dir, shown on the workspace at all times, revocable in one click. No authorisation, no change from today.
2. **What it never covers**, enforced in code: any branch but `target`; a push, a tag, a merge request, metered CI (ADR-0109 stays); a branch whose tab has not closed scope-met; a tree with uncommitted changes; a conflict (never resolved by the runtime, always sent back to the tab with the file list); discarding anything.
3. **The pass.** For each `ready` branch (ADR-0103's derived state), oldest first: predict with `git merge-tree`; if clean, merge without committing, run `gate` with a timeout, commit on exit 0, abort on anything else and report the failing lines to the tab. One pass at a time, behind a lock that records its pid and is cleared at boot when that pid is gone.
4. **Holds are data.** `holds: [{ pathGlob, window }]` ("branches touching `scripts/gate/**` merge between 21:00 and 07:00"). The supervisor's verb `hold_merge(branch, reason)` / `release_merge` only narrows: it can hold a branch, never force one through a hold or a failed gate. An override of a *project* check (the hand-off rule) is an escalation to the user.
5. **After a merge**, the tab is closed only if its last close marker is scope-met and the worktree is clean; otherwise it is left open and listed.
6. **Everything is ledgered**: branch, predicted result, gate exit code, commit, who held what and why.

## Consequences

- Merging stops being the supervisor's judgement at all: the gate decides, the runtime executes, the user authorised the pair once.
- This is the widest of the three supervisor amendments. It is bounded to one local branch and reversible by `git reset` on that branch before anything is pushed, which stays the user's act.
- A project with a weak gate gets weak protection. The card shows the gate command in full so the user approves what will actually run.

## Alternatives considered

- **Keep the click per pass** (ADR-0109 as is). With 25–55 minute gates and branches finishing through the night, the click is the bottleneck, and the user asked for the opposite.
- **Let the supervisor model run `mergeAllWorktrees`.** A model with a merge verb; ADR-0127 gives it no write tools for a reason.
- **Resolve simple conflicts automatically.** Nine conflicts were all "two tabs appended to one file"; the fix belonged in the project (a union merge attribute, one file per entry), and was made there.

## Open questions (recommended answer first)

1. Expiry of the authorisation? **Required, at most 14 days**, renewed by a click.
2. May several branches merge as one octopus under one gate run? **Not in the first version**: one branch, one gate run, one culprit. The external scripts did batch, and a failed batch cost a second run each time.
3. Does a gate run that falls back to a slower machine count? **Yes; but the pass waits while the machine's load is above a project-set number** (the same `openGuard` idea as ADR-0133): two merges failed on timeouts alone when gates ran locally.

## Decisions (2026-11-11, by the owner's delegation, after checking the text against the code)

The three open questions are answered as recommended. Three amendments:

1. **The pass merges and runs the gate in a scratch worktree, never in the main checkout.** §3 as written merges without committing in the checkout that has `target` checked out and runs the gate there. With gates of 25–55 minutes that leaves the user's main checkout, and every shared-checkout tab (ADR-0102), in a half-merged state for that long. Instead: a scratch worktree is cut detached at `target`'s tip, set up like a tab's worktree (`worktree-setup.ts`), the branch is merged and committed there, and the gate runs there. On exit 0 `target` is fast-forwarded to that commit; on anything else the scratch tree is discarded and `target` never moved. The fast-forward waits, and says so, while the main checkout has `target` checked out with uncommitted changes or a live turn in a shared checkout.
2. **If `target` moved while the gate ran, the result is discarded and the branch is retried**, because the commit that was tested is no longer the one that would land.
3. **The load wait in open question 3 uses the guard command of ADR-0133** (user-approved, stored in the supervisor dir), not a second mechanism. Hold windows are read in the machine's local time zone, and the card says which.

## Scope of Done

- [ ] With no authorisation nothing merges without the user's click (regression test on ADR-0109's path).
- [ ] The pass refuses: a non-target branch, a tab not closed scope-met, a dirty tree, a predicted conflict, a failed gate (one test each); it never pushes or tags (the git argv is asserted).
- [ ] A stale lock from a dead pid is cleared at boot; two passes cannot run at once.
- [ ] A hold by path and window keeps a branch out until the window; `hold_merge` cannot release past it.
- [ ] Every step is in the ledger and visible in the workspace; revoking stops the next merge.

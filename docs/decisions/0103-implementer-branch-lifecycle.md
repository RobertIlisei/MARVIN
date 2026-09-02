# ADR-0103 — The implementer branch has a lifecycle, and it is derived from git

- **Status:** Accepted — implemented 2026-09-01
- **Date:** 2026-09-01
- **Related:** [ADR-0081](./0081-implementer-subagents-on-isolated-worktrees.md) (created the worktrees; deliberately stopped at "the user merges"), [ADR-0080](./0080-background-subagents-and-builtin-readonly-agents.md) (`background_tasks_changed` as a level signal), [ADR-0012](./0012-source-control-mutation-channel.md) (amended — merge was "out of scope entirely"), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (deferred its live roster for want of this same end-of-work event)

## Context

> "when they finish work, their branches remain, they don't merge themselfs the
> work… the merge happened because i asked for a merge but marvin has no
> mechanism unless i ask him."

ADR-0081 got the policy right — the deliverable is a branch, the user merges —
and then built no mechanism for any of it. Steps 4 and 5 of the implementer
protocol were prose asking the model to remember, and step 5 was gated behind
"after merge/reject", an event that never arrived.

### Measured on a real project, 2026-09-01

Five `marvin/*` branches from one parallel-triage run. Three carried a commit
each and *were* merged into `chore/backlog-parallel-triage` — because the user
asked. State **after** that successful merge:

| | |
|---|---|
| Worktree checkouts still on disk | 3 |
| Still in `.marvin/worktrees.json` | 3 |
| Branch refs still present | 5 |
| Disk | **3.1 GB** |
| Files | **159,358** |

The two remaining branches had **zero commits** — reflog showed only
`branch: Created from HEAD`. Their checkouts had been removed, which dropped
them from the registry, so `worktree_list` could never see them again. They
were permanently invisible litter.

Second-order damage was already on record: `docs/roadmap.md` — nested
implementer checkouts were the 49,304 files that broke the file-tree walker.
By this incident it was 159,358, because builds ran inside them.

### Six mechanism gaps

1. **No completion event.** `background-tasks.ts` consumes
   `background_tasks_changed` — a *count* — never `task_notification`. Nothing
   knew *which* implementer finished.
2. **The binding died at turn end** (`clearSubagentsForTurn`), while the
   worktree outlived it by design.
3. **`WorktreeRecord` was write-once** — no state, no task id, no counts.
4. **No surface.** No route read the registry. The only worktree UI was a
   Source Control row keyed on **dirty count** — and an implementer that had
   correctly *committed* shows a dirty count of **0**, so finished work
   rendered identically to none.
5. **No merge or diff path** anywhere.
6. **No garbage collection** — no prune, no reconciliation, no expiry.

### What Anthropic documents

- **The human merges, on every surface.** No auto-merge in the CLI's
  `--worktree`, Claude Code on the web, Managed Agents, or agent teams.
- **Unchanged worktrees are auto-cleaned**; changed ones survive until a sweep
  gated on `cleanupPeriodDays` that refuses to delete anything holding changed
  files, untracked files, or unpushed commits
  (`code.claude.com/docs/en/worktrees`, `.../sub-agents`).
- **The handoff artifact is a branch** — web pushes it and you open the PR;
  Managed Agents push and open a draft PR.
- **Not documented:** any handoff protocol, and any branch-hygiene policy —
  no TTL, no naming convention, nothing on deleting branches after a merge.

So Anthropic settles the policy and leaves the mechanism open. MARVIN
implemented neither half of the auto-clean rule.

## Decision

**An implementer worktree has a lifecycle, every state but one is derived from
git, and what is provably spent is reclaimed automatically.**

### 1. Derive, never merely record

`reconcileWorktrees` recomputes state on every read:

| Check | State |
|---|---|
| branch ref gone | record dropped |
| bound task, no completion, inside the grace window | `running` |
| `rev-list --count base..branch` == 0 | `empty` |
| `git branch --all --contains <branch>` names another ref | `merged` |
| otherwise | `ready` |

This is the load-bearing decision. **The user merges in a terminal, in another
session, or by hand, and MARVIN is not there to see it** — that is exactly what
happened here. A recorded state would have been wrong the instant it did.
`--contains` answers "merged, and into what" for every ref in one call.

Reconciliation runs in both directions: it also **adopts** `marvin/*` branches
git knows about that the registry lost, which is the hole that made the two
orphans invisible.

### 2. Consume `task_notification` for identity

`background_tasks_changed` remains the liveness signal — a level signal cannot
wedge on a missed bookend, which is why ADR-0080 chose it. But a count cannot
name the branch that just became a deliverable, so `task_notification` is now
read alongside it, purely for identity. The `task_id` is persisted onto the
record at dispatch so the association survives `clearSubagentsForTurn`.

### 3. Reclaim what is provably spent

```
empty  + clean → remove checkout, delete branch   (nothing exists to lose)
merged + clean → remove checkout, delete branch   (commits are in history)
ready          → NEVER touched. This is the deliverable.
running        → NEVER touched.
dirty          → NEVER touched, in any state.
```

Anthropic age-gates its sweep because "has changes" is all it knows. MARVIN's
derivation is strictly stronger — it knows whether the commits live in another
ref — so **no TTL is needed to make `empty` or `merged` safe**, and none is
used. Age survives in exactly one place: a `running` record whose
`task_notification` never arrived (MARVIN killed mid-implementer) falls back to
git-derived state after `MARVIN_WORKTREE_RUNNING_STALE_HOURS` (24). Without
that, such a record would claim `running` forever and never be swept.

### 4. Integration is a LOCAL merge. Never a push, never a per-branch MR

`worktree_merge` merges one branch into the current branch of the main tree and
stops. It refuses on a running implementer, an empty or already-merged branch, a
dirty main tree, or a conflict (aborting cleanly).

The reason is cost, and it is measured. On the project this was found in, a push
to a branch with no open MR creates **no pipeline at all**; an MR pipeline is
~10 min; and a merge to the default branch runs the full smoke suite —
**19.8–27.7 min on a 2× cost-factor runner, ~48 compute-minutes**, against a
Free-tier allowance of 400/month that is already exceeded and purchased in cash.
Three branches merged individually would be ~144 compute-minutes; batched into
one merge, ~48.

`worktree_create` cuts from the current `HEAD` (ADR-0081, so the implementer
sees unpushed work), which means implementer branches naturally stack onto the
branch the user is already on. Merging them there costs **zero** extra
pipelines — the commits ride along in whatever run that branch was going to do.
And because MARVIN partitions files across implementers, the branches are
disjoint by construction: the three in this incident touched five files, each
exactly once, so a textual conflict was impossible.

This is generic. Golden Rule 6 keeps every project fact out of MARVIN's source;
local-merge-no-push is simply the correct default wherever CI is not free, and
harmless where it is.

### 5. Surface it

`GET /api/worktrees` (reconciled) and `POST` for `merge` / `sweep`; a Worktrees
section in the macOS Source Control panel showing state, branch, counts and
task, with Merge and Reclaim. The dirty-count row that reported 0 for finished
work is gone.

## Considered and not taken

- **Auto-merge on green tests.** ADR-0081 records the user's position — "i will
  be the one deciding if we move with the merge" — and Anthropic documents no
  surface that auto-merges. Unchanged.
- **Push each branch / open an MR per implementer.** The documented handoff on
  Anthropic's *hosted* surfaces, and the single most expensive thing MARVIN
  could do on a pipeline-gated repo. Rejected on measured cost.
- **An age-based TTL for every state**, mirroring `cleanupPeriodDays`. Redundant
  given a derived `merged`, and it would have kept the 3.1 GB for a week.
- **Recording `merged` when MARVIN performs the merge.** Would be correct only
  for merges MARVIN performed — i.e. not the one that prompted this ADR.

## Consequences

- The 3.1 GB / 159,358-file case becomes self-clearing, and the invisible-orphan
  class is gone: a branch the registry loses is adopted on the next read.
- `worktree_remove` keeps its "checkout only, branch survives" semantics for
  explicit use; `worktree_sweep` is the one that deletes refs, and only under
  proof.
- **ADR-0012 amendment:** merge moves off its "out of scope entirely (v2+)"
  list, for this bounded case only — one MARVIN-created branch, into the current
  branch, local, never pushed. Rebase, cherry-pick and conflict-resolution UI
  stay off it. Precedent: stash and the graph view moved off the same list on
  2026-08-31.
- **ADR-0081 amendment:** "the deliverable is a branch the user merges" stands.
  What changes is that MARVIN now says so, deterministically, and cleans up
  after the answer.
- A `running` record from a killed session is stale for up to 24 h before the
  sweep can see it. Bounded, and the alternative is deleting a tree an
  implementer is still writing to.

## Amendment — 2026-09-02: the merge tool had never worked

Found by reading the transcripts rather than the tests. On 2026-09-01, session
`84845bd1` called `worktree_merge` four times and **all four failed**:

```
Command failed: git merge --no-ff -m merge marvin/wire-realetransportadapter-…
  MARVIN: commit message format violation
  Expected: <type>(<scope>): <subject>
```

The cause was `mergeWorktree`'s own commit message, `merge <branch>: <task>`.
The project's `commit-msg` hook enforces Conventional Commits — and *exempts
merge commits*, on line 10, by matching git's own wording:

```bash
if echo "$SUBJECT" | grep -qE '^(Merge |fixup! |squash! |Revert ")'; then exit 0
```

A lowercase `merge` misses that exemption. So the tool could never succeed on
any repo with a hook of this shape, which is most of them; commitlint's
`defaultIgnores` keys on the same prefix.

MARVIN recovered on its own — it ran `git merge --no-ff --no-commit` by hand
four times and committed each with a proper message, and the merges landed. The
work was not lost, but a guard that is routinely bypassed is worth less than no
guard, because nothing recorded that it was unusable.

**Fix:** the merge subject is now byte-identical to git's (`Merge branch
'<branch>'`) and the task moves to the commit **body**, which no hook inspects.
Not `--no-verify` — the hook was right and the message was wrong.

**Why the suite was green while the tool was broken:** the fixture repo had no
hooks. It now installs a rejecting `commit-msg` hook, which is the only kind of
repo where this bug is visible.

### `worktree_remove` had the same prose-without-mechanism gap

Its tool description said *"Never remove a worktree whose implementer is still
running"* and nothing enforced it. In session `35ca589e` two live implementers
had their checkouts removed three minutes after dispatch; both branches ended
with zero commits. `removeWorktree` now derives state and refuses `running`
unless `{ force: true }` is passed, and the route answers 409 rather than 404.

### What this run also confirmed

`sweepWorktrees` reclaimed 7 checkouts, 9 `marvin/*` branches and **7.0 GB** on
2026-09-01. Every deleted tip was verified reachable afterwards — 4 from `main`,
3 from `chore/backlog-parallel-triage`. Nothing was lost, including the three
branches merged in an earlier session MARVIN never witnessed: the decision to
derive `merged` from `--contains` rather than record it is what made that safe.

## Scope of Done

- [x] `task_notification` consumed; `task_id` persisted; completion fires an event
- [x] `reconcileWorktrees` derives state from git, adopts orphans, drops dead records
- [x] `sweepWorktrees` reclaims `empty` + `merged`, never `ready` / `running` / dirty
- [x] `worktree_merge` merges locally, never pushes
- [x] `GET/POST /api/worktrees`; macOS Worktrees section with Merge + Reclaim
- [x] Slug collision no longer derived from array length
- [x] 11 lifecycle tests, including "never deletes an unmerged branch"
- [x] (2026-09-02) merge subject passes a Conventional-Commits hook; `worktree_remove`
      refuses a running implementer — 13 lifecycle tests

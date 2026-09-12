# ADR-0109 — Integration is batched, and spending CI minutes asks first

- **Status:** Accepted — implemented 2026-09-10
- **Date:** 2026-09-10
- **Related:** [ADR-0103](./0103-implementer-branch-lifecycle.md) (local-only merge, and the measurements), [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (a branch per chat tab), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (the confirm that survives auto mode), [ADR-0040](./0040-interactive-ask-user-question.md) (the family it belongs to)

## Context

The user, after running several tabs at once:

> *"since now we have multi branching and multi sessions, how do we handle
> commits and pushes? … in gitlab, we have limited compute, working 5 sessions
> and all commiting and pushing and merging to main, each with his own MR,
> means 5x~45 min + compute just for a MR to main branch."*

The arithmetic is right, and ADR-0103 had already measured the terms on this
same project:

| action | cost |
|---|---|
| push a branch with no open MR | no pipeline at all |
| open a merge request | ~10 min |
| merge to the default branch | 19.8–27.7 min on a 2× runner = **~48 compute-minutes** |

Against a Free-tier allowance of 400 minutes a month, already exceeded and
bought in cash. Five branches integrated one request each is ~240
compute-minutes; the same five folded together and pushed once is ~48.

ADR-0103 chose the cheap path and built the mechanism for it: `mergeWorktree`
folds a branch into the current branch of the main tree, locally, and never
pushes. Two things had since gone stale.

**One at a time stopped being enough.** ADR-0103 was written when branches came
from implementer subagents, a few at a time. ADR-0107 gave every chat tab its
own branch, so the same user now has seven. Merging them one dialog at a time
is friction, and friction is what pushes people onto the expensive path.

**Nothing stopped the expensive path.** The tool policy hard-denies publish
verbs — `npm publish`, `docker push`, tag pushes — on the grounds that they
cannot be taken back. `glab mr create` and `gh pr create` appeared nowhere in
it. In `auto` mode, which is the default, five tabs could have opened five
merge requests with no human in the loop: exactly the 240-minute scenario, and
exactly the "unbounded autonomy" shape the policy file's own comment cites.

## Decision

### 1. `mergeAllWorktrees` — every finished branch, one pass, local

Only `ready` branches: finished work, no tab holding it, not yet merged. A
`session` tree belongs to an OPEN tab and is decided at tab close, where the
user is already being asked; `running` is an implementer mid-flight; `empty`
has nothing; `merged` is in already. Everything skipped is **reported with its
reason**, because "it did nothing" and "there was nothing to do" must not look
the same.

Oldest first, since that is the order the branches were cut and the order most
likely to apply. **Stops at the first conflict.** A conflicting merge already
aborts and leaves its branch untouched, so a failure costs nothing — but
continuing past one would leave a half-integrated tree and no obvious place to
resume. Stopping means the tree is always "everything up to X is in, X is what
needs you".

Surfaced as **Merge all** in Source Control ▸ Worktrees, shown only when more
than one branch is ready.

### 2. Spending CI minutes asks first, in every permission mode

`classifyMeteredCiRisk` names the three acts that cost money — opening a
request, merging one, starting a pipeline by hand — across `glab`, `gh`, and
the GitLab push options that do the same thing. `maybeMeteredCiConfirm` turns a
match into a confirm card that names the free alternative.

**`git push` is deliberately not on the list.** A push to a branch with no open
request starts no pipeline on this project, and pushing is how work is kept
safe. A confirm there would be noise, and noise is what trains a user to click
through the confirm that matters.

This sits beside `maybeAskUserQuestion` / `maybePlanApproval` /
`maybeSharedTreeConfirm` rather than in `toolPolicy`, and for the same reason
ADR-0102 gives: **the ordinary `confirm` class is bypassed wholesale in `auto`
mode**, which is the default. A gate that only prompts in `gated` mode would
not stop the thing it exists to stop.

The usual justification for `confirm` is reversibility, and that is what let MR
creation slip past: an MR is trivially closable. But closing it does not refund
the pipeline that opening it started. The minutes are spent at the instant of
the call, which puts this in the same class as the publish verbs, not the local
destructive ones.

With no UI attached — a headless wakeup, a background job — the call is
**denied** rather than run. An unattended turn is the worst one to let spend
money, and the message names the free path.

## Consequences

- Seven tabs still cost one pipeline, and it takes one click instead of seven.
- A model cannot open a merge request unattended, in any permission mode.
- Pushing branches stays entirely unhindered, which is the intended workflow:
  push freely for safety, integrate locally, open one request.
- The confirm text names Merge all, so the gate teaches the cheaper path rather
  than merely blocking the expensive one.
- The numbers here are this project's. Another project with free runners would
  find the gate a nuisance; if that comes up, it wants a per-project setting,
  not a weaker default.

## Scope of Done

- [x] `mergeAllWorktrees` merges every `ready` branch oldest-first, locally,
      and reports what it skipped and why.
- [x] It stops at the first conflict with the tree clean, the branch intact and
      no `MERGE_HEAD` left behind.
- [x] It refuses before merging anything when the main tree is dirty.
- [x] `POST /api/worktrees { action: "merge-all" }` exposes it; Source Control
      shows **Merge all** once more than one branch is ready.
- [x] `classifyMeteredCiRisk` catches request creation, request merges and
      manual pipeline runs on both forges, and leaves plain `git push` and
      every read-only forge command alone.
- [x] The gate fires in `auto` mode as well as `gated`, and denies with no UI.
- [x] 1322 sidecar tests green; `swift build` and `tsc` clean.

## Amendment — 2026-09-10: Prepare MR — squash the day's tabs into one commit, push, open the request

**What was watched.** User: *"we need to find a way to understand what were the
latest branches we worked on in the multisession and then to have a way to
group them into a commit and push to gitlab for a MR."* And, twenty minutes
later, MARVIN doing exactly that by hand in a tab — `git merge --no-ff` twice
into the tab's own branch, `git push gitlab HEAD:…`, then `glab mr create` —
and stopping at the metered-CI confirm this ADR installs, while the user was
away: *"if i'm away, no work gets done."* The gate did its job; the job was in
the wrong place. Opening the request is a decision for the user to make once,
in advance, not for a model turn to wait on.

**What changes.** A third integration shape beside `mergeWorktree` and
`mergeAllWorktrees`: **`prepareMergeRequest`** squashes the chosen `ready`
branches, oldest first, into **one commit** on a fresh `mr/<date>-<name>`
branch, then — only when asked — pushes it and opens the request from the push
(`-o merge_request.create`, target detected from the current branch's
upstream). Surfaced as **Prepare MR** in Source Control ▸ Worktrees, a sheet
with the finished branches ticked, open tabs listed greyed with the way to
include them, the generated Conventional-Commits message editable, and the two
opt-ins as toggles whose wording states the pipeline cost.

**Why a squash.** `mergeAllWorktrees` folds each tab's commits into the
*current* branch as merge commits — right when the user's branch is the
integration point, wrong when the integration point is a review. A day of tabs
is one piece of work to a reviewer. The per-tab history is not lost: the tab
branches are never touched.

**Why a temporary worktree.** The squash writes into an index and a working
tree, and the user's checkout is dirty with MARVIN's own `.marvin/*` files
essentially always — the same fact that broke branch switching (ADR-0012
amendment, same day). A disposable checkout cut from HEAD means no stash, no
HEAD move under an open tab (ADR-0102), and a failed run that costs nothing.
One temporary commit per branch, so a conflict on the third loses only the
third; the temporaries collapse into the one commit, hooks honoured, since that
is the commit a reviewer reads. The branch prefix is `mr/`, deliberately not
`marvin/`, or `adoptOrphans` would list it as a lost implementer tree.

**Why the metered-CI gate does not fire here.** The gate exists so a *model*
cannot spend money mid-turn. Here the user ticks "Open a merge request from
the push" with the cost written on the toggle. Same decision, made by the
same person, moved to where they are.

**Also.** `reconcileWorktrees` now reports each branch's tip date and, for
unmerged work, lines added / removed; the section sorts newest first and shows
`+N −M`, so "what did I work on lately" is answered where the action lives.
The cost is one `git log -1` per tree and a `numstat` for ready and session
trees only — the reconcile is still synchronous git on the event loop, and
that remains the open item.

### Scope of Done

- Five tests in `prepare-merge-request.test.ts`: one commit on the `mr/`
  branch with every folded file, the user's HEAD and dirty file untouched, no
  temp worktree left; open-tab and unknown slugs skipped with reasons and a
  conflict stopping the run with the earlier fold kept; nothing finished →
  no branch; push to a bare remote lands, and an MR push option the remote
  refuses is reported with the branch kept on disk. Full suite green.
- The sheet builds; `swift build` clean.

## Amendment (2026-09-10, ADR-0111) — a preview before the first fold, and an owner for each conflict

Merge all and Prepare MR stop at the first conflict, correctly, and left the user holding it. [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md) adds `previewIntegration` (`git merge-tree --write-tree`, nothing checked out) so the verdict per branch — clean, behind by N, or the conflicting files — is known before either flow runs; the Prepare MR sheet shows it as a chip per row. A conflicting branch gets **Sync**: one turn in the tab's own worktree that merges the target in, resolves, tests and commits, dispatched through the resume path. The metered-CI confirm is unchanged and still stops that turn from opening a request. The Sessions pane gains a Ready-to-integrate section whose footer calls this ADR's two flows.

## Amendment (2026-09-11) — refuse only what the merge would overwrite; a Prepare MR that outlives the client

Two failures from one afternoon on a real project, both in this ADR's merge path.

**Merge on close said "the main working tree has uncommitted changes" for files the branch never touched.** A nine-file billing branch could not close with *Merge* because two ADRs another tab was writing were unsaved in the main checkout. `workingTreeDirty` asked "is any tracked file outside `.marvin/` modified?" — a rule stricter than git's own, which refuses a merge only when *a file the merge changes* is dirty. That is the rule now: `mergeBlockingPaths(workDir, branch)` intersects the modified tracked paths (untracked and `.marvin/*` excluded, renames read on their new side) with `git diff --name-only HEAD...branch`, and the refusal names the files — *"Uncommitted changes to README.md would be overwritten by marvin/tab/x — commit or stash that file before merging."* `mergeAllWorktrees` lost its up-front check: each fold checks its own overlap, so an unrelated edit stops nothing and an overlapping one stops exactly the branch it overlaps. Four lifecycle tests replace the three that pinned the old rule.

**Prepare MR "failed: the request timed out" while it was still running.** The squash commit runs the project's hooks — the point of a commit a reviewer reads — and on this project the pre-commit band compiles and runs the fast tests. The client's shared 30 s `URLSession` gave up; the sidecar carried on; the outcome was lost with the connection; and the temporary tree it was working in showed up in the Worktrees list as `mr-2026-09-11-mr-2026-09-11-22723`, because the sheet's placeholder reads `mr/<today>-<name>` and the user typed the whole thing. Four changes: the client gives this one call 13 minutes, the sum of the sidecar's own commit and push budgets; a timeout now reads as "still running — refresh in a minute, the log has the outcome" and the sidecar logs `[prepare-mr] ok|failed after N s`; a typed `mr/`, `mr-` or leading date is stripped from the name; and the temporary tree is prepared like a tab's (symlinked dependency dirs, copied `.env`) through a `prepare` hook the route injects — a compile-and-test hook in a bare checkout fails on a missing `node_modules` and reads as a hook failure. The sheet says the commit can take minutes.

Still open: the route is one long HTTP request; the honest shape is a job the event bus reports on, which is the same "synchronous git on the event loop" item already parked.

## Amendment (2026-09-11, second) — an integration is a job you can watch, and a commit that counts what is in it

The morning's fix made Prepare MR survivable; the afternoon's live run showed it was still unwatchable, and that it had been lying in the one place a reviewer reads.

**"Where do I track it?"** The user ticked six branches, typed a name, and the sheet closed. The panel rendered nothing: two buttons dimmed, no row, no phase, no clock. Meanwhile the sidecar was three minutes into a squash, a commit under a compile-and-test `pre-commit` band, and a push to GitLab. Their words: *"i got nothing, no status update, no progressing tracking, nothing, how do i know it's working or not?"*

The shape was wrong, not the rendering. The run was a single HTTP request, so everything about it — that it existed, what it was doing, how it ended — lived and died with that request. It is a **job** now (`integration-job.ts`): registered when a run starts, moved through `preparing → squashing → committing → pushing` (or `merging` for Merge all), finished with the same summary the caller returns, and readable for ten minutes after it ends. One job per project directory, and a second concurrent run is refused rather than left to interleave two merges into one checkout. It is in memory on purpose: a job outlives no sidecar, and after a restart git is the authority on what landed (ADR-0103), so a job file would only be a staler second answer.

`GET /api/worktrees/job?cwd=` reads that record and touches no git, so the panel polls it every 1.2 s — the list route reconciles every worktree with synchronous git (1.2 s for twelve) and could never be polled. The Worktrees section shows a row while a run is in flight: *"Prepare MR · Squashing 3 of 6 · marvin/tab/fix-flags · 1m 12s"*, *"Committing — running the project's commit hooks · 2m 03s"*, *"Pushing to gitlab · 14s"*. Elapsed time is the load-bearing part: it is what distinguishes working from wedged. The phrasing is pure and tested (`IntegrationJobStatus`, 11 assertions). Because the record is the sidecar's, the panel's own refresh **finds** a run started before this app launched, and the outcome reaches the user even when the HTTP call timed out, the project was switched, or the app was relaunched.

**A commit that claimed six branches and carried one.** The same run stopped at a conflict on the second branch, which is correct and documented — and then committed with the message built from the branches *asked for*, pushed it, and opened merge request !209 titled `chore: integrate 6 branches` holding one branch's six files. Two changes. A generated message is now built after the loop from the branches that actually applied (a message the user typed is theirs and is never rewritten). And a run that stopped at a conflict **does not push**: ticking six branches and "open a merge request" means one request for six, so a partial push misrepresents the work to a reviewer and spends a pipeline on something that must be redone once the conflict is resolved. The branch is on disk, the summary says which branch stopped it, and the remedy is named — Sync that branch, run Prepare MR again.

Both were invisible for the same reason: nothing reported what the run did. Fourteen tests — six on the job record, two on the honest message and the withheld push, the rest as before.


## Amendment — 2026-09-12: a tab branch is never published by MARVIN

**What happened.** Two tabs, each on its own `marvin/tab/…` branch, each
pushed that branch and ran `glab mr create`. The metered-CI confirm fired both
times and was allowed both times; GitLab has !215 and !216, one pipeline each,
for work that Prepare MR (the 2026-09-10 amendment) folds into one. User:
*"we need to make sure our multi session merge only locally."*

**Why a confirm was the wrong tool.** The confirm exists for a decision the
user might make either way — opening a request on their own branch. In a
worktree tab there is no either way: the branch is MARVIN's integration
artefact, and publishing it alone is always the expensive path. A question the
answer to which is always "no" is a deny with a better message.

**What changes.** `localOnlyIntegrationPolicy`, ahead of the metered-CI
confirm on both permission ladders, main loop only:

- **worktree tab** — any `git push`, and any `glab mr` / `gh pr` create or
  merge (including `-o merge_request.create`) → **deny**, naming the tab's
  branch and the two local paths (Merge on close, Merge all / Prepare MR).
- **shared tab** — a push or request that names a `marvin/…` branch → deny.
  The user's own branch keeps the normal ladder; `glab mr create` on it still
  reaches the metered-CI confirm, which is theirs to answer.
- **subagents** — untouched; an implementer has ADR-0081's own containment.

The prompt says the same in the implementer protocol, extended to the tab's
own branch. `git push` of the user's own work stays ungated, as the 2026-09-10
decision above argues.

### Scope of Done

- Four tests in `session-worktree-gate`: every push and request form denied
  in a worktree tab with Prepare MR named; reads and local merges untouched;
  a shared tab denied only when a `marvin/` ref is the thing published; the
  gate denies without opening a confirm card. Full suite green.

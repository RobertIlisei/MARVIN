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

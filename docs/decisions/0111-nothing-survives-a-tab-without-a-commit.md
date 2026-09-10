# ADR-0111 — Nothing survives a tab unless it holds a commit; integration previews conflicts, and the owning session resolves them

- **Status:** Accepted — in implementation 2026-09-10
- **Date:** 2026-09-10
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (one worktree per tab; the close dialog this amends), [ADR-0109](./0109-batch-integration-and-metered-ci.md) (Merge all, Prepare MR, the metered-CI confirm — this builds on them, it does not replace them), [ADR-0103](./0103-implementer-branch-lifecycle.md) (the derived lifecycle and the sweep), [ADR-0102](./0102-multiple-sessions-one-worktree.md)

## Context

The user, after a day and a half on per-tab worktrees:

> *"i believe we can easily create multiple stray branches if we just click a
> new shared session and the type something, stop it, close it and the branch
> just remains there. Also managing work when we finish multi session is not
> clean, it's hard to merge multiple branches from multisession into 1 branch
> for a push and MR. If we are to do this we need to do it properly."*

Measured on their project before writing this:

| Session worktrees on disk | 17 |
|---|---|
| for closed tabs | 16 |
| state `merged` (work already integrated, checkout and branch still present) | 12 |
| state `empty` (zero commits — the "type, stop, close" case) | 3 |
| state `ready` (9 real commits from a closed tab, integrated nowhere) | 1 |
| removed by any automatic path since ADR-0107 shipped | 0 |

Every one of the 17 is a full checkout of the repository. ADR-0107's rule
table said a closed tab with no commits derives to `empty` and is swept; a
closed, merged tab is swept too. Both derivations are correct. The sweep runs
from one button in Source Control ▸ Worktrees and from nowhere else.

Three causes, in order of how much each explains.

**1. "Reclaim silently" kept the branch.** `TabCloseDecision` classifies an
empty, clean tab as `reclaimSilently` — ADR-0103's own rule, and the one
Anthropic's CLI applies on exit ("for an unnamed session, Claude removes the
worktree and its branch automatically"). The client then sent `keep` to
`/api/sessions/close`. The silent path silently kept it. This is the user's
sentence, verbatim.

**2. The close decision was made from the wrong inputs.** The client decided
with `worktreeState: nil`, files-changed standing in for commits, and
untracked-count standing in for dirty. The sidecar derives the real state on
every reconcile (`ready` / `empty` / `merged`, commits, dirty); the watch row
never carried it, so the client guessed — and a `merged` tree, which the rule
treats specially, could never be recognised as one.

**3. Integration had no preview and no path through a conflict.** ADR-0109
gave the day's branches one act — **Merge all** locally, or **Prepare MR** as a
squash — and stops at the first conflict, correctly. What it leaves the user
holding is the conflict: a branch cut from an older HEAD, a merge aborted in
the main checkout, and no tool that knows what that branch was trying to do.
The research report behind ADR-0107 listed "a merge step back" as the cost of
per-tab worktrees and "merge-back cost for two to three sessions" as an open
question. This is the answer arriving as experience.

Two smaller facts from the same audit. Branch names come from the first
message, which is why the project holds seven branches called
`plan-the-implementation-of-this-backlog` and two named after an attachment
path; the name is decided before the branch has anything in it. And a message
to a closed tab whose branch was already integrated reopens that same, stale
worktree.

## Decision

One principle: **a tab is a unit of work, its branch is a unit of integration,
and integration is an explicit act — never a side effect of closing a tab.**

### 1. Nothing survives a tab unless it holds a commit

The close decision is remade from the sidecar's derived state, fetched at the
moment of closing (`worktree` on the watch row: state, commits, dirty, base,
behind), never from the client's guess.

| Tab | Close does | Asks |
|---|---|---|
| shared checkout, or a draft | closes | no |
| turn in flight | offers to stop the turn first | yes |
| worktree with 0 commits, clean | **discards** checkout and branch | no |
| worktree already `merged`, clean | **discards** checkout and branch | no |
| worktree with 0 commits, dirty | keep as a WIP commit · discard the changes | yes |
| worktree with commits | **keep for integration** (default) · merge into *the named current branch* · discard | yes |

Merge stays in the dialog because ADR-0109 chose close time as the place a
session tree gets its decision and shipped fixes for that path the same day;
what changes is that Keep is first and default, and the merge option **names
the branch it would merge into**, which was the confusion. "Keep" on a dirty
tree commits the work first, so nothing kept is ever lost to a later sweep.

The sweep runs **at sidecar boot** for every registered project and **after
every close**, bounded and best-effort, under the guards ADR-0103 already
enforces: never a tree with uncommitted or untracked work, never `ready`,
never a live one. Anthropic's periodic sweep applies the same two guards.

### 2. Integration previews conflicts before touching anything

`previewIntegration` runs `git merge-tree --write-tree` (git ≥ 2.38; the
machine has 2.50) for every `ready` branch against the current branch and
reports, per branch: commits, lines, how far behind the target it sits, and
the files that would conflict. Nothing is checked out, nothing moves. Merge
all and Prepare MR read the same preview, so the first conflict is known
before the first merge, not discovered at the third.

### 3. The session that owns a branch resolves its conflicts

A branch that is behind, or would conflict, gets **Sync with target**: one
turn in that tab's own worktree, dispatched through the resume path
(`resumeSession` with a fixed prompt), whose job is to merge the target into
the branch, resolve every conflict, run the relevant tests, and commit the
merge — never push. That session has the whole context of its own changes; the
user in the main checkout has none of it. After a sync the branch integrates
cleanly under Merge all or Prepare MR. The action is also offered while a tab
is still open, so a long-running tab never drifts far from its base.

### 4. The Sessions pane is the workbench

A **Ready to integrate** section lists closed tabs whose branch holds work,
with the preview's verdict per row (clean · behind by N · conflicts in M
files), and the actions Sync · Merge into *branch* · Discard. Its footer
offers Merge all and Prepare MR, which are ADR-0109's flows unchanged. Source
Control ▸ Worktrees remains the low-level view. The watch universe now
includes closed sessions whose worktree is `ready`, so a branch with work in
it cannot fall out of sight by closing its tab.

### 5. A branch is named by its first commit, not its first message

Before a commit exists the name is irrelevant, because rule 1 means the branch
will not survive. On the first turn that ends with a commit on the branch,
MARVIN renames it `marvin/tab/<slug of the first commit subject>` (unique
among live refs), keeps the directory as it is, updates the record and the
session meta, and announces `session.tree` so the chip follows. Once.

### 6. Reopening an integrated tab starts fresh

A message or wakeup into a closed tab whose branch is `merged` gets a new
worktree cut from the current HEAD, on a new branch; the old tree is left for
the sweep. Reopening a kept `ready` tab returns to it, as before.

### Considered and not taken

- **Removing Merge from the close dialog entirely.** Cleaner in principle;
  rejected for now because ADR-0109 argued the opposite and shipped on it the
  same day. Naming the target branch removes the confusion that made it
  harmful. Revisit if the audit repeats.
- **Creating the worktree on the first write instead of the first message.**
  Would avoid the branch rather than clean it up. Rejected: a turn's cwd is
  fixed at turn start, and rule 1 makes the leftover free.
- **Rebase instead of merge for Sync.** Rewrites history a tab may have
  already pushed for safety (ADR-0109 encourages pushing freely). Merge keeps
  every pushed commit valid.
- **An integration worktree so the main checkout need not be clean.** Prepare
  MR already does this for the squash path; Merge all deliberately targets the
  checked-out branch. Not duplicated here.

## Consequences

- The 15 sweep-eligible trees on the user's disk vanish at the next boot.
- Closing an empty tab leaves nothing, in any mode, with no dialog.
- A conflict is visible before any merge runs, and has an owner and a button.
- Branch names describe the work. The seven `plan-the-implementation…` names
  would have been seven different commit subjects.
- Sync dispatches a model turn that runs git and tests; it obeys the session's
  posture and gates like any wakeup, and the metered-CI confirm (ADR-0109)
  still stops it from opening a request.
- `git merge-tree --write-tree` needs git 2.38; older git reports the preview
  as unavailable and the flows behave exactly as under ADR-0109.

## Scope of Done

- [ ] M1 — close: silent reclaim discards; decision from fetched sidecar state; keep commits WIP; Merge names its target; sweep at boot and after close
- [ ] M2 — `previewIntegration` with merge-tree; `POST /api/worktrees {action:"preview"}`; `POST /api/sessions/sync` through `resumeSession`
- [ ] M3 — Sessions pane: Ready to integrate section, row verdicts and actions, footer to Merge all / Prepare MR; watch universe includes closed `ready`
- [ ] M4 — branch renamed from the first commit subject, once, with `session.tree` announced
- [ ] M5 — reopening a `merged` tab cuts a fresh worktree
- [ ] Docs: ADR-0107 and ADR-0109 amended; worktrees guide close and integrate sections; roadmap
- [ ] Tests green: sidecar suites (`session-worktrees`, `session-watch`, new `integration`), Swift (`tab-close-decision` rewritten, `session-ledger`)

# ADR-0113 — The backlog is the shared task list: claimed, read live, and announced when it moves

- **Status:** Accepted — implemented 2026-09-11
- **Date:** 2026-09-11
- **Related:** [ADR-0044](./0044-project-backlog.md) (the store), [ADR-0047](./0047-backlog-capture-at-discovery.md) (auto-capture), [ADR-0070](./0070-backlog-capture-bar-and-duplicate-gate.md) (the near-duplicate gate this extends), [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (one worktree per tab; the isolation that hides the store), [ADR-0069](./0069-never-drop-a-user-message.md) / [ADR-0076](./0076-mid-turn-steering-streaming-input.md) (the queue and injection a notice rides), [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md)

## Context

Two isolated tabs fixed the same defect on the same afternoon, with identical diffs, one of them shipping a 365-line regression test the other never saw. The session that noticed, in its own words: *"my worktree was cut from cdedb71 and is isolated — I never saw that item or that commit; I re-derived and re-fixed the same defect independently … neither of my sessions knew about the other."* The user: *"seems like we have issues, either the backlog items are not actually updated / created correctly."*

The transcripts settle what happened:

| Time | Tab | What it did |
|---|---|---|
| 17:41:21 | test-persistence | `backlog_list` — nothing relevant |
| 17:41:47 | test-persistence | `backlog_add` — the item, status **open** |
| 17:42:52 | fix-customdomain | `grep -rln advisory_xact_lock .marvin/backlog/` **in its own worktree** — nothing — started fixing |
| 17:54:53 | test-persistence | `backlog_resolve done` — open straight to done |
| 20:36:51 | fix-customdomain | first `backlog_list`, three hours later |

Three facts, none of them a bug in either tab.

**The store lives in one place and the copies lie.** `backlog-mcp` writes to `<workDir>/.marvin/backlog/` — the project root, per ADR-0107 — and the item was created there, untracked. Every worktree carries a `.marvin/backlog/` checked out from its cut commit. A tab that greps that directory reads a snapshot; the file it needed did not exist in any worktree. Nothing told the model the copy was stale, and nothing stopped it reading it.

**Nothing claims.** The store has a `doing` status and the model has no tool that sets it: the tools are add, list, resolve and groom. The item went open → done without ever being doing. Even a live listing at 17:42 would have shown an unclaimed open item, which is exactly what a session should pick up. The panel's *Plan* action does flip an item to doing, but records no holder, so `doing` said "someone" and never "which tab".

**Nothing tells a sibling.** When the item was resolved, the other tab was mid-fix in the same file with no channel to hear it.

Anthropic's documentation describes both halves of the remedy. For teams: *"Tasks have three states: pending, in progress, and completed"*, teammates *"pick up the next unassigned, unblocked task"*, and *"task claiming uses file locking to prevent race conditions"*; the guidance on overlap is *"break the work so each teammate owns a different set of files"*. Agent teams themselves are unavailable in SDK sessions. For sessions you run yourself, cross-session messaging (v2.1.224+, present in the 2.1.267 MARVIN spawns) exists to *"coordinate parallel worktrees: … Claude can tell the other sessions what landed"*; a message *"never counts as your consent"*. Its socket lives only while a session's process runs, and MARVIN's turns are separate processes, so MARVIN carries the same idea on its own queue.

## Decision

**The backlog is the shared task list. An item is claimed by the tab working it, read only from the live store, and its resolution is announced to the tabs it touches.**

### 1. Claims

An item gains `claimedBy` (session id), `claimedBranch` and `claimedAt`. `backlog_claim {id}` moves open or provisional to **doing** with the caller as holder; a second claimant is refused and told who holds it. `backlog_resolve` releases. The index line and `backlog_list` read `[doing · tab: fix-the-thing]`. The panel's *Plan* action claims for the tab it plans in; a *Plan* on an item another tab holds offers **Switch to that tab** or *Plan anyway*. The Sessions pane row says what its tab holds.

`backlog_add` already refuses a near-duplicate of a live item (ADR-0070). When the live item is **doing**, the refusal names the holder: *"already being worked in tab fix-the-thing"*. That sentence is the one that would have stopped the second fix.

### 2. One live store

In a tab with its own worktree, the `.marvin/backlog/` under the worktree is a snapshot and is never the answer. A `Read`, `Grep`, `Glob` or `Bash` aimed at it is turned back, in every permission mode, with the instruction to use `backlog_list`; the per-turn session context says the same, and asks the model to check for a holder before fixing something it found on its own. The root's copy remains readable by absolute path — that is the live store.

### 3. A notice when a claim moves

When a tab resolves an item, MARVIN composes one short notice — title, resolution, the paths the item names — and delivers it to every other live tab of the project whose branch touches one of those paths (or, when the item names none, to every live tab): injected mid-turn where a turn is running (ADR-0076), queued for the next turn otherwise (ADR-0069). One notice per resolution, never a turn started to deliver it, and it is marked as coming from another tab so it cannot read as the user's word.

### Considered and not taken

- **Symlinking `.marvin/backlog` into worktrees.** It is tracked in the repository, so a symlink is a type change git would carry onto every tab branch. Rejected.
- **Committing items when they are written.** A commit on the user's checkout is theirs to make (ADR-0102, ADR-0107). Untracked-until-committed is fine once every reader uses the live store.
- **Anthropic's socket messaging directly.** The socket exists only for the life of a turn's process; MARVIN's queue and injection already cover both the live and idle cases, and are what the client renders.
- **Locking the claim with a file lock.** Claims here are single-process writes through the sidecar; the refusal-on-conflict is the lock.

## Consequences

- A tab that starts a fix it discovered sees the holder if one exists, and parks its own discovery so the next tab sees it.
- The seven tabs opened from the backlog panel each hold their item; opening an eighth on a held item asks first.
- The gate refuses a read that has been silently wrong since ADR-0107 shipped; the model is told the right call in the refusal.
- Items still land untracked in the root; the user's commits carry them, as before.

## Scope of Done

- [x] M1 — store: claim fields, `claimBacklogItem` / release on resolve, holder in the index and duplicate reply; MCP `backlog_claim`, listing and add wording, branch in the tool context; snapshot-read guard; session-context sentence
- [x] M2 — panel: *Plan* claims for its tab, held items show the holder with Switch; `/api/backlog` claim; Sessions row shows the held item; watch row carries claims
- [x] M3 — resolution notices to touching tabs via inject or queue
- [x] Docs: ADR-0044 amendment, worktrees guide, roadmap

## Verification (2026-09-11)

- `backlog.test.ts` 49/49 (claims: second claimant refused with the holder; resolve releases; index line and listing carry `tab: <branch>`; a same-slug re-add and a near-duplicate of a doing item both answer with the holder), `backlog-notify.test.ts` 3/3 (live tab injected, idle tab queued, a tab whose branch touches none of the item's paths skipped, the sender never notified, cap honoured), `session-worktree-gate.test.ts` (snapshot reads denied for `Read`/`Grep`/`Glob`/`Bash` in every mode; the root's copy readable).
- Swift: 826 assertions across all suites; `BacklogService` decodes the holder and `held` refusal; the panel badge reads `in progress · tab: <branch>`; *Plan* on a held item shows the Switch / Plan-anyway dialog.
- Not yet live-checked: two rebuilt tabs racing on one item.


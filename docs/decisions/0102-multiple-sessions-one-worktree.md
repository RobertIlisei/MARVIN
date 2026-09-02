# ADR-0102 — Multiple sessions in one worktree: surface the collision, don't isolate

- **Status:** Accepted — implemented 2026-09-01
- **Date:** 2026-09-01
- **Related:** [ADR-0081](./0081-implementer-subagents-on-isolated-worktrees.md) (worktrees as the isolation primitive), [ADR-0077](./0077-ai-native-sdlc-selective-adoption.md) (Golden Rule 1 forbids model-dispatching-model, not "more than one session"), [ADR-0069](./0069-never-drop-a-user-message.md) (the live-turn registry and its `mutated` flag), [ADR-0040](./0040-interactive-ask-user-question.md) (a gate that reaches the user in every permission mode), [ADR-0062](./0062-update-constraints-loop-identified-mitigated.md) (the crash that made the incident visible)

## Context

On 2026-09-01 the user ran two MARVIN sessions against one checkout of
`~/Projects/agri-saas-platform` — one triaging dependency MRs on GitLab, one
hotfixing a production container — and reported: *"now the 2 sessions are
interconnected, they are not separate anymore"*, then killed one of them.

Measured before theorising, per the rule that section of `CLAUDE.md` exists to
enforce. **The conversations were never interconnected.** No SDK session id
appeared in more than one transcript:

| MARVIN session | SDK session | opened with |
|---|---|---|
| `46624ea3` | `41b6e7ee` | "review the chore MRs opened on gitlab" |
| `a7382d02` | `7a83431d`, then `42eef37c` | "agricore-api container is having issues and hotfix" |

What they shared was the working tree, and its reflog is the whole story:

```
checkout: moving from dep/errorprone to chore/dependabot-mr-triage-2026-09-01
rebase (start): checkout gitlab/main
checkout: moving from chore/dependabot-mr-triage-2026-09-01 to dep/openapi-fetch
```

The triage session branch-hopped and rebased while the hotfix session was
reading and editing the same files. Neither session did anything wrong. A git
worktree has exactly one HEAD, and one session moved it out from under the
other.

**The user's requirement is explicit and was reaffirmed:** multiple sessions in
one worktree must keep working. So "use a worktree" — Golden Rule 1's own
remedy, and Claude Code's documented isolation — is not available as the
answer here.

### What the documentation actually supports

Claude Code's [worktrees guide](https://code.claude.com/docs/en/worktrees)
recommends one checkout per session, and the desktop app does it automatically.
But it is not the only supported shape. **Agent teams run multiple full Claude
Code sessions in a single shared directory by design**, and the
[guide](https://code.claude.com/docs/en/agent-teams) says how they survive it:

> Agent teams don't isolate teammates in worktrees, so partition the work so
> each teammate owns a different set of files.

> **Avoid file conflicts** — Two teammates editing the same file leads to
> overwrites. Break the work so each teammate owns a different set of files.

> Task claiming uses **file locking** to prevent race conditions when multiple
> teammates try to claim the same task simultaneously.

So the sanctioned pattern for N sessions in one tree is **partitioned ownership
plus a lock on the shared coordination state** — not isolation, and not
refusal. That is a mechanism worth taking. The *topology* around it is not:
agent teams are a lead dispatching teammates, which is precisely what Golden
Rule 1 forbids. MARVIN takes the guardrail and leaves the hierarchy; the human
stays the only coordinator.

## Decision

**Support several sessions in one worktree, and make the collision visible at
the instant it would happen.**

A new gate, `maybeSharedTreeConfirm` in `sdk-runner.ts`, fires when all three
hold:

1. The call is a `Bash` command that **moves HEAD or rewrites the tree**
   (`classifySharedTreeRisk`, a pure classifier in `@marvin/tools/shared-tree`).
2. **Another session in the same project has a turn running right now**
   (`listLiveTurns`, new on the ADR-0069 registry).
3. A UI is attached to answer.

It then raises a confirm that names the other session and what the command
would do to it. Allow proceeds; deny steers to a worktree.

Three design points carry the weight:

**It reaches the user in every permission mode.** MARVIN's default is `auto`,
which bypasses the `confirm` class wholesale (`sdk-runner.ts` — "auto-mode
bypass"). A guard that only prompted under `gated` would not have prevented the
incident that motivated it. This is why the gate sits beside `maybePlanApproval`
and `maybeAskUserQuestion` at the top of the callback rather than inside
`toolPolicy`: those two established the "reaches the user regardless of
strategy" shape, and this is the third member of that family.

**It is silent for a single session.** Condition 2 is the whole reason this is
tolerable. Every solo turn — the overwhelming majority — never sees it. A guard
that fired on ordinary work would be switched off within a day, and then the
protection would be worth nothing.

**With no UI it denies rather than runs.** A wakeup or background-job turn has
nobody to ask. An unattended turn is the worst possible one to let move HEAD
under a session the user is actively watching, so it is refused with a message
naming the escape.

### What is deliberately NOT gated

Ordinary edits. Two sessions editing different files is exactly the case the
user wants to work, and the ownership-partitioning advice above is guidance a
regex cannot enforce. Gating `Edit` on co-tenancy would make the shared-tree
workflow unusable, which would defeat the purpose.

`git commit`, `git add`, `git push`, `git fetch` and every read-only git
command are also untouched: they change this session's work or the remote, not
what the other session is looking at.

## Consequences

- Two sessions in one tree is now a **supported** configuration rather than an
  undiagnosed hazard. The failure mode that produced "they are not separate
  anymore" is caught at the command that causes it.
- The gate over-matches a risky verb quoted inside another command
  (`echo "git checkout ..."`), because it is substring regexes like the rest of
  `policy.ts`. Pinned by a test rather than fixed: a false positive costs one
  confirm, a false negative reinstates the incident. Revisit only alongside
  real command parsing.
- **Not built: a passive always-on indicator** of who else is in the tree. The
  confirm names the conflicting session at the only moment it matters, and the
  announce stream carries turn *starts* but no turn *ends*, so a live roster
  would need new plumbing. Deferred deliberately rather than guessed at.
- The classifier is the single place the risky-verb list lives. Adding a verb
  is a one-line change with a test beside it.

## Scope of Done

- [x] `classifySharedTreeRisk` classifies HEAD-moving, history-rewriting and
      worktree-rewriting git commands, and ignores read-only and
      session-local ones (43 assertions, both directions).
- [x] `listLiveTurns(projectId)` returns only turns that have not ended —
      `endLiveTurn` keeps a finished turn in the map for a 60 s reconnect
      grace period, so presence in the map is not liveness.
- [x] The gate fires in `auto` and `gated` mode alike, and is a no-op for a
      solo session, a read-only command, a turn in another project, and a
      co-tenant whose turn has finished (7 assertions on the real
      `makeAutoModeLogger`).
- [x] With no `onConfirmRequest` the call is denied with a message naming the
      worktree escape, not allowed and not hung.
- [x] The confirm reason names the other session id and what the command does
      to it.

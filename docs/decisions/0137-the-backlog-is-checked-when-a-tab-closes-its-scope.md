# ADR-0137 — The backlog is checked when a tab closes its scope

- **Status:** Accepted (2026-11-24); part 3 below is decided and not built
- **Amends:** [ADR-0113](./0113-the-backlog-is-the-shared-task-list.md) (claims), [ADR-0105](./0105-practice-loop.md)'s turn-close hook
- **Related:** [ADR-0044](./0044-project-backlog.md), [ADR-0047](./0047-backlog-capture-at-discovery.md)

## Context

The owner's idea, 2026-11-24: when MARVIN finishes a piece of work it should look at the backlog and see whether that work is in it, and whether the item can be closed.

Two things already go wrong without it. A tab claims an item (`doing`, ADR-0113), does the work, says scope met, and the item stays `doing` for ever: a backlog audit on a real project found items long finished and never closed. And work that plainly finished an open item nobody had claimed does not close it, so the same follow-up is filed again by the next tab that notices it.

The opposite failure is worse: an item closed because the work "looked related". A closed item that is not finished disappears from every list.

## Decision

**At a scope-met close the turn-close hook reads the project's backlog and does two things, neither of which closes an item.**

1. **Claimed items are a gate.** If the session still holds `doing` items when it claims scope met, the close is blocked with their ids: resolve each with the evidence (the commit, the test) or release it to open with what remains. Machine turns included; ADR-0104's brake (two blocks, then the close is let through and logged).
2. **Unclaimed look-alikes are a suggestion.** Open items nobody holds whose text names a file this turn edited are listed, at most three, once per turn, with the instruction to read them and resolve only what the work really finished. The match is the file path as the item wrote it; title similarity is not used, because at a close it would offer every item about the same screen.
3. **An item resolved from a branch that has not merged is "done, waiting to merge", not done** (decided, not built). The tab's work can still fail its merge or be discarded. This needs a recorded resolving branch on the item and a derived state at read time, the way ADR-0103 derives a worktree's; it changes the item format and the backlog panel, and is left for its own change.

The hook never calls `backlog_resolve`. The model does, with evidence, or the user does.

## Alternatives considered

- **Resolve matching items automatically.** The failure this ADR exists to avoid.
- **Match on title similarity** (`backlogSimilarity`, used for duplicates at add time). Good between two items; too loose between an item and "what this turn touched".
- **Check at every turn end.** A tab ends many turns waiting on a job; the claim is only contradicted when it says it is done.

## Consequences

- A tab cannot leave a claim behind silently. The cost is one continuation at the close when it tried to.
- The suggestion can be wrong (a file many items mention). It says so, appears once, and leaving the item alone is a complete answer.
- `backlog.close.block` / `.bypass` / `.suggest` telemetry says how often each fires.

## Scope of Done

- A scope-met close with a claimed `doing` item is blocked twice and names the item; the third attempt passes: test `the Stop hook blocks twice on claimed items…`.
- A close with no claim and an open item naming an edited file gets one suggestion that tells the model to leave the item unless the work finished it.
- A turn that does not claim scope met is never touched; a backlog read failure never blocks a close.
- `backlogCloseCandidates` picks only this session's `doing` items and only open, unclaimed, path-matching items: test `candidates: …`.
- Part 3 is listed in the roadmap as not built.

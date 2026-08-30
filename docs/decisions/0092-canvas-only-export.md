# ADR-0092 — Export the canvas, not 34,463 notes

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0091](./0091-vault-plans-canvas-and-the-memory-loop-input.md) (added the canvas), [ADR-0090](./0090-vault-live-views-and-graph-note-filter.md) (filtered the notes from the vault), [ADR-0086](./0086-dependency-bootstrap-and-update-check.md) (made `graphify-out/` visible)

## Context

The user ran `obsidian_init` and MARVIN's file tree reported **"Tree truncated
— 20,000 entries shown"**. `graphify-out/obsidian/` held **34,463 files**: the
entire tree budget, consumed by one command.

Three of my own changes lined up to cause it:

1. **ADR-0086** made `graphify-out/` visible in the file tree (the user could
   not see it), skipping only its known bulk subdirectories.
2. **ADR-0091** added `exportGraphCanvas` — and **never switched the call
   site**. `obsidian_init` still called `exportGraphNotes`, the one that writes
   a note per graph node. The canvas function was dead code; the ADR claimed a
   behaviour that was not wired.
3. `graphify export obsidian` has **no canvas-only flag** — it emits the canvas
   and the notes in one run — so even the "right" function wrote all 34k files
   and relied on a filter to hide them.

This is the same failure that got `cache` skipped on 2026-08-15 (12,195 files
truncating the tree), in a directory that did not exist then.

## Decision

**1. Don't create them.** `exportGraphCanvas` stages the export in a temporary
directory, copies out `graph.canvas`, and removes the staging directory in a
`finally`. The project gets one file. Filtering generated bulk out of the tree
is a plaster; not writing it is the fix.

**2. Wire it.** `obsidian_init` calls `exportGraphCanvas`, and
`exportGraphNotes` is **deleted** rather than left unused — an unused function
that writes 34k files is precisely the trap that produced this bug.

**3. Keep the belt.** `graphify-out/obsidian/` joins `GRAPHIFY_OUT_SKIP`, so a
user who runs `graphify export obsidian` by hand does not truncate their tree.
`graph.canvas` is a file, not a directory, so it stays visible.

## Consequences

- `obsidian_init` leaves one 9 MB canvas instead of 34,463 files.
- The tree stops truncating; the 20,000-entry budget goes back to real source.
- The existing 34,463 notes on the affected project were deleted (generated,
  gitignored, reproducible), the canvas kept.

## Scope of Done

- [x] Canvas staged in a temp dir; only `graph.canvas` copied into the project
- [x] `obsidian_init` calls it; `exportGraphNotes` removed
- [x] `graphify-out/obsidian/` skipped by the file tree, test-pinned
- [x] The affected project cleaned up, canvas preserved
- [ ] Not in scope: a canvas-only flag upstream in graphify

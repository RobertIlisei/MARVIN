---
description: Distill a bloated .marvin/memory.md into durable-fact files + archive the rest (ADR-0042).
---

Compact the active project's project memory into the curated durable-facts
layer defined by [ADR-0042](../../docs/decisions/0042-memory-as-durable-facts.md).
Run this when `.marvin/memory.md` has grown into an append-log of per-turn Ship
dumps (the failure mode: a real project hit 419 KB, ~99% redundant with
ADRs/git/changelog).

**Operate on the ACTIVE project's `.marvin/`, never MARVIN's own repo.**

Steps:

1. **Read** `.marvin/memory.md`. Separate it into:
   - the curated **index** at the top (one-line links/hooks), and
   - the **append-log** of dated entries below.

2. **Distill durable facts.** Scan every entry for things the next session
   genuinely cannot re-derive from ADRs, git, or the changelog — invariants,
   gotchas, hard constraints, external facts of record. For each, call the
   **`remember`** tool (`name`, one-line `hook`, optional short `body`, `type`).
   `remember` dedupes by name and rebuilds the index, so re-running is safe.
   - Do NOT re-record: what was implemented (→ git/changelog), decisions
     (→ ADRs — write/confirm the ADR instead), or verification/commit status
     (`tsc clean`, `vitest N/N`, `committed`/`NOT pushed`) — these are noise.
   - When unsure whether an entry is a durable fact, it almost always isn't.

3. **Archive the remainder.** Move the original append-log to
   `.marvin/memory.archive.md` (create it, append the old entries with a dated
   header). Every archived entry is reconstructable from ADRs/git, so this is
   safe — but archive rather than delete on the first pass so nothing is lost.

4. **Verify.** `.marvin/memory.md` is now the clean `# Project Memory Index`
   that `remember` maintains (one line per fact). Report: facts kept, entries
   archived, and the before/after size of `memory.md`.

5. **Reconcile** (optional): note whether `graphify-out/memory/` (graph
   `graph_save_result` Q&A cache) overlaps any kept fact; they are distinct
   stores (durable facts vs machine query cache) and both are fine to keep.

This is memory's analogue of context compaction — re-run it whenever the index
drifts back toward a log.

# ADR-0042 — memory.md as a curated durable-facts layer (not an activity log)

**Status:** Accepted — 2026-06-14
**Touches:** `personality.ts` (firm surface for what memory IS / IS NOT),
a new `marvin-memory` in-process MCP tool (`remember`/`recall`), the native
"Save to memory.md" chip (`MemoryLog` / `ScopeMetSummary`), `project-context`
injection (already budgeted in ADR-0041), and the knowledge-graph indexer
(ADR-0028). A `/memory-compact` command for migration. Builds on the project-
graph lifecycle + context budget (ADR-0041) and cross-session continuity
(ADR-0022).

## Context

`.marvin/memory.md` is MARVIN's only sanctioned cross-session memory (Golden
Rule 4 / ADR-0022). An audit of a real project (`agri-saas-platform`,
2026-06-14) found it had become **419 KB / 336 lines in ~9 days**, and that it
is two incompatible things in one file:

- a **curated index** at the top (6 one-line fact hooks pointing to per-fact
  files) — the right idea, but **5 of 6 linked files don't exist** (abandoned);
- **196 dated "Ship dumps"** below it — median **1,034 chars**, up to 6,041 —
  each a full implementation + verification trail of a turn.

Redundancy is near-total: **194/196 entries reference an ADR**, 135 mention
`committed`/`pushed`, 108 carry ephemeral status (`vitest 374/374`, `tsc clean`,
`NOT committed/pushed`). I.e. ~99% restates content whose canonical home is
already **ADRs** (decisions), **git** (what changed), or the **changelog**
(release narrative). The genuine signal memory.md exists for — invariants,
gotchas, constraints, external facts — is present but at ~1% density.

This isn't cosmetic: this file is what blew the 200K context window in ADR-0041
(104K tokens injected whole). There is also a second, near-empty memory system
(`graphify-out/memory/` from `graph_save_result`), so memory is fragmented.

**Root causes:** (1) the model ignores the prompt's repeated "one-line"
guidance and mirrors the verbose changelog/ADR entry it just wrote — soft
guidance, no enforcement; (2) append-only, no dedup / rotation / length cap;
(3) the file-per-fact + index pattern was half-built; (4) nothing keeps memory
disjoint from ADRs/git/changelog. (The native chip's `ScopeMetSummary.extract`
is fine — it produces tight one-liners; the bulk noise is the model's own
Ship-phase self-appends via Edit/Write.)

## Decision

**memory holds only what the next session cannot re-derive from ADRs, git, or
the changelog** — distilled invariants, gotchas, constraints, and external
facts. Everything else is banned from it.

1. **Two content classes are forbidden in memory:**
   - per-turn **activity / Ship trails** (what was implemented, diffs, file
     lists) → ADRs + changelog + git already own these;
   - **ephemeral status** (`tsc clean`, `vitest N/N`, `committed/pushed`,
     `NOT committed`) → zero cross-session value.
   Allowed: invariants ("spec is source of truth — backend drift 422s
   silently"), gotchas, hard constraints ("solo build Y1", "no CI/CD Y1"),
   external facts (company/regulatory), and decisions genuinely not captured by
   an ADR.

2. **File-per-fact + index** (finish the abandoned pattern, mirror Claude
   Code's own auto-memory shape):
   - each durable fact → `<workDir>/.marvin/memory/<slug>.md` with frontmatter
     (`name`, `description` hook, `type: user|feedback|project|reference`);
   - `<workDir>/.marvin/memory.md` becomes a **one-line index**
     (`- [Title](memory/slug.md) — hook`);
   - **update / supersede, never blind-append**; dedupe on write; delete facts
     that turn out wrong.

3. **Enforce brevity at the write boundary, not just in prose.** A new
   in-process **`marvin-memory` MCP tool** is the sanctioned write path:
   - `remember({ name, hook, body, type })` — writes/updates the fact file +
     the index line; **rejects** bodies that look like activity/status logs and
     **caps** the hook to one line; idempotent (same `name` updates in place).
   - `recall({ query })` — returns matching facts (thin wrapper over the
     knowledge graph, `scope:"knowledge"`).
   The prompt's firm surface MUST-routes durable facts through `remember` and
   MUST-NOT Edit/Write `memory.md` directly or paste Ship trails into it.

4. **Retrieval through graphify** (extends ADR-0041). Fact files are knowledge-
   graph nodes, so `buildProjectContext` injects only the **index** (small) and
   MARVIN pulls fact detail on demand via `scope:"knowledge"` — same
   titles-up-front / graph-for-detail model as ADRs.

5. **Reconcile the two stores.** `.marvin/memory/` = curated, human-meaningful
   durable facts (this ADR). `graphify-out/memory/` = auto-saved graph Q&A from
   `graph_save_result` (machine cache). Both indexed by the knowledge graph;
   roles documented so neither shadows the other.

6. **Migrate the existing 419 KB.** A `/memory-compact` pass distills the buried
   invariants/gotchas into fact files and **archives the rest** to
   `memory.archive.md` (or deletes — every blob is reconstructable from
   ADRs/git). Ongoing, `/memory-compact` can be re-run to keep memory lean
   (memory's analogue of context compaction).

## Implementation plan (phased)

- **Phase 1 — stop the bleeding (prompt firm surface).** Add a MUST / MUST-NOT
  block to `personality.ts`: memory is durable-facts-only; banned classes
  enumerated; one fact = one line; route through `remember` (Phase 2) — until
  then, append ≤1 line and never a Ship trail. Cheapest, immediate; the
  ADR-0041 injection budget already caps the blast radius.
- **Phase 2 — `marvin-memory` MCP tool + file-per-fact.** Implement
  `remember`/`recall`, the `<slug>.md` writer + index updater, dedup/supersede,
  length + content-class guards. Point the firm surface at it; deprecate model
  Edit/Write on memory.md.
- **Phase 3 — retrieval.** Teach the knowledge-graph indexer about
  `.marvin/memory/`; `buildProjectContext` injects the index only; `recall`
  rides `scope:"knowledge"`.
- **Phase 4 — migration / compaction.** `/memory-compact` command: distill the
  existing log → fact files, archive the remainder, reconcile
  `graphify-out/memory/`. Run it once on `agri-saas-platform` (419 KB → small
  index + a handful of fact files).
- **Phase 5 — native surface.** Re-label "Save to memory.md" → "Remember this",
  writing a fact file via the tool (keeps `ScopeMetSummary`'s good one-line
  distillation as the default hook).

## Rejected alternatives

- **Keep the append log, just cap injection (ADR-0041 only).** Stops the
  overflow but the file still bloats unbounded and stays ~99% redundant; the
  signal stays buried. Necessary but not sufficient.
- **Auto-summarise the whole log every turn with an LLM.** Cost + latency every
  turn, and it re-derives what ADRs/git already hold. Compaction is an occasional
  curation act, not a per-turn tax.
- **Drop memory.md entirely, rely on ADRs/git/graph.** Loses the genuine
  invariant/gotcha layer those don't capture ("how does X subtly break"). The
  fix is to make memory *only* that layer, not to delete it.
- **Two memory systems left as-is.** Fragmentation; users won't know which is
  authoritative. Reconcile instead.

## Scope of Done

- [x] `personality.ts` firm surface: memory = durable-facts-only, banned
      classes enumerated, one-line rule, route via `remember` (MUST/MUST-NOT).
- [x] `marvin-memory` MCP `remember`/`recall` with file-per-fact + index,
      supersede-by-name, hook/body length caps, content-class guards; registered
      in `sdk-runner` (auto-allowed like the graph tools); constructs cleanly.
- [x] `buildProjectContext` injects the memory **index** with `recall`/Read
      guidance (the ADR-0041 tail-budget remains a backstop). `recall` is
      self-contained over `.marvin/memory/` (no hard knowledge-graph dependency).
- [x] `/memory-compact` command distills a log → fact files (via `remember`) +
      archives the rest; `graphify-out/memory/` role documented.
- [~] **Native surface — partial.** The Scope-met chip is made *safe* (retargeted
      to `.marvin/session-notes.md` + relabelled "Save session note") so it no
      longer pollutes / gets clobbered by the index. A first-class native
      "remember a fact" affordance (user text → API route → fact file) is a
      **follow-up**.
- [x] runtime / project-context / web-route `tsc` clean; `swift build` clean.
- [ ] **Migration not yet run on `agri-saas-platform`** (419 KB) — left to the
      user via `/memory-compact` (their project data; opt-in).
- [ ] Knowledge-graph indexer over `.marvin/memory/` fact files — nice-to-have
      so `recall` can also ride `scope:"knowledge"`; `recall` works without it.

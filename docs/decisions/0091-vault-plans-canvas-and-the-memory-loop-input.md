# ADR-0091 — Plans in the vault, the graph as a canvas, and an input for the memory loop

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0090](./0090-vault-live-views-and-graph-note-filter.md), [ADR-0085](./0085-graphify-beyond-search.md), [ADR-0084](./0084-blast-radius-and-pre-ship-impact-nudges.md), [ADR-0065](./0065-obsidian-vault-project-as-vault.md)

## Context

Continuing the graphify + Obsidian audit, three gaps were left, each measured
on the real project rather than inferred.

**1. 353 plans, zero inbound links.** `memory.md` and `backlog.md` each
wikilink their notes — 105 and 47 links — so both are hubs in the Obsidian
graph. `.marvin/plans/` had no index at all: every plan was invisible to the
graph view, to backlinks and to Dataview, while `MARVIN.md` mentioned them in
prose only.

**2. The usable graph export was never wired.** ADR-0090 filtered the
per-symbol note export out of the vault because it writes one file per node
(7,604 for MARVIN's repo, ~32k here). But the same command also emits
`graph.canvas`: **one 1.5 MB file, 6,811 nodes**, which Obsidian renders
natively. Same graph, no flooding — and MARVIN pointed at neither.

**3. The work-memory loop still had no input.** ADR-0085 gave it an output by
injecting `LESSONS.md`. `graph_save_result` remained at **12 calls across every
session ever, and `graph_reflect` at zero**. A loop with no input writes an
empty file.

And separately, from the same audit: `graph_search` was **75 % of 5,823 graph
calls**, largely because it was the only door for several questions.

## Decision

**1. `rewritePlansIndex`** mirrors `rewriteMemoryIndex` — same wikilink form
(markdown links render but create no graph edge, ADR-0065), same
regenerate-in-place contract. Plans carry no frontmatter, so the title comes
from the `# Plan — …` heading and progress from counting `- [ ]` / `- [x]` at
any indent (ADR-0046 sub-tasks are work too). Ordered newest-first: a plans
list is read to find recent work. `MARVIN.md` now names three hubs.

**2. `exportGraphCanvas`** and a `graphCanvas` status flag; the index note
points at the canvas and explains that the notes beside it are filtered on
purpose.

**3. `checkSaveResult`** — one advisory nudge per turn, on the first
`Edit`/`Write` after `SAVE_RESULT_GRAPH_THRESHOLD` (4) graph calls. That is the
moment MARVIN has stopped looking and started acting, so it knows whether the
graph answers held up. Silent once an outcome has been recorded, and on
projects with no graph.

**4. Three more read tools**: `graph_explain` (plain-language node
orientation), `graph_benchmark` (token saving for *this* project, not the
number MARVIN's docs quote from another repo), `graph_export_callflow`
(Mermaid architecture HTML).

### Considered and not taken

- **Running the note export on the user's project.** ~32k files into their
  working tree; theirs to choose. The canvas gives the same information.
- **`neo4j` / `falkordb` / `graphml` / `svg` exports.** Real, but they serve
  external analysis pipelines that do not exist here.
- **`watch`.** Duplicates the ADR-0041 watchdog plus the ADR-0086 git hooks,
  and adds a resident process to own.
- **The `global` cross-repo graph.** Already rejected on Golden Rule 4.

## Consequences

- The vault has three linked hubs instead of two, and a browsable code graph
  that does not flood it.
- The reflection loop can finally accumulate signal; if `graph_save_result`
  stays near zero after a few sessions, the nudge is the wrong instrument and
  should escalate rather than be re-worded.
- Six graph tools were added across ADR-0085 and this ADR. Re-measure the
  per-tool distribution: if `graph_search` is still 75 %, the problem is
  discovery, not availability.

## Scope of Done

- [x] `rewritePlansIndex` + wired into `obsidian_init`; index note links `[[plans]]`
- [x] `exportGraphCanvas` + `graphCanvas` status; index points at the canvas
- [x] `checkSaveResult` nudge, capped, silent after an outcome, test-pinned
- [x] `graph_explain`, `graph_benchmark`, `graph_export_callflow`
- [ ] Not in scope: note export on the user's project; neo4j/falkordb/graphml/svg;
      `watch`; the cross-repo graph

# ADR-0085 — Using graphify for more than search: health, live schema, freshness, and closing the memory loop

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0084](./0084-blast-radius-and-pre-ship-impact-nudges.md) (the triggers), [ADR-0041](./0041-project-graph-lifecycle-and-context-budget.md) (the per-turn watchdog this supplements), [ADR-0066](./0066-graphify-directed-call-index-and-work-memory.md) (the work-memory loop), Golden Rule 7

## Context

ADR-0084 added triggers for two under-used tools. The user asked whether that
was the whole opportunity. Auditing graphify's CLI (~40 subcommands), its
713-line skill and 8 reference docs against MARVIN's 10 MCP tools: **no**.
MARVIN was using graphify as a search index and nothing else.

Measured 2026-08-30 over 5,823 real graph calls: `graph_search` 75 %,
`graph_query` 10 %, `graph_neighbors` 9 %, `graph_summary` 5 %, everything
else ≤0.4 %. Whole capability families had no MARVIN surface at all.

## Decision

**1. Graph health becomes visible.** Two read-only MCP tools:

- `graph_god_nodes` — the architectural hubs a change ripples through, the
  nodes worth running `graph_affected` on before touching.
- `graph_diagnose` — `diagnose multigraph`: same-endpoint edge-collapse risk,
  i.e. where distinct relationships between two nodes were flattened into one
  and the graph is quietly lying about structure. Relevant at 93k edges.

**2. The graph can cross the code/database boundary.** `graph_index_schema`
runs `graphify extract --postgres`, mapping tables, views, functions and FK
relationships into the code graph, so "what reads this table" and "what does
dropping this column touch" become graph questions. The project that prompted
this is 2,216 Java files and 327 SQL migrations over PostGIS, and the graph
knew nothing about the schema.

**Credentials never touch the transcript.** The tool takes the NAME of an
environment variable, not a DSN; if it is unset the tool says so and tells the
model *not* to ask the user to paste one. The DSN is scrubbed from stdout,
stderr and error text before anything is returned.

**3. Freshness outside the IDE.** `bin/marvin graph-hooks [path] [install]`
wraps `graphify hook install`: post-commit / post-checkout rebuild plus the
union merge driver for `graph.json`. ADR-0041's watchdog only runs while
MARVIN is open on that project, so any commit from a terminal or another
editor left the graph stale with nothing to say so. The merge driver also
stops a 93k-edge JSON file conflicting on every branch merge. Verified on
this repo: all three were `not installed`.

**4. The work-memory loop gets its output side.** `graph_save_result
--outcome` and `graph_reflect` have existed since ADR-0066 and measured **12
saves, 0 reflections** — an input with no output, so nothing learned ever came
back. `buildProjectContext` now injects
`graphify-out/reflections/LESSONS.md` when present, bounded to ~1.2k tokens,
with instructions to trust a recorded correction over a first guess. This is
Anthropic's "structured note-taking… persisted outside the context window and
pulled back in later", applied to the graph.

### Considered and rejected

- **The `global` cross-repo graph** (`~/.graphify/global-graph.json`). It
  merges projects into one graph, which is exactly the cross-contamination
  Golden Rule 4 forbids: MARVIN must hold no knowledge of one project while
  working on another. Rejected on the rule, not on utility.
- **`export callflow-html` / `tree` into the Graph pane.** Real value, but a
  UI change with its own design questions; not bundled here.
- **`watch` as a background process.** Duplicates the ADR-0041 watchdog while
  MARVIN is open and adds a second lifecycle to own. The git hooks cover the
  gap the watchdog leaves without a resident process.

## Consequences

- Structural questions can reach the database; graph health is inspectable
  rather than inferred; the graph stays fresh when MARVIN is closed.
- `graph_index_schema` is slow (a full re-extract) and explicitly documented
  as a "when the schema changed" action, not a per-turn one.
- The lessons block costs ~1.2k tokens on first turn, and only once
  `graph_reflect` has ever run.
- Re-measure the per-tool distribution after a few sessions. If the new tools
  stay at 0 %, they need triggers like ADR-0084's, not more documentation.

## Scope of Done

- [x] `graph_god_nodes`, `graph_diagnose`, `graph_index_schema` on `marvin-graph`
- [x] DSN read from a named env var, scrubbed from all output paths
- [x] `bin/marvin graph-hooks` installs/uninstalls/reports graphify git hooks
- [x] `LESSONS.md` injected into project context when present
- [ ] Not in scope: the global cross-repo graph (rejected), callflow/tree
      views in the Graph pane, `watch` as a resident process

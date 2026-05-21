# ADR-0028 — Multi-graph architecture (code + knowledge), federated at the MCP layer

**Status:** Accepted — 2026-05-21 (development branch only; not in stable v0.1.13)
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0023](./0023-brew-distributable-bundled-sidecar.md), [ADR-0024](./0024-project-aware-skill-recommendations.md)
**Related:** [ADR-0027](./0027-macos-26-gatekeeper-user-applications.md)

## Context

MARVIN's knowledge-graph integration shipped as a single per-project graph at
`<workDir>/graphify-out/graph.json`. The graph mixes everything graphify
extracts — AST-derived code nodes, semantically-extracted concepts from docs
and ADRs, project memory references. This worked at small scale.

It stops working at medium scale. On the agri-saas-platform project (a real
user workspace observed 2026-05-21), the single graph reached:

- 4,181 nodes / 5,076 edges / 425 communities
- 365 nodes from `docs/*` alone — `PLAN.md` 163, `docs/adr/` 210, `docs/reference-corpus/` 78
- Semantic extraction produces concept-flavoured nodes per markdown file —
  one ADR can become 30+ nodes
- Some community sample labels reached 325 chars (full ADR titles surfaced
  in the `graph_summary` output)

The downstream effect is autocompact thrashing — MARVIN sessions on that
project hit the context window limit within 3 turns of compaction, three
times in a row. Tighter caps on individual MCP tool outputs help but don't
address the underlying problem: a single graph that mixes "the shape of the
code" with "the intent in the docs" produces summaries that are useful for
neither use-case.

Three structural alternatives surfaced in research:

1. **Single graph with `kind` tags on nodes** — keep one graph, label each
   node by extraction source, filter at read time. Preserves cross-kind
   relationships (a doc that names a code symbol stays an edge in the graph).
   But the bloat returns whenever `graph_summary` doesn't filter by kind,
   and every kind has to be re-summarised separately for clean output.

2. **Subdir-based multi-graph** — run `graphify` inside each subdirectory
   the user wants graph-indexed; each produces its own `graphify-out/`.
   Zero changes to graphify. But messy filesystem layout (multiple
   `graphify-out/` dirs scattered through the repo), and no clean way to
   query "code OR docs" without explicit fan-out.

3. **Multi-graph at well-defined paths, federated at the MCP layer** —
   distinct graph files at known paths (`graphify-out/graph.json` for code,
   `graphify-out/knowledge/graph.json` for everything else). MARVIN's MCP
   bridge takes a `scope` parameter on every read tool and dispatches to
   one or both underlying graphs. Cleanest separation; explicit federation.

Option 3 wins on three grounds:

- **Read summaries stay scoped.** `graph_summary --scope=code` returns
  god-nodes that are real architectural anchors (functions, classes),
  not god-nodes that drown in semantic concepts from prose. Vice versa.
- **Rebuild frequencies match cost.** Code graph is AST-only, cheap, and
  the watchdog already rebuilds it on every commit. Knowledge graph
  requires LLM extraction and must NOT auto-fire — it rebuilds manually
  or scheduled, when the user decides the doc layer has shifted enough.
- **Backwards compatible.** Default `scope: "code"` preserves every
  existing call site; the knowledge graph is opt-in until the user runs
  `bin/marvin knowledge-graph` once.

## Decision

**Two graphs per project, federated at the MCP layer.**

### Graphs

| Graph | Path | Source | Build cost | Rebuild trigger |
|---|---|---|---|---|
| Code | `graphify-out/graph.json` | AST extraction (`*.ts`, `*.swift`, etc.) | Free | watchdog on git HEAD advance (unchanged) |
| Knowledge | `graphify-out/knowledge/graph.json` | docs/, ADRs, `.marvin/memory.md`, top-level READMEs | Free at MVP (AST-only on markdown); future: semantic via opt-in `/graphify` skill | `bin/marvin knowledge-graph` (manual) |

The knowledge-graph build at MVP is AST-only (markdown heading structure
+ link-graph between docs). Semantic depth (LLM-extracted concepts) is
the user's call via `/graphify docs/` if they want it — costs real money,
not appropriate for auto-rebuild.

### MCP federation

All six existing graph MCP tools accept a new `scope?` parameter:

```
scope: "code" | "knowledge" | "all"  (default: "code")
```

- `graph_summary({scope: "knowledge"})` → reads from
  `graphify-out/knowledge/graph.json`
- `graph_search({scope: "all", query: "..."})` → runs against both graphs,
  merges results, tags each hit with its source graph
- `graph_query({scope: "code", question: "..."})` → shells out to
  `graphify query --graph graphify-out/graph.json "<question>"`

Default `scope: "code"` preserves every current call site without change.

### Builder

New `bin/marvin knowledge-graph` subcommand. Wraps a Python script
(`scripts/build-knowledge-graph.py`) that imports `graphify.extract` +
`graphify.build` + `graphify.cluster` directly — the public Python API.
We do NOT shell out to `graphify update` because the CLI hardcodes
output to `<dir>/graphify-out/graph.json` and gives no `--output` flag;
the Python API lets us write to `graphify-out/knowledge/graph.json`
without the subdir trick.

Default input files for the knowledge graph (per project):

- `**/*.md` (excluding the standard `.graphifyignore` set)
- `**/*.adoc`, `**/*.rst`
- `docs/`, `.marvin/memory.md`, project-root README

Same `.graphifyignore` honoured as the code graph (single source of
truth for project-level exclusions). Files end up in different graphs
based on extractor selection, not based on ignore rules.

### What we explicitly do NOT do (yet)

- **Cross-graph label-based joins.** Tempting but lossy on common
  identifiers (`get()`, `string`); needs identifier normalisation work
  that's separate from this PR.
- **Tool-history graph** (what MARVIN has done). Huge volume, mostly
  noise, privacy-fraught. Wait until a specific need arises.
- **4+ graph splits.** Published agent-routing studies show classifier
  accuracy drops below 70% past 3 buckets; 2 is the sweet spot.
- **Auto-rebuild of the knowledge graph.** LLM-extraction cost would
  burn the credit balance on every doc edit. Manual or scheduled only.
- **Cask bump.** The development branch is opt-in. Stable v0.1.13 cask
  is unchanged; users on `brew install --cask marvin-ai` get the
  single-graph behaviour until we promote development → main + tag a
  new release.

## Consequences

**Positive**

- Per-graph summaries are scoped — `graph_summary --scope=code` returns
  real architectural anchors; `graph_summary --scope=knowledge` returns
  doc / ADR / decision anchors.
- Rebuild frequencies match cost asymmetry — code-graph auto-rebuilds
  cheap; knowledge-graph stays manual / expensive-opt-in.
- Backwards compatible — `scope: "code"` default means no existing
  session breaks.
- Rollback is `git checkout main` or `brew install --cask marvin-ai`
  (cask still pinned at v0.1.13).

**Negative / mitigated**

- Two graphs to maintain. *Mitigated:* knowledge graph rebuild is
  one explicit command, expected to be infrequent.
- Federation logic lives in MARVIN's bridge, not in graphify upstream.
  *Mitigated:* graphify's read API supports `--graph <path>` already;
  we use it. No upstream changes required.
- `scope: "all"` queries make two calls. *Mitigated:* both are local
  file reads; combined latency is still <100ms on graphs we've seen.
- Risk: knowledge-graph AST extraction on markdown is shallow
  (headings + links, not concepts). *Mitigated:* documented as MVP
  shape; user can run `/graphify docs/` for semantic depth when
  they're willing to pay the LLM cost.

**Reversibility**

This decision is fully reversible. The stable v0.1.13 cask doesn't
ship any of it. To roll back from the development branch, `git
checkout main`. The `graphify-out/knowledge/` directory created by
the new builder is gitignored alongside `graphify-out/` — removing
it has no other side effects.

## Scope of Done

- [x] ADR-0028 captures the decision + the cost rationale + the deferred items
- [ ] `read-graph.ts` parametrised by graph path (optional, defaults to code)
- [ ] All six graph MCP tools accept `scope: "code" | "knowledge" | "all"`
- [ ] `bin/marvin knowledge-graph` builds `graphify-out/knowledge/graph.json`
- [ ] personality.ts Graphify protocol updated for the two-graph reality
- [ ] CLAUDE.md graphify section updated
- [ ] README has a "Stable vs Development" track explanation
- [ ] Smoke test passes on MARVIN's own repo (build both graphs, query each scope)
- [ ] Lives on `development` branch; `main` + cask v0.1.13 untouched

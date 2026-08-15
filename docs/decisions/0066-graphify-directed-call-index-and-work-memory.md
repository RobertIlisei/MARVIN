# ADR-0066 — Graphify at full surface: a directed call index, and closing the work-memory loop

- **Status:** Accepted
- **Date:** 2026-08-15
- **Supersedes:** none
- **Related:** [ADR-0028](./0028-two-graphs-per-project.md) (two graphs),
  [ADR-0041](./0041-per-turn-graph-refresh.md) (per-turn refresh),
  [ADR-0058](./0058-graph-extraction-write-exception.md) (subagent writes under `graphify-out/`),
  [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) (graph-drift nudge)

## Context

Graphify is the backbone of development on this project — Golden Rule 7 makes
querying it mandatory before any structural file read. But an audit of what
MARVIN's bridge actually *calls* found it using roughly a quarter of graphify
0.9.43's surface, and two of the gaps were not cosmetic.

**MARVIN shells out to three subcommands only** — `update` (watchdog), `query`
(`graph_query`), `save-result` (`graph_save_result`). Everything else it exposes
(`graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`) is hand-rolled
parsing of `graph.json` inside `mcp-server.ts`. Those four are therefore frozen at
the point the bridge was written and gain nothing from graphify releases. That is
a defensible performance call — no subprocess per query — with a maintenance tax
that only surfaces on the tool's next release.

Two specific failures fell out of that.

### 1. MARVIN could not answer a blast-radius question, and did not know it

Golden Rule 7 names "blast-radius" as a graph trigger. `graph_neighbors` is
documented as "1-hop blast radius" and its output renders `→` / `←` arrows.
Those arrows are meaningless:

- `graph.json` carries `directed: false`. networkx's undirected `node_link_data`
  emits each edge in whatever order adjacency iteration produces, so
  `source`/`target` in `links` reflects node insertion order, not semantics.
- Measured on this repo (2026-08-15): `graphPathForScope --calls-->
  buildProjectContext` and `sdk_runner_runAgent --calls--> createGraphMcpServer`
  appear with the same relation in **opposite** orientations, though both
  describe a caller/callee pair.
- graphify 0.9.43's own `affected` subcommand reverse-traverses that same graph,
  so it inherits the defect: on this repo it returned `buildProjectContext`'s
  *callees* under the heading "Affected nodes".

`--directed` is **not a build flag in 0.9.43**. It exists only on `diagnose
multigraph`, as a post-build simulation toggle. Passing it to the pipeline exits
0 and changes nothing — verified.

What *is* directed and durable is `graphify-out/cache/<hash>.json`, written by
the AST pass per source file. Each holds `raw_calls`: an explicit
`caller_nid → callee` list with file and line. 28,930 call edges across 1,302
cache files on this repo, indexed in ~0.2 s.

### 2. The work-memory loop saved answers and learned nothing

`save-result` has accepted `--outcome useful|dead_end|corrected` and
`--correction` since 0.9.x. MARVIN never sent either. `graphify reflect` — which
aggregates those outcomes into a lessons document with half-life decay and a
corroboration threshold — had never been run on any project.

Measured on a real project: **3 saved Q&As, zero outcomes, no `reflections/`
directory.** The loop was a cache, not feedback.

## Decision

### `graph_affected` — a directed call index, built from the cache

A new tool, backed by a new module `call-index.ts` that reads
`graphify-out/cache/*.json` and builds a `callee name → call sites` map.

It is deliberately **not** a wrapper over `graphify affected`, because that
command cannot work on an undirected build. It is also deliberately honest about
what it is:

- **The caller side is exact** — node id, file and line, straight from the AST.
- **The callee side is a bare symbol name**, unresolved. A lookup is therefore
  name-matched. `trim` has 344 call sites here from every unrelated `.trim()` in
  the repo, so above `AMBIGUITY_THRESHOLD` (40) the tool returns a warning
  instead of a blast radius, and refuses to widen the traversal.
- **"No callers" is not "dead code"** — entry points, dynamic dispatch and
  reflection all look identical. The tool says so rather than implying deletion
  is safe.
- **Stale cache entries are dropped.** The cache is content-addressed and never
  garbage-collected, so it accumulates entries from previous repo layouts — this
  repo's cache still held `apps/web/.../route.ts` call sites long after that tree
  became `sidecar/`. 4,990 of 28,930 edges were stale.

`graph_neighbors` is retargeted in the prompt to what it can actually do —
undirected 1-hop context — and explicitly barred from answering blast radius.

### `outcome` / `correction` / `graph_reflect` — closing the loop

`graph_save_result` gains `outcome` and `correction`; `graph_reflect` wraps
`graphify reflect`, scoped per graph, and returns the lessons inline so they are
acted on in the turn that generated them rather than filed away.

`outcome: "corrected"` without a `correction` is **rejected at the tool
boundary**. A correction-without-content teaches `reflect` that a node is
unreliable while withholding the one thing that would make the lesson
actionable — the same write-boundary enforcement pattern as `remember`
(ADR-0042) and `backlog_add` (ADR-0044), applied where prose guidance had
already failed once.

### Community labelling, on the CLI MARVIN already authenticates with

Both graphs' communities were 100 % `Community N` placeholders — 4,021 code
nodes and 8,516 knowledge nodes with no semantic grouping, which is why
`graph_summary`'s community section read as noise. `graphify label` needs an LLM
backend and this machine has **no API keys** (MARVIN authenticates via the Claude
CLI's OAuth). The `claude-cli` backend covers exactly that case, and labelling now
runs through it at zero incremental credential setup.

Two operational hazards were found doing this, both now in CLAUDE.md:

- **`cluster-only --graph <path>` reads that path but writes the default
  one.** Pointing it at the knowledge graph very nearly overwrote the code
  graph with it; only graphify's node-count guard refused. Label a non-default
  graph by staging a copy as `graphify-out/graph.json` in a scratch directory.
- **LLM labels do not survive a structural rebuild.** When the community set
  shifts, graphify silently renames every community after its hub node — "Git
  Write Policy Gate" became `git/src/index.ts` after an `update` moved the code
  graph 318 → 392 communities. Re-run `label` after such a rebuild. It must NOT
  be wired into the per-turn watchdog: it is an LLM pass, and the watchdog runs
  every turn.

### Deliberate non-adoptions

Recorded so they are not re-proposed:

- **`global add/remove/list/path`** (cross-repo graph at `~/.graphify/`) —
  **rejected.** It merges projects into a single graph, which is precisely what
  Golden Rule 4 forbids. Not a performance question; a contamination one.
- **`check-update`** — **skipped.** It reports whether *semantic* re-extraction
  is pending. MARVIN's watchdog is AST-only and already gates on HEAD-unchanged
  plus a 10-minute debounce, so this would add a subprocess and no signal.
- **`graphify affected`** — superseded by the above, for the reason given.

### Validated on a second stack, and made affordable there

MARVIN's own repo is TypeScript + Swift and small. The tool had to hold up on a
real user project — a Java/Spring Boot + React monorepo — so it was measured
there before being called done:

| | MARVIN | agri-saas-platform |
|---|---|---|
| Cache | 1,302 files / 16 MB | 8,564 files / **321 MB** |
| Call edges | 28,930 | **433,361** |
| Stale dropped | 4,990 | 22,336 |

`raw_calls` is emitted for Java, TypeScript, JS and Python alike, and callers
resolve correctly (`SubscriptionRepository`, `DocumentService`, verified by
hand). But the naive implementation cost **3.0 s and 127 MB resident** there —
and MARVIN's watchdog runs `graphify update` on the active project **every
turn**, which appends cache entries and would have forced that full re-parse on
the next query. Unusable as written.

Two changes fixed it, both exploiting the fact that graphify's cache is
**content-addressed** — entries never change in place; a modified source file
produces a new hash filename:

1. **Incremental ingest.** Only unread cache files are parsed. A refresh costs
   **5 ms** instead of a full rebuild. A *vanished* entry is the one case that
   forces a clean rebuild, since it means the cache was pruned and the
   accumulated index may hold call sites that no longer exist.
2. **String interning + single-project retention.** `JSON.parse` mints a fresh
   string per occurrence, so 433k edges held 433k copies of ~8.5k distinct
   paths. Interning paths and caller ids, and retaining only the *active*
   project's index rather than a Map keyed by workDir, took resident memory
   from **127 MB → 36 MB**.

**Known limit, quantified.** On that project 22 % of distinct callee names
exceed the ambiguity threshold. The offenders are what you would expect and
never ask blast radius about — `assertThat` (21,214 sites), `of`, `put`,
`when`, `isEqualTo`, `get`. For domain symbols the effective rate is far
better than the raw 78 % suggests.

## Scope of Done

- [x] `graph_affected` returns real callers with file+line, verified against
      ground truth (`buildProjectContext` → chat route, context route,
      turn-orchestrator; `createGraphMcpServer` → sdk-runner, session-auditor).
- [x] Ambiguous names produce a warning, not a number; depth traversal is
      suppressed for them.
- [x] Stale call sites are filtered by source-file existence.
- [x] `graph_save_result` carries `outcome`/`correction`; `corrected` without a
      correction is rejected.
- [x] `graph_reflect` produces `graphify-out/reflections/LESSONS.md` from real
      outcomes, verified end-to-end.
- [x] Both graphs' communities carry semantic names.
- [x] `personality.ts` carries MUST triggers for `graph_affected` and
      `graph_reflect`, and bars `graph_neighbors` from blast-radius duty.
- [x] Works on a second stack (Java/Spring Boot, 433k call edges) at 36 MB
      resident and 5 ms per refreshed turn.
- [x] 17 unit tests over the call index; typecheck clean.

## Consequences

**Good.** MARVIN can answer "what breaks if I change X" for the first time, with
line-level citations. Wrong graph answers become durable corrections instead of
evaporating. `graph_summary`'s community section becomes readable.

**Cost.** `call-index.ts` couples MARVIN to graphify's cache layout
(`raw_calls`, `caller_nid`). That is a private artifact, not a documented
interface, and a graphify release could change it. The tool degrades honestly if
so — a missing cache produces a clear "build the code graph first" error rather
than a wrong answer — but this is real coupling, and the right long-term fix is
a build-time `--directed` in graphify itself.

**Measured, not claimed.** `graphify benchmark` puts the graph at **27.5× fewer
tokens per query** than naive full-corpus reads on this repo (268,066 naive
tokens → ~9,763 per query). CLAUDE.md previously asserted ~36× with no
measurement behind it; it now cites this number and its date. This closes the
open "re-measure the graph:file ratio" follow-up from ADR-0060.

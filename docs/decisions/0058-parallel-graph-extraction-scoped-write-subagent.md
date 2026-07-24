# ADR-0058 — Parallel graph extraction: a Haiku `graph-extractor` subagent with a graphify-out-scoped write

**Status:** Accepted — 2026-07-24
**Touches:** `sdk-runner.ts` (`buildGraphExtractorAgent`, register it; a
`graphify-out/`-scoped write exception in `classifyToolCall`; resolve the Haiku
tier), `@marvin/tools/policy` (sanction `graph-extractor` dispatch),
`personality.ts` (steer the semantic pass to it). Carves a narrow exception to
the subagent read-only invariant ([ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md))
and adds a subagent type per Golden Rule 1's "new subagent type ⇒ new ADR".
Builds on the scout (ADR-0014), advisor (ADR-0033), and the per-turn AST refresh
([ADR-0041](./0041-per-turn-graph-refresh.md)).

## Context

The graphify semantic pass is slow on a big project (agri-saas-platform). The
per-turn AST refresh (ADR-0041, code + knowledge graphs) is free and needs no
subagents — it is NOT the bottleneck. The bottleneck is the **LLM extraction**
pass (`/graphify` semantic: reads docs/prose → nodes/edges), which graphify is
*designed* to parallelise — its skill is emphatic: *"MANDATORY: you MUST use the
Agent tool… dispatch ALL subagents in a single message, one per 20–25 file
chunk."*

Inside MARVIN it collapses to serial. graphify's extractor subagents must
**write their chunk files to disk** (the skill warns that without Write access
it "silently drops extraction results"), but MARVIN's subagent read-only
invariant (ADR-0030 / Golden Rule 1) **hard-denies Write from any `agentID`
call**. So the parallel writers are blocked and the work falls back to the main
loop, serially — the "1 agent takes very long" the user hit.

Two things are true at once: (a) MARVIN is right to deny arbitrary subagent
writes, and (b) graph EXTRACTION is read-only **discovery** — reading files,
emitting structure — which is exactly the *sanctioned* fan-out category (scouts,
dynamic workflows), NOT the parallel-**implementation** Golden Rule 1 forbids.
The only friction is the chunk-output write.

## Decision

### 1. A `graphify-out/`-scoped write exception (the parallelism fix)

`classifyToolCall` gains a narrow exception, evaluated before the subagent
read-only invariant: a sub-agent **file-write** (`Write`/`Edit`/`NotebookEdit` —
deliberately NOT `Bash`, which can't be path-scoped safely) whose target
resolves under a `graphify-out/` directory is **allowed**. Every other sub-agent
mutation stays hard-denied. Not granted in Ask mode (that whole-turn read-only
constraint still wins). This unblocks the fan-out for graphify's *existing*
`general-purpose` dispatch too — no fork of the external graphify skill required.

### 2. A Haiku `graph-extractor` agent (the cost fix)

Register `graph-extractor` (`AgentDefinition`, `buildGraphExtractorAgent`),
pinned to the **Haiku tier** (`latestForTier("haiku")`, no hardcoded version).
Chunk → nodes/edges extraction is mechanical; it doesn't need the executor's
frontier model, and the per-call saving is large on a big corpus. `WebFetch` is
disallowed at the SDK layer (exfil, like the scout); `Write` stays available but
is gate-scoped to `graphify-out/` by (1). Added to `SANCTIONED_SUBAGENT_TYPES`
so dispatch auto-allows. `personality.ts` steers the semantic pass to dispatch
`subagent_type: "graph-extractor"` (all chunks in one message → concurrent).

### Why not the alternatives

- **Fork graphify's skill** to dispatch a custom type — fragile (it's a
  user-global skill, reinstall-overwritten). The gate exception makes the fix
  work with graphify's stock `general-purpose` dispatch; the `graph-extractor`
  steer is the *cost* upgrade layered on top.
- **Cheaper model, still serial** — leaves the big-project slowness.
- **Bash-scoped writes** — a Bash command can't be proven to touch only
  `graphify-out/`; file-write tools can. Extractors write chunk files, so
  file-write scoping is sufficient.

## Consequences

- **Positive.** The semantic pass fans out in parallel on Haiku — the direct fix
  for "1 agent takes very long". No graphify fork; the gate exception is the
  mechanical, unconditional half (works even with stock `general-purpose`), the
  agent + steer is the cost half.
- **Security.** The read-only invariant is loosened by exactly one narrow slit:
  sub-agent file-writes under `graphify-out/`. That directory is a generated
  cache — not source, not executed. ~~The residual risk is a prompt-injected
  extractor writing a poisoned graph~~ **Narrowed by the addendum below.**
  `Bash`, Ask mode, and all non-graphify-out paths stay denied.
- **Coupling.** ~~The *model* win depends on the semantic pass dispatching
  `graph-extractor` (a personality steer)~~ **Closed by the addendum below —
  the gate remaps the dispatch itself.**

## Addendum (2026-07-24) — both noted limits closed mechanically

The two limits this ADR originally shipped with were both "prose or nothing"
gaps, and both had mechanical fixes available in the gate:

### A1. Dispatch remap — the Haiku saving is now unconditional

graphify's stock skill hardcodes `subagent_type: "general-purpose"`, so the
model saving depended on the personality steer being followed. But `canUseTool`
returns `updatedInput` — the gate can rewrite the dispatch itself.
`remapGraphExtractionDispatch` (sdk-runner, both auto + gated callbacks): a
`Task { subagent_type: "general-purpose" }` whose brief BOTH references a
`graphify-out/` path AND uses extraction vocabulary
(extract/chunk/nodes/edges/hyperedges/semantic) is rewritten to
`graph-extractor` at allow time, audit-logged with a `[remapped]` marker. The
signature requires both conditions, so "summarise graphify-out/GRAPH_REPORT.md"
or "extract validation rules from src/" are left alone; a false positive costs
only the model tier (read access identical; write scope gate-governed either
way). The personality steer stays as the first line; the remap is the backstop —
the same layering as ADR-0055/0057.

### A2. Canonical-artifact protection — the poisoning surface is narrowed

The slit no longer covers the graph's canonical artifacts: sub-agent writes to
`graphify-out/**/graph.json` (the merged graphs every later query reads) and
`graphify-out/**/memory/` (the curated Q&A stores) are **denied** even inside
the slit; chunk/cache writes remain allowed. A prompt-injected extractor can
now only contribute chunk data that flows through the main loop's deterministic
merge — which is the SAME exposure serial extraction always had (the injected
doc gets read either way). What the addendum removes is the *new* risk the slit
introduced: direct overwrite of the canonical query targets and curated memory
by a subagent. Net: the parallel path's injection surface is now equivalent to
the serial path's, not larger.

### Residual (honest) limits after the addendum

- A poisoned *chunk* still enters the merge — inherent to LLM extraction over
  untrusted text, identical for serial and parallel; not addressable at this
  gate.
- The remap heuristic can miss an unusually-worded extraction brief (falls back
  to parallelism-without-Haiku — the pre-addendum behaviour, never worse).

## Scope of Done

- [x] A sub-agent `Write`/`Edit`/`NotebookEdit` under `graphify-out/` classifies
      `allow`; the same write elsewhere, or any sub-agent `Bash`, still denies;
      the exception does NOT fire in Ask mode — unit tested.
- [x] `graph-extractor` is a sanctioned subagent type; registered with the Haiku
      tier resolved via `latestForTier`.
- [x] `personality.ts` steers the semantic pass to `graph-extractor` (one message,
      concurrent) and frames it as a graph-only carve-out.
- [x] Full suite + typecheck green; app rebuilt.

**Addendum Scope of Done**

- [x] A stock general-purpose extraction dispatch is rewritten to
      `graph-extractor` in BOTH auto and gated callbacks (`updatedInput`),
      audit-marked; non-extraction briefs untouched — unit + end-to-end tested.
- [x] Sub-agent writes to `graphify-out/**/graph.json` and
      `graphify-out/**/memory/` deny even inside the slit; chunk writes still
      allow — unit tested.
- [x] Full suite + typecheck green; app rebuilt.

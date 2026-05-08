# Long-term memory / recall MCP — parked plan

**Status:** deferred (not in flight, not rejected). Drafted 2026-05-05. Not shipping.

User asked: should MARVIN grow a second knowledge graph alongside the per-project code+docs graph — one that captures sessions, decisions, and reasoning over time as a "brain" that improves with use, with aggressive human-brain-style compaction?

After research + advisor consult: directionally yes, but build the cheapest falsifiable thing first, gated on an eval. We chose to park the work for now.

## Field survey (May 2026)

| System | Shape | Notable point |
|---|---|---|
| Letta / MemGPT | Hierarchical core/recall/archival | Self-editing memory tools; sleep-time agents consolidate in background |
| Zep + Graphiti | Temporal KG with bitemporal edges | Facts have validity windows; superseded ≠ deleted. ~71% LongMemEval (GPT-4o), P95 ~300ms |
| A-MEM (NeurIPS 2025) | Zettelkasten of notes | New memories link to old ones AND trigger updates to old notes' attributes. Beats Mem0/Letta on six foundation models |
| AriGraph | Dual graph: episodic vertices + semantic triplets | Updated per turn; outperforms RL baselines on text games |
| Cognee | Graph-native, 14 traversal modes | Triplet-search over an extracted KG |

Top published LongMemEval scores cluster ~93–95% (Mastra Observational Memory 94.87%, OMEGA 95.4%, ByteRover 92.8%). Mem0 is ~49% — graph-shaped systems clearly win.

Sleep-time compute is real and shipping (Letta sleep-time agents; Anthropic's "Auto Dream" memory consolidation in quiet rollout). Background distillation reduces token spend at the same accuracy.

## Human-brain compaction takeaways that *do* generalise

1. Selective replay of **weak** signals, not blanket summarisation. Lossy raw-text summarisation is the documented trap — summaries mask failure signals so agents push down dead paths.
2. Structured note-linking beats prose summaries (A-MEM is the closest engineering analogue).

## Advisor critique (the load-bearing pushback)

- **No falsifiability without an eval.** Memory systems are unfalsifiable without LongMemEval / LoCoMo-style fixtures.
- **Bitemporal invalidation has no concrete predicate** for conversation — "contradicts" is judgement-laden.
- **Privacy / deletion** gets harder once distilled into a cross-referenced graph.
- **Two graphs = entity-resolution risk.** `Foo`-the-symbol vs `Foo`-the-thing-we-discussed.
- **Golden Rule 4 tension.** "Learn the user's patterns" is cross-project by definition; per-project memory cannot deliver that.
- **"Like the brain"** does rhetorical work the engineering hasn't earned yet.

Advisor verdict was *reject as scoped* (full layered brain). The carved-down version below is the falsifiable v1.

## Three options that were on the table

- **A — Recall-only (1–2 days).** Embed-index existing JSONL transcripts; expose `recall(query)` MCP tool. Preserves reasoning verbatim, retrievable. ~70% of "didn't we discuss X" value with no compaction failure surface.
- **B — Extend the existing graph (1 week).** Promote `.marvin/memory.md` + ADRs + extracted-from-sessions entities to first-class nodes inside the *existing* graphify graph. One graph, one query path. The "two graphs federated" design is the more expensive version of this with no obvious win.
- **C — Full layered brain (a quarter).** Conversation graph + bitemporal edges + A-MEM-style sleep-time consolidation + federated query + eval harness + retention policy. What was originally proposed.

**Recommended path when revisited: A → B, gated on an eval.** Defer C unless the eval shows A+B is still insufficient.

## If we pick this back up — Plan for Option A

### Definition of Done

- A `recall(query, limit?)` MCP tool, exposed under the existing `marvin-graph` server, returns the top-k relevant past *turns* from the current project's sessions, each with `sessionId + timestamp` citations — and nothing from other projects.
- Indexing is incremental: a new vector is written on each `appendSessionTurn` call.
- A backfill script populates the index for every existing session JSONL on first run, idempotent on re-run.
- A small eval harness (≥ 10 hand-crafted questions about past sessions, with ground-truth answer locations) runs via a single command, records baseline vs with-recall numbers, and is checked into the repo.
- The eval shows a measurable improvement (or honestly shows none — in which case we don't ship and step up to Option B). Either outcome counts as "done" — the point is falsifiability.

### Milestones (eval-first per advisor)

| # | Milestone | Verification |
|---|---|---|
| M1 | **Eval harness, baseline numbers.** Mine real questions from existing transcripts. Run MARVIN-without-recall, record scores. | `pnpm test:recall-eval` runs and prints baseline accuracy on the fixture. |
| M2 | **Embedding pipeline.** `embedTurn(turn) → number[]`. | Unit test: two paraphrases > random pair on cosine similarity. |
| M3 | **Index storage + write path.** Sqlite + sqlite-vec at `<MARVIN_DATA_DIR>/sessions/<projectId>/recall-index/index.db`. Hook into `appendSessionTurn`. | New session → index.db row count increments. Typecheck clean. |
| M4 | **Backfill + read path.** `pnpm recall:backfill <projectId>` walks existing JSONLs. Internal `recall(query, limit, projectId)` returns citations. | Spot-check: a known phrase from a past session retrieves the right turn at top-1. |
| M5 | **MCP tool surface.** Expose `recall` via `marvin-graph` MCP. Per-project scoped. | MARVIN session → ask about a past topic → tool fires → citation rendered in chat. |
| M6 | **Re-run eval, decide.** Run M1 harness with recall enabled. | Results table goes into the ADR + the roadmap shipped block. |

ADR-worthy under triggers (a) foundational MCP surface, (f) new tool registered, (g) cross-cutting. Write `00NN-recall-mcp-and-jsonl-index.md` once the open questions below are answered.

### Open questions to resolve before code

1. **Embedding model** — local (e.g. `fastembed-js`, free, offline, ~MiniLM-quality) vs hosted (Voyage `voyage-3-lite` or OpenAI `text-embedding-3-small`, ~$0.02/M tokens, better recall). Lean: local for v1.
2. **Eval set construction** — mine real session JSONLs to build the fixture, or hand-pick the questions (latter is higher-signal but costs user time).
3. **Tool invocation policy** — `recall` called only when MARVIN explicitly decides to (cheap, no token bloat) vs passively prepended every turn (richer context, more tokens). Lean: explicit-only — matches the graphify pattern, avoids the "passive recall floods the context" cousin failure of summary-masking.

### Cross-project user-pattern learning (separate track)

The user's "MARVIN gets to know me" goal is cross-project by definition and conflicts with [Golden Rule 4](../../CLAUDE.md). The legitimate home is the user-scoped Claude Code auto-memory at `~/.claude/projects/<slug>/memory/` — not any per-project graph. Worth its own decision later; explicitly out of scope for the recall MCP.

## Sources

- [Letta (MemGPT) hierarchical memory](https://docs.letta.com/concepts/memgpt/) · [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute) · [Sleep-time agents docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)
- [Zep: Temporal Knowledge Graph for Agent Memory (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956) · [Graphiti — Neo4j blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [A-MEM: Agentic Memory for LLM Agents (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [AriGraph (arXiv 2407.04363)](https://arxiv.org/abs/2407.04363)
- [Cognee — AI Memory Tools Evaluation](https://www.cognee.ai/blog/deep-dives/ai-memory-tools-evaluation)
- [Graph-based Agent Memory taxonomy survey (arXiv 2602.05665)](https://arxiv.org/abs/2602.05665)
- [LongMemEval benchmark (arXiv 2410.10813)](https://arxiv.org/abs/2410.10813) · [Mastra — Observational Memory: 95% on LongMemEval](https://mastra.ai/research/observational-memory)
- [Hippocampal replay during sleep — Nature Neuroscience](https://www.nature.com/articles/s41593-019-0467-3) · [Replay prioritises weakly learned info — Nature Comms](https://www.nature.com/articles/s41467-018-06213-1)
- [Compaction in agent frameworks — Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction)
- [Claude Code's Auto Dream](https://bregg.com/post.php?slug=claude-code-auto-dream-memory-consolidation)

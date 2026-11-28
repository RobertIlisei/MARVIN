# ADR-0041 — Project-graph lifecycle + first-message context budget

**Status:** Accepted — 2026-06-14
**Touches:** `graphify-bridge` (`knowledge-watchdog.ts`, wire the dormant
`watchdog.ts`), `/api/chat` route (fire both refreshers), `bin/marvin` (pass
the knowledge-graph builder path), `project-context/index.ts` (ADR titles +
memory tail + token budget). Builds on the two-graph model (ADR-0028) and the
per-project isolation rule (Golden Rule 4).

## Context

A new chat's **first prompt** on a mature project threw **"Prompt is too
long"** before the prompt was even read. `buildProjectContext` injected the
first-message context with **no token budget**: every ADR in full, plus
`memory.md` whole. Measured on `agri-saas-platform`: **139 ADRs ≈ 462K tokens +
a 417 KB memory.md ≈ 104K tokens ≈ 566K tokens** against the executor's
**200K** window (`claude-opus-4-8`) — ~2.8× over.

Two facts surfaced while diagnosing (the user's framing — **MARVIN is an IDE
that runs per-project tools like graphify**):

1. MARVIN already **reads** only the active project's graph (the `marvin-graph`
   MCP is `createGraphMcpServer(cwd)`; `/api/chat` refuses to fall back to
   `process.cwd()`). It never touches its own source graph when serving the
   user. ✓
2. But MARVIN does **not build/maintain** the project graph. `maybeRefreshGraphify`
   (the code-graph watchdog) had **zero live callers**, and the **knowledge
   graph** (ADR/doc/memory index, `scope:"knowledge"`) was fully manual and
   usually absent. So "titles up front → graphify for ADR detail" had nothing to
   query.

## Decision

Two layers.

### Layer 1 — MARVIN owns the active project's graph lifecycle

- A sibling `maybeRefreshKnowledgeGraph(workDir)` (knowledge-watchdog.ts) runs
  the AST-only builder (`scripts/build-knowledge-graph.py`, no LLM cost),
  debounced on HEAD-change like the code watchdog. Best-effort: no-ops if
  Python/script aren't found.
- `/api/chat` fires BOTH refreshers fire-and-forget against the **validated
  active-project `cwd`** on every turn (internally debounced → usually a no-op,
  never blocks the turn, never MARVIN's own repo).
- `bin/marvin start` exports `MARVIN_KNOWLEDGE_GRAPH_SCRIPT` so the running
  sidecar resolves the builder reliably in dev.
- The richer **semantic** `/graphify` pass stays manual/opt-in; auto-maintenance
  uses only the free AST builds.

### Layer 2 — first-message context budget

- **ADRs → titles index only** (file + heading), with an instruction to find
  the relevant ADR via the knowledge graph (`scope:"knowledge"`) then **Read the
  file**. (462K → ~2K tokens.)
- **memory.md → recent tail** (`MEMORY_TAIL_TOKENS = 8000`) + a pointer to the
  full file / knowledge graph for older entries.
- **Curated docs** (PROJECT_STATUS / BUSINESS_OVERVIEW / README) stay **whole**
  — Golden Rule 5 is about *those* docs, not about dumping the ADR corpus + a
  400 KB log.
- A soft **`CONTEXT_TOKEN_BUDGET` (90K)** backstop: if the assembled context is
  still large (curated docs dominate), prepend a note telling MARVIN to pull
  detail on demand rather than silently truncating the user's docs.

Measured result on agri-saas-platform: **566K → ~13.4K tokens** for the
first-message context.

## Rejected alternatives

- **Switch executor to the 1M-context model.** Fits today (566K < 1M) but
  injects 566K every turn (slow + costly) and re-breaks as the project grows. A
  band-aid; rejected as the primary fix.
- **Truncate the curated docs too.** Violates Golden Rule 5; the docs are small
  — the ADR corpus + memory were the problem.
- **A bespoke MCP `ask_user`-style tool to fetch ADRs.** Unnecessary: the
  knowledge graph + plain file reads already cover it.

## Scope of Done

- [x] `maybeRefreshKnowledgeGraph` builds `<cwd>/graphify-out/knowledge/graph.json`
      (AST, free), debounced; no-ops gracefully when the builder is absent.
- [x] `/api/chat` fires both refreshers against the validated `cwd` only.
- [x] ADRs injected as a titles index; memory as a bounded tail; curated docs
      whole; token-budget backstop.
- [x] First-message context for agri-saas-platform measured ≈13.4K tokens
      (was ~566K) — verified via `buildProjectContext`.
- [x] runtime / project-context / graphify-bridge / web-route `tsc` clean.
- [ ] Bundled-.app path for the Python knowledge builder — confirm it's shipped
      (or have graphify build the knowledge layer) so auto-build works outside
      dev. Code graph is unaffected (`graphify` on PATH).

## Addendum 2026-11-28 — one machine-wide cap on graph refreshes

**What went wrong.** A per-turn refresh of a large project's graph
(`graphify update <tab worktree>`) holds 3.6-4.2 GB. Each tab's refresh was
debounced per tab, and ADR-0124 serialised worktree refreshes only *within one
project* — the project's own code graph, its knowledge graph and every
project's worktrees still ran side by side. On an 18-core / 36 GB Mac Studio
with ~18 tab worktrees, nine ran at once at 00:46 (~36 GB) and the machine ran
out of memory and had to be restarted.

**Decision.** `refresh-gate.ts` in graphify-bridge is the one door every
refresh goes through (code watchdog, knowledge watchdog, worktree refresh):

- at most `MARVIN_GRAPH_REFRESH_MAX` run at once (integer 1..4, default 1);
  the rest wait FIFO; a request for a key already queued or running is
  coalesced; a request that waited over 10 minutes is dropped (the next turn
  asks again — the caller's HEAD / fingerprint / debounce marker is reset so
  that next ask is not read as "unchanged");
- before starting one, available memory is read and the refresh is skipped
  below `MARVIN_GRAPH_REFRESH_MIN_FREE_PCT` (integer 5..90, default 30); the
  tab keeps its graph; a skip is logged at most once a minute. On macOS
  "available" is `vm_stat` free + inactive + speculative + purgeable pages,
  not `os.freemem()`, which counts only free pages and sits near a few percent
  on a healthy Mac (it would skip everything); Linux uses `MemAvailable`. An
  unreadable value lets the refresh run — the cap still bounds it;
- the gate only manages the children MARVIN spawned (it holds their handles);
  no pattern kills (MARVIN refuses `pkill` / `killall`), no per-refresh
  ceiling;
- `[graph-refresh]` log lines: `queued`, `coalesced`, `started`, `finished
  duration=`, `dropped-stale`, `skipped-low-memory`; `/api/sessions/watch`
  returns `graphRefresh: {running, queued, max}`.

ADR-0124's per-project worktree queue is replaced by this gate. Fires from
`/api/chat` (`route.ts:267-268`) and `turn-orchestrator.ts:393`.

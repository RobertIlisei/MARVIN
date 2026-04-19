# Graph Report - .  (2026-04-18)

## Corpus Check
- Corpus is ~46,854 words - fits in a single context window. You may not need a graph.

## Summary
- 310 nodes · 358 edges · 61 communities detected
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 64 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]

## God Nodes (most connected - your core abstractions)
1. `GET()` - 36 edges
2. `POST()` - 17 edges
3. `8-Phase Senior-Engineer Workflow` - 9 edges
4. `Target Architecture (Repo Layout)` - 8 edges
5. `getAnthropicAuth()` - 7 edges
6. `DELETE()` - 7 edges
7. `MARVIN` - 7 edges
8. `MARVIN Project Instructions (CLAUDE.md)` - 7 edges
9. `Golden Rules for Working in This Repo` - 7 edges
10. `readProjectsFile()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Repo Layout (apps/web + packages)` --semantically_similar_to--> `Target Architecture (Repo Layout)`  [INFERRED] [semantically similar]
  README.md → PLAN.md
- `Rule 1: Single Assistant, Not an Agent Team` --semantically_similar_to--> `Explicitly Not a Multi-Agent Orchestration`  [INFERRED] [semantically similar]
  CLAUDE.md → README.md
- `Multi-Agent Autonomy Degrades ~70% / 17x Error Amplification` --semantically_similar_to--> `2026 Multi-Agent Coding Literature (Google/UIUC/Microsoft/Anthropic)`  [INFERRED] [semantically similar]
  README.md → PLAN.md
- `8-Phase Workflow in One Conversation` --semantically_similar_to--> `8-Phase Senior-Engineer Workflow`  [INFERRED] [semantically similar]
  README.md → PLAN.md
- `Key Packages Table (apps/web, runtime, tools, project-context, graphify-bridge, git-watch, ui)` --semantically_similar_to--> `Target Architecture (Repo Layout)`  [INFERRED] [semantically similar]
  CLAUDE.md → PLAN.md

## Hyperedges (group relationships)
- **Isolation Contract Enforcement** — claude_rule_separate_workspace, claude_rule_no_hardcoded, plan_isolation_contract [INFERRED 0.90]
- **Anti-Multi-Agent Architecture Rationale** — readme_multi_agent_research, plan_2026_literature, plan_non_goal_multi_agent, claude_rule_single_assistant [EXTRACTED 0.95]
- **Ramification Tracking Three-Layer Stack** — plan_layer_graph, plan_layer_adr, plan_layer_memory, plan_blast_radius [EXTRACTED 1.00]

## Communities

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (34): Adding a New Feature (PLAN.md first), MARVIN_DATA_DIR Default ~/.marvin/, Golden Rules for Working in This Repo, Key Packages Table (apps/web, runtime, tools, project-context, graphify-bridge, git-watch, ui), Personality: marvin | neutral Toggle, MARVIN Project Instructions (CLAUDE.md), Rule 3: Confirm-Before-Act for Risky Tools, Rule 6: No Hardcoded Project Knowledge (+26 more)

### Community 1 - "Community 1"
Cohesion: 0.13
Nodes (15): computeDegrees(), emptySummary(), getNeighbors(), loadRaw(), resolveNode(), searchGraph(), shortestPath(), summarizeGraph() (+7 more)

### Community 2 - "Community 2"
Cohesion: 0.15
Nodes (18): ensureDir(), buildSystemPrompt(), addProject(), getActiveProjectId(), getProject(), listProjects(), readActiveFile(), readProjectsFile() (+10 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (16): clearTurnConfirms(), registerPendingConfirm(), resolvePendingConfirm(), detectNewCommits(), getCurrentHead(), gitHead(), listCommitsSince(), resetCommitCursor() (+8 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (19): Advisor Strategy (Sonnet exec + Opus advisor), Blast-Radius Enumeration (1-hop + 2-hop graph traversal), Browser Preview Pane (iframe-based), 8-Phase Senior-Engineer Workflow, Graph-Aware Chat via In-Process MCP Server, Keyboard Shortcuts + Session Search, Layer 2: Architecture Decision Records (docs/adr/), Layer 1: Structural Impact Analysis from Knowledge Graph (+11 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (18): God Nodes: GET, POST, Target Architecture, 8-Phase Workflow, etc., Graph Queries 36x Cheaper than Raw File Reads, Graphify Usage Guide, Graphify Baseline (233 nodes / 248 edges / 44 communities), Moderately Advanced Robotic Virtual Intelligence Network, Claude CLI runtime (@marvin/runtime), 8-Phase Workflow in One Conversation, Graphify Knowledge Graph Integration (+10 more)

### Community 6 - "Community 6"
Cohesion: 0.2
Nodes (0): 

### Community 7 - "Community 7"
Cohesion: 0.46
Nodes (7): dayKey(), emptyAggregate(), fold(), readCostFile(), recordTurnCost(), summarizeCost(), writeCostFile()

### Community 8 - "Community 8"
Cohesion: 0.32
Nodes (4): buildProjectContext(), readAdrs(), formatProbeBlock(), runProbes()

### Community 9 - "Community 9"
Cohesion: 0.29
Nodes (0): 

### Community 10 - "Community 10"
Cohesion: 0.57
Nodes (6): buildSubprocessEnv(), getAnthropicAuth(), hasHostCredentialsOnDisk(), isOAuthToken(), maskKey(), trimEnv()

### Community 11 - "Community 11"
Cohesion: 0.33
Nodes (0): 

### Community 12 - "Community 12"
Cohesion: 0.4
Nodes (4): defaultReason(), toolPolicy(), classifyToolCall(), resolveRuntimeMode()

### Community 13 - "Community 13"
Cohesion: 0.4
Nodes (3): onKey(), loadHistory(), mount()

### Community 14 - "Community 14"
Cohesion: 0.4
Nodes (0): 

### Community 15 - "Community 15"
Cohesion: 0.6
Nodes (3): defaultModel(), discoverClaudeBinary(), runClaudeCli()

### Community 16 - "Community 16"
Cohesion: 0.4
Nodes (0): 

### Community 17 - "Community 17"
Cohesion: 0.5
Nodes (0): 

### Community 18 - "Community 18"
Cohesion: 0.5
Nodes (0): 

### Community 19 - "Community 19"
Cohesion: 0.5
Nodes (0): 

### Community 20 - "Community 20"
Cohesion: 0.83
Nodes (3): extractionPrompt(), parseJsonPayload(), refreshDocs()

### Community 21 - "Community 21"
Cohesion: 0.5
Nodes (0): 

### Community 22 - "Community 22"
Cohesion: 0.5
Nodes (0): 

### Community 23 - "Community 23"
Cohesion: 0.5
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 0.67
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 1.0
Nodes (2): getHomeDir(), getMarvinDataDir()

### Community 26 - "Community 26"
Cohesion: 0.67
Nodes (0): 

### Community 27 - "Community 27"
Cohesion: 0.67
Nodes (0): 

### Community 28 - "Community 28"
Cohesion: 0.67
Nodes (0): 

### Community 29 - "Community 29"
Cohesion: 1.0
Nodes (0): 

### Community 30 - "Community 30"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Community 31"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Community 32"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Community 33"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Community 35"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (2): frontend-design Skill Applied to MARVIN Itself, Skill Library Expansion (14 Anthropic skills)

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (0): 

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (0): 

### Community 52 - "Community 52"
Cohesion: 1.0
Nodes (0): 

### Community 53 - "Community 53"
Cohesion: 1.0
Nodes (0): 

### Community 54 - "Community 54"
Cohesion: 1.0
Nodes (0): 

### Community 55 - "Community 55"
Cohesion: 1.0
Nodes (0): 

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (0): 

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (0): 

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (0): 

### Community 59 - "Community 59"
Cohesion: 1.0
Nodes (1): End-to-End Verification Smoke Test

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (1): Open Items (quick confirms)

## Knowledge Gaps
- **31 isolated node(s):** `Moderately Advanced Robotic Virtual Intelligence Network`, `Pair-Programming AI Assistant`, `Hitchhiker's Brain-the-Size-of-a-Planet Quote`, `pnpm workspaces + Turbo`, `Claude CLI runtime (@marvin/runtime)` (+26 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 29`** (2 nodes): `cn()`, `tabs.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 30`** (2 nodes): `utils.ts`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (2 nodes): `TooltipContent()`, `tooltip.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (2 nodes): `Badge()`, `badge.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 33`** (2 nodes): `Separator()`, `separator.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (2 nodes): `cn()`, `button.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (2 nodes): `Input()`, `input.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (2 nodes): `Skeleton()`, `skeleton.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (2 nodes): `layout.tsx`, `RootLayout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (2 nodes): `personality-toggle.tsx`, `PersonalityToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (2 nodes): `runtime-mode-toggle.tsx`, `RuntimeModeToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (2 nodes): `cost-pill.tsx`, `fmtUsd()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (2 nodes): `diff-viewer.tsx`, `onMount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (2 nodes): `use-projects.ts`, `useProjects()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (2 nodes): `submit()`, `add-project-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (2 nodes): `project-picker.tsx`, `fmtWhen()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (2 nodes): `frontend-design Skill Applied to MARVIN Itself`, `Skill Library Expansion (14 Anthropic skills)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (1 nodes): `shortcuts-help.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (1 nodes): `message-view.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (1 nodes): `status-bar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `graph-panel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `file-tree.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (1 nodes): `End-to-End Verification Smoke Test`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (1 nodes): `Open Items (quick confirms)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GET()` connect `Community 1` to `Community 2`, `Community 3`, `Community 7`, `Community 10`, `Community 15`, `Community 25`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **Why does `POST()` connect `Community 2` to `Community 1`, `Community 3`, `Community 8`, `Community 12`, `Community 15`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `Explicitly Not a Multi-Agent Orchestration` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Are the 22 inferred relationships involving `GET()` (e.g. with `detectNewCommits()` and `registerPendingConfirm()`) actually correct?**
  _`GET()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `POST()` (e.g. with `slugifyWorkDir()` and `resolveRuntimeMode()`) actually correct?**
  _`POST()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `Target Architecture (Repo Layout)` (e.g. with `Key Packages Table (apps/web, runtime, tools, project-context, graphify-bridge, git-watch, ui)` and `Repo Layout (apps/web + packages)`) actually correct?**
  _`Target Architecture (Repo Layout)` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Moderately Advanced Robotic Virtual Intelligence Network`, `Pair-Programming AI Assistant`, `Hitchhiker's Brain-the-Size-of-a-Planet Quote` to the rest of the system?**
  _31 weakly-connected nodes found - possible documentation gaps or missing edges._
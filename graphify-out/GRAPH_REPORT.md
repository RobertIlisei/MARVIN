# Graph Report - .  (2026-04-17)

## Corpus Check
- Corpus is ~29,174 words - fits in a single context window. You may not need a graph.

## Summary
- 233 nodes · 248 edges · 44 communities detected
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_API Surface & Data Layout|API Surface & Data Layout]]
- [[_COMMUNITY_Runtime Claude CLI & Paths|Runtime: Claude CLI & Paths]]
- [[_COMMUNITY_Project Context & Infra Probes|Project Context & Infra Probes]]
- [[_COMMUNITY_Context Hierarchy & Workflow|Context Hierarchy & Workflow]]
- [[_COMMUNITY_Architectural Decisions & Phases|Architectural Decisions & Phases]]
- [[_COMMUNITY_UI Select Primitive|UI: Select Primitive]]
- [[_COMMUNITY_Golden Rules & Confirm Gate|Golden Rules & Confirm Gate]]
- [[_COMMUNITY_UI Sheet Primitive|UI: Sheet Primitive]]
- [[_COMMUNITY_UI Dialog Primitive|UI: Dialog Primitive]]
- [[_COMMUNITY_Git Watch|Git Watch]]
- [[_COMMUNITY_Runtime Auth & Env|Runtime: Auth & Env]]
- [[_COMMUNITY_Chat Page & SSE Stream|Chat Page & SSE Stream]]
- [[_COMMUNITY_MARVIN Persona & Phase 2|MARVIN Persona & Phase 2]]
- [[_COMMUNITY_UI Table Primitive|UI: Table Primitive]]
- [[_COMMUNITY_MARVIN Brain Visualization|MARVIN Brain Visualization]]
- [[_COMMUNITY_UI Card Primitive|UI: Card Primitive]]
- [[_COMMUNITY_UI Avatar Primitive|UI: Avatar Primitive]]
- [[_COMMUNITY_UI Dropdown Menu|UI: Dropdown Menu]]
- [[_COMMUNITY_Graphify Bridge Docs Refresh|Graphify Bridge: Docs Refresh]]
- [[_COMMUNITY_Embedded Terminal|Embedded Terminal]]
- [[_COMMUNITY_UI Scroll Area|UI: Scroll Area]]
- [[_COMMUNITY_Tools Policy|Tools: Policy]]
- [[_COMMUNITY_File Viewer|File Viewer]]
- [[_COMMUNITY_UI Tabs Primitive|UI: Tabs Primitive]]
- [[_COMMUNITY_UI Utils (cn)|UI: Utils (cn)]]
- [[_COMMUNITY_UI Tooltip|UI: Tooltip]]
- [[_COMMUNITY_UI Badge|UI: Badge]]
- [[_COMMUNITY_UI Separator|UI: Separator]]
- [[_COMMUNITY_UI Button|UI: Button]]
- [[_COMMUNITY_UI Input|UI: Input]]
- [[_COMMUNITY_UI Skeleton|UI: Skeleton]]
- [[_COMMUNITY_Root Layout|Root Layout]]
- [[_COMMUNITY_Chat Tool Call Card|Chat: Tool Call Card]]
- [[_COMMUNITY_Chat Input Box|Chat: Input Box]]
- [[_COMMUNITY_UI Package Index|UI Package Index]]
- [[_COMMUNITY_Tools Package Index|Tools Package Index]]
- [[_COMMUNITY_Runtime Package Index|Runtime Package Index]]
- [[_COMMUNITY_Graphify Bridge Index|Graphify Bridge Index]]
- [[_COMMUNITY_Next.js Type Shim|Next.js Type Shim]]
- [[_COMMUNITY_Next.js Config|Next.js Config]]
- [[_COMMUNITY_Chat Message View|Chat: Message View]]
- [[_COMMUNITY_Chat Types|Chat: Types]]
- [[_COMMUNITY_Shell Status Bar|Shell: Status Bar]]
- [[_COMMUNITY_File Tree|File Tree]]

## God Nodes (most connected - your core abstractions)
1. `GET()` - 11 edges
2. `8-Phase Senior-Engineer Workflow` - 10 edges
3. `Target Architecture (apps + packages tree)` - 9 edges
4. `POST()` - 8 edges
5. `JARVIS Autonomous Multi-Agent Failure Mode` - 8 edges
6. `App: apps/web (Next.js 16 on port 3030)` - 8 edges
7. `Pivot: Single Pair-Programming Assistant` - 7 edges
8. `Package: @marvin/project-context (spec + infra probes)` - 7 edges
9. `getAnthropicAuth()` - 6 edges
10. `Decision: Single Agent with On-Demand Subagents via Task tool` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Rule: Single Assistant, Not an Agent Team` --semantically_similar_to--> `Decision: Single Agent with On-Demand Subagents via Task tool`  [INFERRED] [semantically similar]
  CLAUDE.md → PLAN.md
- `Rule: Plan-first, Execute-second, Verify-third` --semantically_similar_to--> `8-Phase Senior-Engineer Workflow`  [INFERRED] [semantically similar]
  CLAUDE.md → PLAN.md
- `Marvin Repo Layout (apps/web + packages/*)` --semantically_similar_to--> `Target Architecture (apps + packages tree)`  [INFERRED] [semantically similar]
  README.md → PLAN.md
- `Rule: User Project is a Separate Workspace` --semantically_similar_to--> `Decision: Zero hardcoded project knowledge (isolation)`  [INFERRED] [semantically similar]
  CLAUDE.md → PLAN.md
- `Rule: No Hardcoded Project Knowledge` --semantically_similar_to--> `Decision: Zero hardcoded project knowledge (isolation)`  [INFERRED] [semantically similar]
  CLAUDE.md → PLAN.md

## Hyperedges (group relationships)
- **Three-layer ramification stack (graph + ADRs + memory)** — plan_layer_graphify, plan_layer_adr, plan_layer_memory, plan_rationale_ramification_problem [EXTRACTED 0.95]
- **8-phase senior-engineer workflow** — plan_phase_intake, plan_phase_discovery, plan_phase_impact_analysis, plan_phase_architecture, plan_phase_plan, plan_phase_implement, plan_phase_verify, plan_phase_ship [EXTRACTED 1.00]
- **Single-agent architecture decision + rationales** — plan_decision_single_agent, plan_rationale_multi_agent_research, plan_rationale_70pct_degradation, plan_rationale_17x_error_amplification, plan_jarvis_failure [EXTRACTED 0.95]

## Communities

### Community 0 - "API Surface & Data Layout"
Cohesion: 0.09
Nodes (28): MARVIN_DATA_DIR (~/.marvin/) — sessions, cost-tracker, projects, API: POST /api/chat (SSE streaming), API: GET /api/files/content, API: GET /api/files/status (git porcelain), API: GET /api/files/tree, API: POST /api/graph/query (graphify passthrough), API: POST /api/terminal/run (SSE stdout/stderr), App: apps/web (Next.js 16 on port 3030) (+20 more)

### Community 1 - "Runtime: Claude CLI & Paths"
Cohesion: 0.13
Nodes (11): defaultModel(), discoverClaudeBinary(), runClaudeCli(), getHomeDir(), getMarvinDataDir(), GET(), runGit(), findGraphifyBin() (+3 more)

### Community 2 - "Project Context & Infra Probes"
Cohesion: 0.12
Nodes (10): buildProjectContext(), readAdrs(), formatProbeBlock(), runProbes(), buildSystemPrompt(), POST(), shellFor(), slugifyCwd() (+2 more)

### Community 3 - "Context Hierarchy & Workflow"
Cohesion: 0.15
Nodes (19): Rule: No Truncation of Project Context, Layer 2: Architecture Decision Records (docs/adr/*.md), Layer 1: Structural Impact Analysis (graphify graph.json), Layer 3: Running Project Memory (.marvin/memory.md), Workflow Step 4: Architecture (ADRs), Workflow Step 2: Discovery (graphify-first), Workflow Step 3: Impact Analysis (blast radius), Workflow Step 6: Implement (diff preview gate) (+11 more)

### Community 4 - "Architectural Decisions & Phases"
Cohesion: 0.16
Nodes (16): Advisor Strategy (Sonnet executor + Opus advisor), Decision: Name is MARVIN, Decision: Default model Claude Opus 4.7, Decision: Rebuild from scratch at ~/marvin/, Decision: Single Agent with On-Demand Subagents via Task tool, Decision: Primary surface is web app on localhost:3030, JARVIS Autonomous Multi-Agent Failure Mode, Phase 5: Stretch (Advisor Strategy, Honeycomb MCP, Playwright) (+8 more)

### Community 5 - "UI: Select Primitive"
Cohesion: 0.2
Nodes (0): 

### Community 6 - "Golden Rules & Confirm Gate"
Cohesion: 0.22
Nodes (10): MARVIN Golden Rules (CLAUDE.md), Rule: Confirm-before-act for Risky Tools, Rule: No Hardcoded Project Knowledge, Rule: Plan-first, Execute-second, Verify-third, Rule: User Project is a Separate Workspace, Rule: Single Assistant, Not an Agent Team, API: POST /api/confirm (allow/deny), Decision: Zero hardcoded project knowledge (isolation) (+2 more)

### Community 7 - "UI: Sheet Primitive"
Cohesion: 0.29
Nodes (0): 

### Community 8 - "UI: Dialog Primitive"
Cohesion: 0.33
Nodes (0): 

### Community 9 - "Git Watch"
Cohesion: 0.53
Nodes (4): detectNewCommits(), getCurrentHead(), gitHead(), listCommitsSince()

### Community 10 - "Runtime: Auth & Env"
Cohesion: 0.67
Nodes (5): buildSubprocessEnv(), getAnthropicAuth(), isOAuthToken(), maskKey(), trimEnv()

### Community 11 - "Chat Page & SSE Stream"
Cohesion: 0.33
Nodes (2): Home(), useChatStream()

### Community 12 - "MARVIN Persona & Phase 2"
Cohesion: 0.33
Nodes (6): Component: MarvinBrain (SVG neural visualization), MARVIN Persona (Hitchhiker's Guide Dry Wit), personality.ts (CORE_BEHAVIOR system prompt), Phase 2: Chat + Tools (shipped 2026-04-17), Pending (Phase 2): Structural confirm-before-act gate, Pending (Phase 2): packages/tools actual tool implementations

### Community 13 - "UI: Table Primitive"
Cohesion: 0.4
Nodes (0): 

### Community 14 - "MARVIN Brain Visualization"
Cohesion: 0.4
Nodes (0): 

### Community 15 - "UI: Card Primitive"
Cohesion: 0.5
Nodes (0): 

### Community 16 - "UI: Avatar Primitive"
Cohesion: 0.5
Nodes (0): 

### Community 17 - "UI: Dropdown Menu"
Cohesion: 0.5
Nodes (0): 

### Community 18 - "Graphify Bridge: Docs Refresh"
Cohesion: 0.83
Nodes (3): extractionPrompt(), parseJsonPayload(), refreshDocs()

### Community 19 - "Embedded Terminal"
Cohesion: 0.67
Nodes (2): loadHistory(), mount()

### Community 20 - "UI: Scroll Area"
Cohesion: 0.67
Nodes (0): 

### Community 21 - "Tools: Policy"
Cohesion: 1.0
Nodes (2): defaultReason(), toolPolicy()

### Community 22 - "File Viewer"
Cohesion: 0.67
Nodes (0): 

### Community 23 - "UI: Tabs Primitive"
Cohesion: 1.0
Nodes (0): 

### Community 24 - "UI: Utils (cn)"
Cohesion: 1.0
Nodes (0): 

### Community 25 - "UI: Tooltip"
Cohesion: 1.0
Nodes (0): 

### Community 26 - "UI: Badge"
Cohesion: 1.0
Nodes (0): 

### Community 27 - "UI: Separator"
Cohesion: 1.0
Nodes (0): 

### Community 28 - "UI: Button"
Cohesion: 1.0
Nodes (0): 

### Community 29 - "UI: Input"
Cohesion: 1.0
Nodes (0): 

### Community 30 - "UI: Skeleton"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Root Layout"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Chat: Tool Call Card"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Chat: Input Box"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "UI Package Index"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Tools Package Index"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Runtime Package Index"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Graphify Bridge Index"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Next.js Type Shim"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Next.js Config"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Chat: Message View"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Chat: Types"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Shell: Status Bar"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "File Tree"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **28 isolated node(s):** `Pair-Programming AI Assistant`, `Decision: Name is MARVIN`, `Decision: Primary surface is web app on localhost:3030`, `Rationale: 2026 Multi-Agent Research (Google/UIUC/MS/Anthropic)`, `Rationale: Multi-agent degrades up to 70% on sequential code` (+23 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `UI: Tabs Primitive`** (2 nodes): `cn()`, `tabs.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Utils (cn)`** (2 nodes): `utils.ts`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Tooltip`** (2 nodes): `TooltipContent()`, `tooltip.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Badge`** (2 nodes): `Badge()`, `badge.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Separator`** (2 nodes): `Separator()`, `separator.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Button`** (2 nodes): `cn()`, `button.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Input`** (2 nodes): `Input()`, `input.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI: Skeleton`** (2 nodes): `Skeleton()`, `skeleton.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Root Layout`** (2 nodes): `RootLayout()`, `layout.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chat: Tool Call Card`** (2 nodes): `toolDescriptor()`, `tool-call-card.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chat: Input Box`** (2 nodes): `submit()`, `chat-input.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `UI Package Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Tools Package Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Runtime Package Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Graphify Bridge Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Type Shim`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Next.js Config`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chat: Message View`** (1 nodes): `message-view.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Chat: Types`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Shell: Status Bar`** (1 nodes): `status-bar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `File Tree`** (1 nodes): `file-tree.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Target Architecture (apps + packages tree)` connect `API Surface & Data Layout` to `Context Hierarchy & Workflow`, `Golden Rules & Confirm Gate`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `GET()` connect `Runtime: Claude CLI & Paths` to `Git Watch`, `Runtime: Auth & Env`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `Package: @marvin/project-context (spec + infra probes)` connect `Context Hierarchy & Workflow` to `API Surface & Data Layout`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `GET()` (e.g. with `detectNewCommits()` and `getState()`) actually correct?**
  _`GET()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `Target Architecture (apps + packages tree)` (e.g. with `Marvin Tech Stack (Next.js 16 + TS + Tailwind 4 + shadcn)` and `Marvin Repo Layout (apps/web + packages/*)`) actually correct?**
  _`Target Architecture (apps + packages tree)` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `POST()` (e.g. with `defaultModel()` and `buildSystemPrompt()`) actually correct?**
  _`POST()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Pair-Programming AI Assistant`, `Decision: Name is MARVIN`, `Decision: Primary surface is web app on localhost:3030` to the rest of the system?**
  _28 weakly-connected nodes found - possible documentation gaps or missing edges._
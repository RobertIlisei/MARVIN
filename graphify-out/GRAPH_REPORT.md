# Graph Report - .  (2026-04-19)

## Corpus Check
- 0 files · ~99,999 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 455 nodes · 497 edges · 84 communities detected
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 77 edges (avg confidence: 0.81)
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
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]

## God Nodes (most connected - your core abstractions)
1. `GET()` - 32 edges
2. `POST()` - 19 edges
3. `ADR-0001 — Single assistant, not an agent team` - 10 edges
4. `8-Phase Senior-Engineer Workflow Doc` - 10 edges
5. `ADR index + numbering convention + template` - 8 edges
6. `HTTP API Reference` - 8 edges
7. `getAnthropicAuth()` - 7 edges
8. `DELETE()` - 7 edges
9. `readProjectsFile()` - 6 edges
10. `removeProject()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Four capability cards (Reads Code / Plans First / Writes Diffs / Runs Tools)` --semantically_similar_to--> `Confirm-Before-Act Gate Doc`  [INFERRED] [semantically similar]
  hero.png → docs/concepts/confirm-gate.md
- `MARVIN hero/landing UI screenshot` --semantically_similar_to--> `MARVIN Overview`  [INFERRED] [semantically similar]
  hero.png → docs/getting-started/overview.md
- `Header pills (project picker, today $3.69, perms, models, voice, panes)` --semantically_similar_to--> `CostPill header component`  [INFERRED] [semantically similar]
  hero.png → docs/operations/cost-tracking.md
- `Header pills (project picker, today $3.69, perms, models, voice, panes)` --semantically_similar_to--> `Two-slot model picker (2026-04-18 refresh)`  [INFERRED] [semantically similar]
  hero.png → docs/concepts/advisor-strategy.md
- `POST()` --calls--> `resolveRuntimeMode()`  [INFERRED]
  apps/web/src/app/api/confirm/route.ts → packages/runtime/src/sdk-runner.ts

## Hyperedges (group relationships)
- **Single-assistant philosophy coalition** — adr_0001_single_assistant, readme_single_assistant_differentiator, plan_8_phase_workflow, vision_doc, claudemd_golden_rules [INFERRED 0.90]
- **Structural confirm gate + tool policy + data flow** — adr_0004_structural_confirm_gate, toolpolicy_tool_policy_doc, dataflow_data_flow_doc, review_important_definition [INFERRED 0.85]
- **Per-project isolation contract + memory/ADR layering** — adr_0005_per_project_isolation, plan_isolation_contract, plan_three_layer_ramification_stack, vision_doc, claudemd_data_dir [INFERRED 0.85]
- **Three-layer ramification stack (graph + ADRs + memory)** — graphify_integration_doc, memory_and_adrs_doc, isolation_contract_doc, eight_phase_workflow_doc [EXTRACTED 1.00]
- **Single-turn runtime participants (API + gate + sessions + MCP)** — architecture_doc, post_api_chat, confirm_gate_doc, sessions_doc, marvin_graph_mcp, marvin_playwright_mcp [INFERRED 0.90]
- **Operational observability surfaces (cost + sessions + health)** — cost_tracking_doc, sessions_doc, observability_doc, health_endpoint_doc [INFERRED 0.90]

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (52): Research: up to 70% degradation and 17x error amplification in multi-agent setups, ADR-0001 — Single assistant, not an agent team, Subagent delegation escape hatch (breadth-first, bulk, context relief only), Model override levels (per-turn body.model > localStorage picker > MARVIN_MODEL), ADR-0002 — Default to Claude Opus 4.7, ADR-0003 — Advisor strategy as experiment, resolveRuntimeMode() maps opus|advisor to model+advisorModel, canUseTool callback + confirm-registry (turnId, toolUseId) → resolver map (+44 more)

### Community 1 - "Community 1"
Cohesion: 0.1
Nodes (23): ensureDir(), getHomeDir(), getMarvinDataDir(), buildSystemPrompt(), addProject(), getActiveProjectId(), getProject(), listProjects() (+15 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (20): getPendingOriginalInput(), registerPendingConfirm(), resolvePendingConfirm(), detectNewCommits(), getCurrentHead(), gitHead(), listCommitsSince(), resetCommitCursor() (+12 more)

### Community 3 - "Community 3"
Cohesion: 0.1
Nodes (22): Auth detection order (api-key > env token > ~/.claude > mac keychain > none), Credentials Doc, model → defaultModel rename (2026-04-19), Environment Variables Reference, Fallback-model-list fix (set ANTHROPIC_API_KEY on macOS), Global shortcuts (⌘K, ⌘⇧N, ⌘., ?, Esc), /api/health response schema (ok/auth/claudeBinary/defaultModel/dataDir), Health Check Endpoint Doc (+14 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (17): Architecture at a Glance, Brain state indicator (idle/thinking/tool/writing/error), GET /api/chat/resume SSE reconnect, Four graph tools: summary/search/neighbors/path, Honeycomb MCP integration (Phase 5 stretch, deferred), Host Playwright MCP sandboxes localhost — reason to ship own, JSONL transcript format (turn.user/cli.event/turn.completed/turn.error), localhost-only network boundary (no MARVIN backend) (+9 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (18): Brain the size of a planet quote, 8-Phase Senior-Engineer Workflow Doc, Multi-agent degrades quality up to ~70% (2026 research), MARVIN Overview, Phase 1 — Intake, Phase 2 — Discovery (graph + ADR + memory read), Phase 3 — Impact Analysis (blast radius), Phase 4 — Architecture (ADR authoring) (+10 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (18): ADR template (Context/Decision/Consequences/Alternatives), .claude/skills/ pinned bundle checked in, Cross-project contamination failure mode (prevented), Solo-plus-AI cross-session ramification problem, First-message graph header injection, Fresh project starts from zero (no templates), Graphify Integration Doc, graphify-bridge watchdog auto-refresh (10 min debounce) (+10 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (15): Advisor Strategy Doc, Advisor tool (internal SDK tool, executor-driven escalation), CostPill header component, cost-tracker.json append-on-turn ledger, Cost Tracking Operations Doc, GET /api/cost aggregation (today/week/lifetime/daily), Circular brain/knowledge-graph visualization (declination markings), Four capability cards (Reads Code / Plans First / Writes Diffs / Runs Tools) (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (8): clearTurnConfirms(), createGraphMcpServer(), createPlaywrightMcpConfig(), findWorkspaceRoot(), resolveCliPath(), trimEnv(), resolveRuntimeMode(), runAgent()

### Community 9 - "Community 9"
Cohesion: 0.15
Nodes (13): /api/files tree + content + status, POST /api/graph/query passthrough, GET /api/models (live + fallback), /api/projects CRUD + verify + active, POST /api/terminal/run (SSE spawn via $SHELL -c), Auto mode (bypassPermissions — default), Confirm-Before-Act Gate Doc, Gated mode via canUseTool callback (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.33
Nodes (9): buildSubprocessEnv(), getAnthropicAuth(), hasHostCredentialsOnDisk(), isOAuthToken(), maskKey(), trimEnv(), buildAuthHeaders(), listModels() (+1 more)

### Community 11 - "Community 11"
Cohesion: 0.2
Nodes (0): 

### Community 12 - "Community 12"
Cohesion: 0.36
Nodes (7): buildProjectContext(), readAdrs(), checkWorkflowHealth(), countAdrs(), formatWorkflowHealthBlock(), memoryHasContent(), walkRepo()

### Community 13 - "Community 13"
Cohesion: 0.46
Nodes (7): dayKey(), emptyAggregate(), fold(), readCostFile(), recordTurnCost(), summarizeCost(), writeCostFile()

### Community 14 - "Community 14"
Cohesion: 0.29
Nodes (0): 

### Community 15 - "Community 15"
Cohesion: 0.43
Nodes (4): onKey(), loadHistory(), mount(), saveHistory()

### Community 16 - "Community 16"
Cohesion: 0.33
Nodes (0): 

### Community 17 - "Community 17"
Cohesion: 0.33
Nodes (6): God nodes list (GET, POST, runAgent, buildProjectContext, toolPolicy...), Target Architecture (Repo Layout), Workspace layout (1 app + 6 packages pnpm monorepo), Module boundary rules (tools imports nothing; runtime doesn't import web), packages/runtime file responsibilities table, Turbo pipeline (build, dev, typecheck, clean)

### Community 18 - "Community 18"
Cohesion: 0.4
Nodes (0): 

### Community 19 - "Community 19"
Cohesion: 0.5
Nodes (2): appendSessionTurn(), ensureDir()

### Community 20 - "Community 20"
Cohesion: 0.4
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 0.7
Nodes (4): findGraphifyBin(), getState(), gitHead(), maybeRefreshGraphify()

### Community 22 - "Community 22"
Cohesion: 0.6
Nodes (3): defaultModel(), discoverClaudeBinary(), runClaudeCli()

### Community 23 - "Community 23"
Cohesion: 0.4
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 0.5
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 0.5
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 0.5
Nodes (0): 

### Community 27 - "Community 27"
Cohesion: 0.5
Nodes (0): 

### Community 28 - "Community 28"
Cohesion: 0.83
Nodes (3): extractionPrompt(), parseJsonPayload(), refreshDocs()

### Community 29 - "Community 29"
Cohesion: 0.5
Nodes (0): 

### Community 30 - "Community 30"
Cohesion: 0.5
Nodes (0): 

### Community 31 - "Community 31"
Cohesion: 0.5
Nodes (0): 

### Community 32 - "Community 32"
Cohesion: 0.5
Nodes (4): Automated tests (deferred — zero tests currently), MARVIN has no automated tests of its own, Reasonable test strategy (unit > API-integration > E2E > SDK-in-loop), TypeScript strict mode + noUncheckedIndexedAccess as substitute

### Community 33 - "Community 33"
Cohesion: 0.67
Nodes (0): 

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (2): defaultReason(), toolPolicy()

### Community 35 - "Community 35"
Cohesion: 0.67
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 0.67
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 0.67
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 0.67
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 0.67
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 0.67
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 0.67
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
Nodes (0): 

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
Nodes (0): 

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (0): 

### Community 61 - "Community 61"
Cohesion: 1.0
Nodes (0): 

### Community 62 - "Community 62"
Cohesion: 1.0
Nodes (2): Playwright MCP env knobs (MARVIN_PLAYWRIGHT*), In-process MCP servers (marvin-graph + marvin-playwright)

### Community 63 - "Community 63"
Cohesion: 1.0
Nodes (2): Licensing (not yet specified, probably MIT or Apache 2.0), License (deferred — probably MIT or Apache 2.0)

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (0): 

### Community 65 - "Community 65"
Cohesion: 1.0
Nodes (0): 

### Community 66 - "Community 66"
Cohesion: 1.0
Nodes (0): 

### Community 67 - "Community 67"
Cohesion: 1.0
Nodes (0): 

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (0): 

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (0): 

### Community 70 - "Community 70"
Cohesion: 1.0
Nodes (0): 

### Community 71 - "Community 71"
Cohesion: 1.0
Nodes (0): 

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (0): 

### Community 73 - "Community 73"
Cohesion: 1.0
Nodes (0): 

### Community 74 - "Community 74"
Cohesion: 1.0
Nodes (0): 

### Community 75 - "Community 75"
Cohesion: 1.0
Nodes (0): 

### Community 76 - "Community 76"
Cohesion: 1.0
Nodes (0): 

### Community 77 - "Community 77"
Cohesion: 1.0
Nodes (0): 

### Community 78 - "Community 78"
Cohesion: 1.0
Nodes (0): 

### Community 79 - "Community 79"
Cohesion: 1.0
Nodes (0): 

### Community 80 - "Community 80"
Cohesion: 1.0
Nodes (1): MARVIN brain (5-state animated indicator)

### Community 81 - "Community 81"
Cohesion: 1.0
Nodes (1): Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘., ?, Esc)

### Community 82 - "Community 82"
Cohesion: 1.0
Nodes (1): Skills MARVIN expects (design, docs, data, engineering, operations)

### Community 83 - "Community 83"
Cohesion: 1.0
Nodes (1): Honeycomb MCP integration (deferred)

## Knowledge Gaps
- **101 isolated node(s):** `Plan-first, execute-second, verify-third`, `Stack: Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui`, `MARVIN brain (5-state animated indicator)`, `Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘., ?, Esc)`, `Phase 2 — Chat + tools (shipped 2026-04-17)` (+96 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 42`** (2 nodes): `cn()`, `tabs.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (2 nodes): `utils.ts`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (2 nodes): `TooltipContent()`, `tooltip.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (2 nodes): `Badge()`, `badge.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (2 nodes): `Separator()`, `separator.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (2 nodes): `cn()`, `button.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (2 nodes): `Input()`, `input.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (2 nodes): `Skeleton()`, `skeleton.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (2 nodes): `runGit()`, `route.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (2 nodes): `layout.tsx`, `RootLayout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (2 nodes): `page.tsx`, `onKey()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (2 nodes): `permission-toggle.tsx`, `PermissionToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (2 nodes): `personality-toggle.tsx`, `PersonalityToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (2 nodes): `cost-pill.tsx`, `fmtUsd()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (2 nodes): `diff-viewer.tsx`, `onMount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (2 nodes): `branch-badge.tsx`, `BranchBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (2 nodes): `use-projects.ts`, `useProjects()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (2 nodes): `submit()`, `add-project-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (2 nodes): `project-picker.tsx`, `fmtWhen()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (2 nodes): `brain-liquid.tsx`, `BrainLiquid()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (2 nodes): `Playwright MCP env knobs (MARVIN_PLAYWRIGHT*)`, `In-process MCP servers (marvin-graph + marvin-playwright)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (2 nodes): `Licensing (not yet specified, probably MIT or Apache 2.0)`, `License (deferred — probably MIT or Apache 2.0)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 65`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 66`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (1 nodes): `route.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (1 nodes): `route.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 71`** (1 nodes): `route.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (1 nodes): `message-view.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 73`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (1 nodes): `status-bar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 75`** (1 nodes): `file-tree.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 76`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 77`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 78`** (1 nodes): `graph-panel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 79`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 80`** (1 nodes): `MARVIN brain (5-state animated indicator)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 81`** (1 nodes): `Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘., ?, Esc)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 82`** (1 nodes): `Skills MARVIN expects (design, docs, data, engineering, operations)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 83`** (1 nodes): `Honeycomb MCP integration (deferred)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GET()` connect `Community 2` to `Community 1`, `Community 8`, `Community 10`, `Community 13`, `Community 21`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `HTTP API Reference` connect `Community 9` to `Community 3`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `POST()` connect `Community 1` to `Community 8`, `Community 2`, `Community 12`, `Community 22`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Are the 21 inferred relationships involving `GET()` (e.g. with `detectNewCommits()` and `listProjects()`) actually correct?**
  _`GET()` has 21 INFERRED edges - model-reasoned connections that need verification._
- **Are the 13 inferred relationships involving `POST()` (e.g. with `defaultModel()` and `slugifyWorkDir()`) actually correct?**
  _`POST()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Plan-first, execute-second, verify-third`, `Stack: Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui`, `MARVIN brain (5-state animated indicator)` to the rest of the system?**
  _101 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
# GRAPH REPORT — 2026-05-05 (post-ADR-0021-M5 update)

**1348 nodes · 1680 edges · 231 communities**

WebView.swift and marvin-shell.ts deleted (ADR-0021 M5). MarvinBridge is now a pure @Observable state bucket.

## Summary
- 1917 nodes · 2705 edges · 227 communities detected
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 475 edges (avg confidence: 0.8)
- Token cost: 4,200 input · 1,800 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Next.js API Routes (Web Server)|Next.js API Routes (Web Server)]]
- [[_COMMUNITY_SwiftUI Migration Architecture (ADR-0016)|SwiftUI Migration Architecture (ADR-0016)]]
- [[_COMMUNITY_Swift macOS App Shell + Tauri Wrapper|Swift macOS App Shell + Tauri Wrapper]]
- [[_COMMUNITY_Swift Data Models + Bridge Types|Swift Data Models + Bridge Types]]
- [[_COMMUNITY_MARVIN ADR Decisions + Project Context|MARVIN ADR Decisions + Project Context]]
- [[_COMMUNITY_Native Pane Views (Input, Preview, Split)|Native Pane Views (Input, Preview, Split)]]
- [[_COMMUNITY_Native Chat Surface (Phase 2)|Native Chat Surface (Phase 2)]]
- [[_COMMUNITY_Auto-mode Policy Floor + Audit Log (ADR-0015)|Auto-mode Policy Floor + Audit Log (ADR-0015)]]
- [[_COMMUNITY_Brain Rendering (Metal + Web Canvas)|Brain Rendering (Metal + Web Canvas)]]
- [[_COMMUNITY_Syntax Highlighting + Shortcuts|Syntax Highlighting + Shortcuts]]
- [[_COMMUNITY_File Viewer (Native + Web)|File Viewer (Native + Web)]]
- [[_COMMUNITY_Files Service + Chat Stream Reducer|Files Service + Chat Stream Reducer]]
- [[_COMMUNITY_Native UI Components (Status, Attachments)|Native UI Components (Status, Attachments)]]
- [[_COMMUNITY_Swift Bridge + API Endpoints|Swift Bridge + API Endpoints]]
- [[_COMMUNITY_File Type Icons + Metadata|File Type Icons + Metadata]]
- [[_COMMUNITY_Confirm Gate + Auth + Subprocess|Confirm Gate + Auth + Subprocess]]
- [[_COMMUNITY_File Tree + Source Control Views|File Tree + Source Control Views]]
- [[_COMMUNITY_Advisor Subagent Pattern (ADR-0007)|Advisor Subagent Pattern (ADR-0007)]]
- [[_COMMUNITY_Quick Open + File Tree Interactions|Quick Open + File Tree Interactions]]
- [[_COMMUNITY_Terminal Pane (Native SSE)|Terminal Pane (Native SSE)]]
- [[_COMMUNITY_macOS Status Bar + App Delegate|macOS Status Bar + App Delegate]]
- [[_COMMUNITY_UI Audit 2026-04-26 Findings|UI Audit 2026-04-26 Findings]]
- [[_COMMUNITY_marvin-shell.ts JS-Swift Bridge|marvin-shell.ts JS-Swift Bridge]]
- [[_COMMUNITY_shadcn Select Components|shadcn Select Components]]
- [[_COMMUNITY_Git Porcelain v2 Parser|Git Porcelain v2 Parser]]
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
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 101|Community 101]]
- [[_COMMUNITY_Community 102|Community 102]]
- [[_COMMUNITY_Community 103|Community 103]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 105|Community 105]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 108|Community 108]]
- [[_COMMUNITY_Community 109|Community 109]]
- [[_COMMUNITY_Community 110|Community 110]]
- [[_COMMUNITY_Community 111|Community 111]]
- [[_COMMUNITY_Community 112|Community 112]]
- [[_COMMUNITY_Community 113|Community 113]]
- [[_COMMUNITY_Community 114|Community 114]]
- [[_COMMUNITY_Community 115|Community 115]]
- [[_COMMUNITY_Community 116|Community 116]]
- [[_COMMUNITY_Community 117|Community 117]]
- [[_COMMUNITY_Community 118|Community 118]]
- [[_COMMUNITY_Community 119|Community 119]]
- [[_COMMUNITY_Community 120|Community 120]]
- [[_COMMUNITY_Community 121|Community 121]]
- [[_COMMUNITY_Community 122|Community 122]]
- [[_COMMUNITY_Community 123|Community 123]]
- [[_COMMUNITY_Community 124|Community 124]]
- [[_COMMUNITY_Community 125|Community 125]]
- [[_COMMUNITY_Community 126|Community 126]]
- [[_COMMUNITY_Community 127|Community 127]]
- [[_COMMUNITY_Community 128|Community 128]]
- [[_COMMUNITY_Community 129|Community 129]]
- [[_COMMUNITY_Community 130|Community 130]]
- [[_COMMUNITY_Community 131|Community 131]]
- [[_COMMUNITY_Community 132|Community 132]]
- [[_COMMUNITY_Community 133|Community 133]]
- [[_COMMUNITY_Community 134|Community 134]]
- [[_COMMUNITY_Community 135|Community 135]]
- [[_COMMUNITY_Community 136|Community 136]]
- [[_COMMUNITY_Community 137|Community 137]]
- [[_COMMUNITY_Community 138|Community 138]]
- [[_COMMUNITY_Community 139|Community 139]]
- [[_COMMUNITY_Community 140|Community 140]]
- [[_COMMUNITY_Community 141|Community 141]]
- [[_COMMUNITY_Community 142|Community 142]]
- [[_COMMUNITY_Community 143|Community 143]]
- [[_COMMUNITY_Community 144|Community 144]]
- [[_COMMUNITY_Community 145|Community 145]]
- [[_COMMUNITY_Community 146|Community 146]]
- [[_COMMUNITY_Community 147|Community 147]]
- [[_COMMUNITY_Community 148|Community 148]]
- [[_COMMUNITY_Community 149|Community 149]]
- [[_COMMUNITY_Community 150|Community 150]]
- [[_COMMUNITY_Community 151|Community 151]]
- [[_COMMUNITY_Community 152|Community 152]]
- [[_COMMUNITY_Community 153|Community 153]]
- [[_COMMUNITY_Community 154|Community 154]]
- [[_COMMUNITY_Community 155|Community 155]]
- [[_COMMUNITY_Community 156|Community 156]]
- [[_COMMUNITY_Community 157|Community 157]]
- [[_COMMUNITY_Community 158|Community 158]]
- [[_COMMUNITY_Community 159|Community 159]]
- [[_COMMUNITY_Community 160|Community 160]]
- [[_COMMUNITY_Community 161|Community 161]]
- [[_COMMUNITY_Community 162|Community 162]]
- [[_COMMUNITY_Community 163|Community 163]]
- [[_COMMUNITY_Community 164|Community 164]]
- [[_COMMUNITY_Community 165|Community 165]]
- [[_COMMUNITY_Community 166|Community 166]]
- [[_COMMUNITY_Community 167|Community 167]]
- [[_COMMUNITY_Community 168|Community 168]]
- [[_COMMUNITY_Community 169|Community 169]]
- [[_COMMUNITY_Community 170|Community 170]]
- [[_COMMUNITY_Community 171|Community 171]]
- [[_COMMUNITY_Community 172|Community 172]]
- [[_COMMUNITY_Community 173|Community 173]]
- [[_COMMUNITY_Community 174|Community 174]]
- [[_COMMUNITY_Community 175|Community 175]]
- [[_COMMUNITY_Community 176|Community 176]]
- [[_COMMUNITY_Community 177|Community 177]]
- [[_COMMUNITY_Community 178|Community 178]]
- [[_COMMUNITY_Community 179|Community 179]]
- [[_COMMUNITY_Community 180|Community 180]]
- [[_COMMUNITY_Community 181|Community 181]]
- [[_COMMUNITY_Community 182|Community 182]]
- [[_COMMUNITY_Community 183|Community 183]]
- [[_COMMUNITY_Community 184|Community 184]]
- [[_COMMUNITY_Community 185|Community 185]]
- [[_COMMUNITY_Community 186|Community 186]]
- [[_COMMUNITY_Community 187|Community 187]]
- [[_COMMUNITY_Community 188|Community 188]]
- [[_COMMUNITY_Community 189|Community 189]]
- [[_COMMUNITY_Community 190|Community 190]]
- [[_COMMUNITY_Community 191|Community 191]]
- [[_COMMUNITY_Community 192|Community 192]]
- [[_COMMUNITY_Community 193|Community 193]]
- [[_COMMUNITY_Community 194|Community 194]]
- [[_COMMUNITY_Community 195|Community 195]]
- [[_COMMUNITY_Community 196|Community 196]]
- [[_COMMUNITY_Community 197|Community 197]]
- [[_COMMUNITY_Community 198|Community 198]]
- [[_COMMUNITY_Community 199|Community 199]]
- [[_COMMUNITY_Community 200|Community 200]]
- [[_COMMUNITY_Community 201|Community 201]]
- [[_COMMUNITY_Community 202|Community 202]]
- [[_COMMUNITY_Community 203|Community 203]]
- [[_COMMUNITY_Community 204|Community 204]]
- [[_COMMUNITY_Community 205|Community 205]]
- [[_COMMUNITY_Community 206|Community 206]]
- [[_COMMUNITY_Community 207|Community 207]]
- [[_COMMUNITY_Community 208|Community 208]]
- [[_COMMUNITY_Community 209|Community 209]]
- [[_COMMUNITY_Community 210|Community 210]]
- [[_COMMUNITY_Community 211|Community 211]]
- [[_COMMUNITY_Community 212|Community 212]]
- [[_COMMUNITY_Community 213|Community 213]]
- [[_COMMUNITY_Community 214|Community 214]]
- [[_COMMUNITY_Community 215|Community 215]]
- [[_COMMUNITY_Community 216|Community 216]]
- [[_COMMUNITY_Community 217|Community 217]]
- [[_COMMUNITY_Community 218|Community 218]]
- [[_COMMUNITY_Community 219|Community 219]]
- [[_COMMUNITY_Community 220|Community 220]]
- [[_COMMUNITY_Community 221|Community 221]]
- [[_COMMUNITY_Community 222|Community 222]]
- [[_COMMUNITY_Community 223|Community 223]]
- [[_COMMUNITY_Community 224|Community 224]]
- [[_COMMUNITY_Community 225|Community 225]]
- [[_COMMUNITY_Community 226|Community 226]]

## God Nodes (most connected - your core abstractions)
1. `GET()` - 68 edges
2. `POST()` - 62 edges
3. `Kind` - 42 edges
4. `string` - 38 edges
5. `trim()` - 29 edges
6. `ADR-0016 (Swift Migration Decision)` - 28 edges
7. `text` - 28 edges
8. `font` - 26 edges
9. `FilesService` - 19 edges
10. `/api/git/* third mutation channel` - 17 edges

## Surprising Connections (you probably didn't know these)
- `MARVIN hero image (hero.png)` --conceptually_related_to--> `ADR-0016 (Swift Migration Decision)`  [AMBIGUOUS]
  hero.png → apps/macos/MARVIN/MARVINApp.swift
- `Single-assistant research claim (70% degradation, 17x error amplification)` --semantically_similar_to--> `Golden Rule 1 — Single assistant, not an agent team`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Three mutation channels (LLM tools, user-initiated FS, git)` --references--> `packages/tools/src/policy.ts (classifier + regex sets)`  [INFERRED]
  docs/reference/api.md → packages/tools/src/policy.ts
- `onDroppedFolder()` --calls--> `addProject()`  [INFERRED]
  apps/web/src/app/page.tsx → packages/runtime/src/projects.ts
- `Decision: 5-minute confirm auto-deny` --implements--> `packages/runtime/src/confirm-registry.ts (5-min timeout)`  [EXTRACTED]
  docs/decisions/0015-auto-mode-policy-floor-and-audit-log.md → packages/runtime/src/confirm-registry.ts

## Hyperedges (group relationships)
- **Review-pipeline triple — REVIEW.md (rules), audit (report), DoD (criteria)** — review_md_disambiguation_header, audit_2026_04_26, dod_audit, dod_plan_changelog, dod_task [EXTRACTED 0.90]
- **Auto-mode policy floor + audit log (ADR-0015 implementation)** — adr_0015, code_packages_tools_policy_ts, code_packages_runtime_sdk_runner_ts, code_packages_runtime_auto_audit_ts, code_apps_web_audit_auto_route_ts, code_packages_runtime_confirm_registry_ts [EXTRACTED 0.95]
- **Three mutation channels share confirm-token + sandbox pattern** — api_files_write_routes, api_git_routes, concept_one_shot_token, concept_fs_path_sandbox, concept_classify_tool_call [EXTRACTED 0.90]

## Communities

### Community 0 - "Next.js API Routes (Web Server)"
Cohesion: 0.02
Nodes (121): submit(), canon(), canonicalizeOp(), submit(), number, defaultModel(), discoverClaudeBinary(), runClaudeCli() (+113 more)

### Community 1 - "SwiftUI Migration Architecture (ADR-0016)"
Cohesion: 0.02
Nodes (161): Alternative — Electron rewrite (rejected: strictly worse than Tauri), Alternative — Native rewrite from scratch (rejected: months of duplicative work), Alternative — Stay on Tauri + push perf harder (rejected: diminishing returns), Architectural shape — SwiftUI process talks HTTP/SSE to Next.js sidecar, Consequences negative — two targets coexist, macOS-only, Xcode+Rust+Node build, learning curve, Consequences positive — native feel, GPU brain, lower memory, system integration, Context — Tauri WebView friction (drag/resize/brain/chrome/memory), Decision — Add SwiftUI macOS target at apps/macos with Node sidecar unchanged (+153 more)

### Community 2 - "Swift macOS App Shell + Tauri Wrapper"
Cohesion: 0.02
Nodes (63): AboutView, App, AppStatusBar, ChatAgentsFooter, ChatAttachment, ChatAttachmentsBar, IconBarButton, Kind (+55 more)

### Community 3 - "Swift Data Models + Bridge Types"
Cohesion: 0.03
Nodes (89): BridgeMessage, BridgeProject, CostSummary, DailyEntry, MarvinBridge, PaneState, AssistantEnvelope, AssistantMessage (+81 more)

### Community 4 - "MARVIN ADR Decisions + Project Context"
Cohesion: 0.03
Nodes (80): ADR-0001 — Single assistant, not an agent team, ADR-0003 — Advisor strategy as experiment, ADR-0004 — Structural confirm gate via Agent SDK, ADR-0005 — Per-project isolation, apps/web (Next.js shell), buildProjectContext(), Changelog extracted from retired PLAN.md (2026-05-04), Advisor strategy (executor + advisor) (+72 more)

### Community 5 - "Native Pane Views (Input, Preview, Split)"
Cohesion: 0.03
Nodes (27): ChatInputBar, ChatTextEditor, Coordinator, WindowAccessor, NSObject, NSTextViewDelegate, NSViewRepresentable, Coordinator (+19 more)

### Community 6 - "Native Chat Surface (Phase 2)"
Cohesion: 0.05
Nodes (38): BrainState, boot, error, idle, thinking, tool, writing, CaseIterable (+30 more)

### Community 7 - "Auto-mode Policy Floor + Audit Log (ADR-0015)"
Cohesion: 0.04
Nodes (63): Alternative A: keep bypassPermissions + separate audit hook (rejected), Alternative B: make gated the default (rejected), Alternative C: separate hard-deny floor + leave bypass (rejected), auto-audit.jsonl entry shape (at, tool, reason, descriptor, turnId, toolUseId), Principle: every mutating tool call goes through classification regardless of strategy, Audit 2026-04-26 finding #2 (leaky hard-deny + Task/NotebookEdit gap), Decision: auto-audit.jsonl audit log, Decision: BASH_HARD_DENY tightened (7 new patterns) (+55 more)

### Community 8 - "Brain Rendering (Metal + Web Canvas)"
Cohesion: 0.05
Nodes (26): advance(), beginTransition(), curlFlow(), easeInOutCubic(), lerpProfile(), profile(), respawn(), step() (+18 more)

### Community 9 - "Syntax Highlighting + Shortcuts"
Cohesion: 0.04
Nodes (38): ClipboardImage, ChatNSTextView, ToolStyle, execute, other, read, web, write (+30 more)

### Community 10 - "File Viewer (Native + Web)"
Cohesion: 0.05
Nodes (14): handleClose(), Buffer, Coordinator, FileViewerModel, FileViewerNSView, FileViewerView, SaveResult, failed (+6 more)

### Community 11 - "Files Service + Chat Stream Reducer"
Cohesion: 0.07
Nodes (16): ChatMessage, ChatStreamReducer, FileSaveOutcome, needsConfirm, ok, stale, FilesService, FilesServiceError (+8 more)

### Community 12 - "Native UI Components (Status, Attachments)"
Cohesion: 0.05
Nodes (50): AppStatusBar, BrainMetalRenderer, BrainMetalView, BrainPaneView, ChatAttachment, ChatAttachmentsBar, ClipboardImage, FileMentionPicker (+42 more)

### Community 13 - "Swift Bridge + API Endpoints"
Cohesion: 0.06
Nodes (45): ADR-0019 (Brain Rendering Architecture), /api/chat (Node Sidecar Chat SSE Endpoint), /api/terminal/run (Node Sidecar Terminal SSE Endpoint), AppDelegate (macOS App Lifecycle Hooks), BrainFrameSlice (Per-Frame GPU Output Bundle), BrainGPUSimulation (Metal GPU Particle Simulation), BrainKernelUniforms (Compute Kernel Per-Frame Uniforms), BrainProfile (Particle Simulation Profile Struct) (+37 more)

### Community 14 - "File Type Icons + Metadata"
Cohesion: 0.05
Nodes (40): FileTypeIcon, Kind, archive, audio, binary, c, cpp, csharp (+32 more)

### Community 15 - "Confirm Gate + Auth + Subprocess"
Cohesion: 0.07
Nodes (19): buildSubprocessEnv(), getAnthropicAuth(), hasHostCredentialsOnDisk(), isOAuthToken(), maskKey(), trimEnv(), classifySeverity(), deny() (+11 more)

### Community 16 - "File Tree + Source Control Views"
Cohesion: 0.08
Nodes (21): FileNode, FileTreeRow, Kind, dir, file, NewEntryContext, NewEntrySheet, RenameContext (+13 more)

### Community 17 - "Advisor Subagent Pattern (ADR-0007)"
Cohesion: 0.08
Nodes (33): ADR-0003 — Advisor strategy (Superseded), ADR-0007 — Advisor as userland subagent pattern, Companion orb description prefix contract (advisor:), Seven deterministic advisor auto-triggers, Advisor strategy — executor + consulted second opinion (concept doc), Opus vs Advisor modes, Architecture at a glance, Auto mode (bypassPermissions) (+25 more)

### Community 18 - "Quick Open + File Tree Interactions"
Cohesion: 0.07
Nodes (15): FileMentionPicker, array, FileTree(), readStoredOpenDirs(), walk(), computeFilterMatches(), commit(), flatten() (+7 more)

### Community 19 - "Terminal Pane (Native SSE)"
Cohesion: 0.1
Nodes (15): Event, end, error, exit, started, stderr, stdout, Kind (+7 more)

### Community 20 - "macOS Status Bar + App Delegate"
Cohesion: 0.12
Nodes (3): AppDelegate, NSApplicationDelegate, StatusBarController

### Community 21 - "UI Audit 2026-04-26 Findings"
Cohesion: 0.15
Nodes (17): Full audit 2026-04-26, Finding #10 — empty-state hero too busy, Finding #11 — confirm prompt fades into chat, Finding #17 — BrainLiquid never pauses, no reduced-motion, Finding #1 — Knowledge graph mis-rooting (RECLASSIFIED), Finding #22 — cancel returns idle before server confirms, Finding #2 — auto permission strategy = silent full bypass, Finding #3 — KNOWN_TOOL_NAMES excludes Task / NotebookEdit (+9 more)

### Community 22 - "marvin-shell.ts JS-Swift Bridge"
Cohesion: 0.32
Nodes (16): announceBranch(), announceBusy(), announceCost(), announceMarvinState(), announceModels(), announcePanes(), announcePermission(), announcePersonality() (+8 more)

### Community 23 - "shadcn Select Components"
Cohesion: 0.2
Nodes (0): 

### Community 24 - "Git Porcelain v2 Parser"
Cohesion: 0.47
Nodes (9): asStatusCode(), parseBranchHeader(), parseIgnored(), parseOrdinary(), parsePorcelainV2(), parseRenameCopy(), parseUnmerged(), parseUntracked() (+1 more)

### Community 25 - "Community 25"
Cohesion: 0.42
Nodes (8): auto(), confirm(), deny(), denyByPath(), fsWritePolicy(), isSameOrParent(), isSecretPath(), relativeFromCwd()

### Community 26 - "Community 26"
Cohesion: 0.25
Nodes (9): MARVIN macOS App Icon, 1024x1024 Canvas with 228px Corner Radius, Brain Internal Folds (Curved Lines), Stylized Brain Glyph, Three Circuit Nodes (Right Side Dots), Circuit Trace Lines from Brain, Indigo Diagonal Gradient (#6366f1 to #312e81), Rounded Square Icon Background (+1 more)

### Community 27 - "Community 27"
Cohesion: 0.25
Nodes (0): 

### Community 28 - "Community 28"
Cohesion: 0.32
Nodes (8): Alternative: Apache 2.0 (close second — patent grant), Alternative: GPL-family (rejected — toolchain incompatibility), Alternative: MIT (chosen), Alternative: MPL 2.0 (file-level copyleft), Contributor inbound=outbound (MIT, no CLA), Decision: MIT License, Licensing — MIT decision (2026-04-21), Rationale — deps are MIT/Apache, solo + AI project, no patents, MIT brevity

### Community 29 - "Community 29"
Cohesion: 0.39
Nodes (8): MARVIN Active Brain Circuit Icon, Brain Outline Path, Bottom Circuit Node (Filled), Middle Circuit Node (Filled), Top Circuit Node (Filled), Inner Brain Curl Detail, macOS Menubar Active State Asset, 24x24 SVG Viewbox

### Community 30 - "Community 30"
Cohesion: 0.36
Nodes (4): friendlyError(), makeAutoModeLogger(), makeGatedCanUseTool(), runAgent()

### Community 31 - "Community 31"
Cohesion: 0.29
Nodes (0): 

### Community 32 - "Community 32"
Cohesion: 0.29
Nodes (3): MonacoEditor(), read(), useTheme()

### Community 33 - "Community 33"
Cohesion: 0.43
Nodes (7): Inner Brain Folds Detail, Stylised Brain Profile Motif, Three Circuit Branches with Terminal Nodes, currentColor Stroke Theming, MARVIN Idle Status Icon (SVG), MARVIN macOS App Resources Bundle, 24x24 Viewbox (Lucide-style Icon Grid)

### Community 34 - "Community 34"
Cohesion: 0.29
Nodes (7): Confirm prompt before/after comparison UI pattern, Confirm Prompt Redesign Mockup, OKLCH design token system (shared across mockups), Empty State Redesign Mockup, Empty state chat layout (frame + canvas + input-row pattern), Top Bar Redesign Mockup, Top bar wordmark + pill + cost display design

### Community 35 - "Community 35"
Cohesion: 0.47
Nodes (4): onMount(), applyMonacoTheme(), ensureMonacoThemes(), themeNameFor()

### Community 36 - "Community 36"
Cohesion: 0.33
Nodes (6): God nodes list (GET, POST, trim, ADR-0015...), Corpus check — 302 files · ~254,837 words, Extraction — 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS (avg 0.8), Graph report god nodes (GET 61, POST 58, trim 29, ADR-0015 17...), Knowledge gaps — 182 isolated nodes + thin communities, Graph report summary (820 nodes · 988 edges · 167 communities)

### Community 37 - "Community 37"
Cohesion: 0.4
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 0.4
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 0.4
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 0.5
Nodes (5): AdvisorOrb (React component), ScoutOrb (React component), scout-ripple CSS animation classes, taskRoleOf + ROLE_PREFIXES helper, task-role.test.ts (description prefix regex invariants)

### Community 41 - "Community 41"
Cohesion: 0.4
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 0.5
Nodes (5): Vision (doc), Non-goals (not Claude Code, not SaaS, not multi-tenant), What success looks like (6/12 months), The bet — single capable assistant, The problem (chat vs multi-agent)

### Community 43 - "Community 43"
Cohesion: 0.4
Nodes (5): Advisor strategy — 30-40% savings, Cost model (doc), Cost controls (levers), Where cost comes from, Typical session costs

### Community 44 - "Community 44"
Cohesion: 0.6
Nodes (1): NotificationManager

### Community 45 - "Community 45"
Cohesion: 0.5
Nodes (5): HighlightLanguage, HighlightSpan, HighlightTheme, RegexHighlighter (fallback), SyntaxHighlighter

### Community 46 - "Community 46"
Cohesion: 0.5
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 0.5
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 0.5
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 0.5
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 0.5
Nodes (0): 

### Community 51 - "Community 51"
Cohesion: 0.5
Nodes (0): 

### Community 52 - "Community 52"
Cohesion: 0.83
Nodes (3): activePreset(), pickTierId(), resolvePreset()

### Community 53 - "Community 53"
Cohesion: 0.5
Nodes (4): POST/GET /api/honeycomb/config, POST /api/honeycomb/test, Honeycomb Per-Project Config Surface, honeycomb-config.ts precedence resolver

### Community 54 - "Community 54"
Cohesion: 0.5
Nodes (0): 

### Community 55 - "Community 55"
Cohesion: 0.5
Nodes (0): 

### Community 56 - "Community 56"
Cohesion: 0.67
Nodes (0): 

### Community 57 - "Community 57"
Cohesion: 0.67
Nodes (0): 

### Community 58 - "Community 58"
Cohesion: 0.67
Nodes (0): 

### Community 59 - "Community 59"
Cohesion: 0.67
Nodes (0): 

### Community 60 - "Community 60"
Cohesion: 0.67
Nodes (0): 

### Community 61 - "Community 61"
Cohesion: 0.67
Nodes (3): Anthropic Payload Contents (system prompt + history + tool calls/results), Data Flow Network Boundaries (loopback + Anthropic), No Analytics / No Telemetry

### Community 62 - "Community 62"
Cohesion: 0.67
Nodes (3): ADRs + per-project memory (concept doc), <workDir>/.marvin/memory.md (project memory), Re-derivation test (fallback ADR judgement)

### Community 63 - "Community 63"
Cohesion: 0.67
Nodes (3): GET /api/chat/resume, POST /api/chat, POST /api/chat/cancel

### Community 64 - "Community 64"
Cohesion: 0.67
Nodes (3): Finding #25 — REVIEW.md naming collision (RESOLVED in-place), Rationale — REVIEW.md rename blocked by hard-coded skill name, REVIEW.md is rules doc — disambiguation note

### Community 65 - "Community 65"
Cohesion: 0.67
Nodes (3): Placeholder Artwork (per ADR-0011), MARVIN Desktop App Icon (placeholder), Bold 'M' Glyph on Off-White Background

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
Nodes (0): 

### Community 81 - "Community 81"
Cohesion: 1.0
Nodes (0): 

### Community 82 - "Community 82"
Cohesion: 1.0
Nodes (0): 

### Community 83 - "Community 83"
Cohesion: 1.0
Nodes (0): 

### Community 84 - "Community 84"
Cohesion: 1.0
Nodes (0): 

### Community 85 - "Community 85"
Cohesion: 1.0
Nodes (0): 

### Community 86 - "Community 86"
Cohesion: 1.0
Nodes (0): 

### Community 87 - "Community 87"
Cohesion: 1.0
Nodes (2): Remote error taxonomy (auth-publickey, network, etc), apps/web/src/lib/git-remote-errors.ts

### Community 88 - "Community 88"
Cohesion: 1.0
Nodes (0): 

### Community 89 - "Community 89"
Cohesion: 1.0
Nodes (0): 

### Community 90 - "Community 90"
Cohesion: 1.0
Nodes (2): Do-not-report list (typecheck / lint / formatting / scoped tests), Cap: max 5 nits per review

### Community 91 - "Community 91"
Cohesion: 1.0
Nodes (2): Debugging a Turn Workflow, Per-Turn JSONL Logs (~/.marvin/sessions/*)

### Community 92 - "Community 92"
Cohesion: 1.0
Nodes (2): Global Keyboard Shortcuts (⌘K, ⌘P, ⌘⇧N, ⌘., ?, Esc), Pane Toggle Shortcuts (⌘B/G/J/⇧P)

### Community 93 - "Community 93"
Cohesion: 1.0
Nodes (2): Finding #16 — localStorage proliferation (7 keys, no reset), Finding #18 — page.tsx 923-line god component, 18-prop bag

### Community 94 - "Community 94"
Cohesion: 1.0
Nodes (2): launchd user agent — net.marvin.desktop.server.plist, apps/desktop/README.md — Tauri wrapper docs

### Community 95 - "Community 95"
Cohesion: 1.0
Nodes (0): 

### Community 96 - "Community 96"
Cohesion: 1.0
Nodes (0): 

### Community 97 - "Community 97"
Cohesion: 1.0
Nodes (0): 

### Community 98 - "Community 98"
Cohesion: 1.0
Nodes (0): 

### Community 99 - "Community 99"
Cohesion: 1.0
Nodes (0): 

### Community 100 - "Community 100"
Cohesion: 1.0
Nodes (0): 

### Community 101 - "Community 101"
Cohesion: 1.0
Nodes (0): 

### Community 102 - "Community 102"
Cohesion: 1.0
Nodes (2): FileQuickLookItem, QuickLookCoordinator

### Community 103 - "Community 103"
Cohesion: 1.0
Nodes (2): Android Launcher Icons mipmap-hdpi (Tauri Desktop), Android Launcher Icons mipmap-mdpi (Tauri Desktop)

### Community 104 - "Community 104"
Cohesion: 1.0
Nodes (1): MARVIN Tauri Desktop App Icon Set

### Community 105 - "Community 105"
Cohesion: 1.0
Nodes (0): 

### Community 106 - "Community 106"
Cohesion: 1.0
Nodes (0): 

### Community 107 - "Community 107"
Cohesion: 1.0
Nodes (0): 

### Community 108 - "Community 108"
Cohesion: 1.0
Nodes (0): 

### Community 109 - "Community 109"
Cohesion: 1.0
Nodes (0): 

### Community 110 - "Community 110"
Cohesion: 1.0
Nodes (1): scout-agent.test.ts (SCOUT_AGENT invariants)

### Community 111 - "Community 111"
Cohesion: 1.0
Nodes (0): 

### Community 112 - "Community 112"
Cohesion: 1.0
Nodes (0): 

### Community 113 - "Community 113"
Cohesion: 1.0
Nodes (1): packages/runtime/src/fs-write-confirm-registry.ts (session-scoped token ledger)

### Community 114 - "Community 114"
Cohesion: 1.0
Nodes (0): 

### Community 115 - "Community 115"
Cohesion: 1.0
Nodes (1): packages/graphify-bridge/src/mcp-server.ts (createGraphMcpServer)

### Community 116 - "Community 116"
Cohesion: 1.0
Nodes (0): 

### Community 117 - "Community 117"
Cohesion: 1.0
Nodes (1): packages/project-context/src/index.ts (ADR + memory injection)

### Community 118 - "Community 118"
Cohesion: 1.0
Nodes (0): 

### Community 119 - "Community 119"
Cohesion: 1.0
Nodes (0): 

### Community 120 - "Community 120"
Cohesion: 1.0
Nodes (0): 

### Community 121 - "Community 121"
Cohesion: 1.0
Nodes (0): 

### Community 122 - "Community 122"
Cohesion: 1.0
Nodes (0): 

### Community 123 - "Community 123"
Cohesion: 1.0
Nodes (0): 

### Community 124 - "Community 124"
Cohesion: 1.0
Nodes (0): 

### Community 125 - "Community 125"
Cohesion: 1.0
Nodes (0): 

### Community 126 - "Community 126"
Cohesion: 1.0
Nodes (0): 

### Community 127 - "Community 127"
Cohesion: 1.0
Nodes (0): 

### Community 128 - "Community 128"
Cohesion: 1.0
Nodes (0): 

### Community 129 - "Community 129"
Cohesion: 1.0
Nodes (0): 

### Community 130 - "Community 130"
Cohesion: 1.0
Nodes (0): 

### Community 131 - "Community 131"
Cohesion: 1.0
Nodes (0): 

### Community 132 - "Community 132"
Cohesion: 1.0
Nodes (0): 

### Community 133 - "Community 133"
Cohesion: 1.0
Nodes (0): 

### Community 134 - "Community 134"
Cohesion: 1.0
Nodes (0): 

### Community 135 - "Community 135"
Cohesion: 1.0
Nodes (0): 

### Community 136 - "Community 136"
Cohesion: 1.0
Nodes (0): 

### Community 137 - "Community 137"
Cohesion: 1.0
Nodes (0): 

### Community 138 - "Community 138"
Cohesion: 1.0
Nodes (0): 

### Community 139 - "Community 139"
Cohesion: 1.0
Nodes (0): 

### Community 140 - "Community 140"
Cohesion: 1.0
Nodes (0): 

### Community 141 - "Community 141"
Cohesion: 1.0
Nodes (0): 

### Community 142 - "Community 142"
Cohesion: 1.0
Nodes (0): 

### Community 143 - "Community 143"
Cohesion: 1.0
Nodes (1): Always-check checklist (api.md, MCP, tool policy, fs-constants, git argv)

### Community 144 - "Community 144"
Cohesion: 1.0
Nodes (1): Grep-and-pray flag (Golden Rule 7 violation pattern)

### Community 145 - "Community 145"
Cohesion: 1.0
Nodes (1): file:line citation requirement for findings

### Community 146 - "Community 146"
Cohesion: 1.0
Nodes (1): docs/security/tool-policy.md

### Community 147 - "Community 147"
Cohesion: 1.0
Nodes (1): tool-policy.md — Subagent tool constraints table

### Community 148 - "Community 148"
Cohesion: 1.0
Nodes (1): tool-policy.md — Three mutation channels

### Community 149 - "Community 149"
Cohesion: 1.0
Nodes (1): Sensitive Data Handling Rules

### Community 150 - "Community 150"
Cohesion: 1.0
Nodes (1): Git Credentials Inherited, Never Handled

### Community 151 - "Community 151"
Cohesion: 1.0
Nodes (1): Local setup doc

### Community 152 - "Community 152"
Cohesion: 1.0
Nodes (1): Dev loop (pnpm dev)

### Community 153 - "Community 153"
Cohesion: 1.0
Nodes (1): Data dir while developing (MARVIN_DATA_DIR)

### Community 154 - "Community 154"
Cohesion: 1.0
Nodes (1): Debugging the Agent SDK (DEBUG env)

### Community 155 - "Community 155"
Cohesion: 1.0
Nodes (1): ADR-0005 — Per-project isolation

### Community 156 - "Community 156"
Cohesion: 1.0
Nodes (1): ADR-0006 — Light-first theme cascade

### Community 157 - "Community 157"
Cohesion: 1.0
Nodes (1): ADR-0002 — Default to Claude Opus 4.7

### Community 158 - "Community 158"
Cohesion: 1.0
Nodes (1): ADR-0010 — Desktop wrapper via Tauri

### Community 159 - "Community 159"
Cohesion: 1.0
Nodes (1): ADR-0011 — Sidecar Node bundling (Deprecated)

### Community 160 - "Community 160"
Cohesion: 1.0
Nodes (1): ADR-0001 — Single assistant, not an agent team

### Community 161 - "Community 161"
Cohesion: 1.0
Nodes (1): Cost Ledger (~/.marvin/cost-tracker.json)

### Community 162 - "Community 162"
Cohesion: 1.0
Nodes (1): UI State Indicators (brain, status rail, cost pill, branch badge)

### Community 163 - "Community 163"
Cohesion: 1.0
Nodes (1): confirm-registry

### Community 164 - "Community 164"
Cohesion: 1.0
Nodes (1): /api/projects routes (list/add/delete/active/verify)

### Community 165 - "Community 165"
Cohesion: 1.0
Nodes (1): /api/sessions routes (list + by-id)

### Community 166 - "Community 166"
Cohesion: 1.0
Nodes (1): GET /api/cost

### Community 167 - "Community 167"
Cohesion: 1.0
Nodes (1): POST /api/terminal/run

### Community 168 - "Community 168"
Cohesion: 1.0
Nodes (1): POST /api/graph/query

### Community 169 - "Community 169"
Cohesion: 1.0
Nodes (1): GET /api/models

### Community 170 - "Community 170"
Cohesion: 1.0
Nodes (1): GET /api/health

### Community 171 - "Community 171"
Cohesion: 1.0
Nodes (1): Chat Input Shortcuts (⏎, ⇧⏎, ⌘⏎)

### Community 172 - "Community 172"
Cohesion: 1.0
Nodes (1): File Tree Shortcuts (⌘⌫, F2, Shift/⌘-click, drag)

### Community 173 - "Community 173"
Cohesion: 1.0
Nodes (1): Editor Shortcut (⌘S save with CAS-on-mtime)

### Community 174 - "Community 174"
Cohesion: 1.0
Nodes (1): Source Control Panel Shortcuts

### Community 175 - "Community 175"
Cohesion: 1.0
Nodes (1): Terminal Shortcuts (↑↓, Ctrl-C, Ctrl-L)

### Community 176 - "Community 176"
Cohesion: 1.0
Nodes (1): Wordmark-Click Return-to-Hero Affordance

### Community 177 - "Community 177"
Cohesion: 1.0
Nodes (1): Finding #9 — chat surface squeezed at 37% viewport

### Community 178 - "Community 178"
Cohesion: 1.0
Nodes (1): Finding #13 — auto-scroll yanks user back to bottom

### Community 179 - "Community 179"
Cohesion: 1.0
Nodes (1): Finding #14 — stream-end recovery is text-only

### Community 180 - "Community 180"
Cohesion: 1.0
Nodes (1): Finding #20 — no virtualisation on chat or file tree

### Community 181 - "Community 181"
Cohesion: 1.0
Nodes (1): Finding #21 — tool name set declared in two places

### Community 182 - "Community 182"
Cohesion: 1.0
Nodes (1): Audit method — graph first, file reads when graph poisoned

### Community 183 - "Community 183"
Cohesion: 1.0
Nodes (0): 

### Community 184 - "Community 184"
Cohesion: 1.0
Nodes (1): Phase 5a — State the Definition of Done

### Community 185 - "Community 185"
Cohesion: 1.0
Nodes (1): Phase 7 — Match-not-improve verification

### Community 186 - "Community 186"
Cohesion: 1.0
Nodes (1): ADR template — ## Scope of Done block

### Community 187 - "Community 187"
Cohesion: 1.0
Nodes (0): 

### Community 188 - "Community 188"
Cohesion: 1.0
Nodes (0): 

### Community 189 - "Community 189"
Cohesion: 1.0
Nodes (0): 

### Community 190 - "Community 190"
Cohesion: 1.0
Nodes (0): 

### Community 191 - "Community 191"
Cohesion: 1.0
Nodes (1): ADR-0002 — Default to Claude Opus 4.7

### Community 192 - "Community 192"
Cohesion: 1.0
Nodes (1): ADR-0006 — Light-first theme cascade

### Community 193 - "Community 193"
Cohesion: 1.0
Nodes (1): Definition of Done (docs/reviews/DEFINITION_OF_DONE.md)

### Community 194 - "Community 194"
Cohesion: 1.0
Nodes (1): Source control panel (VSCode-style)

### Community 195 - "Community 195"
Cohesion: 1.0
Nodes (1): Workspace status bar (branch + ahead/behind)

### Community 196 - "Community 196"
Cohesion: 1.0
Nodes (1): Light + dark themes (OKLCH-based)

### Community 197 - "Community 197"
Cohesion: 1.0
Nodes (1): Model picker (executor + advisor slots)

### Community 198 - "Community 198"
Cohesion: 1.0
Nodes (1): Cost tracker (daily/weekly/lifetime)

### Community 199 - "Community 199"
Cohesion: 1.0
Nodes (1): Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘., ?, Esc)

### Community 200 - "Community 200"
Cohesion: 1.0
Nodes (1): Own Playwright MCP server (drives real browsers against localhost)

### Community 201 - "Community 201"
Cohesion: 1.0
Nodes (1): Refresh-safe turns (close tab without killing turn)

### Community 202 - "Community 202"
Cohesion: 1.0
Nodes (1): Prerequisites — Node>=22, pnpm 10.33, Claude CLI, credentials

### Community 203 - "Community 203"
Cohesion: 1.0
Nodes (1): Credential priority — ANTHROPIC_API_KEY > ~/.claude/.credentials.json > Keychain

### Community 204 - "Community 204"
Cohesion: 1.0
Nodes (1): bin/marvin lifecycle (start/status/logs/stop/restart/doctor)

### Community 205 - "Community 205"
Cohesion: 1.0
Nodes (1): MARVIN_DATA_DIR layout (sessions/cost-tracker/projects)

### Community 206 - "Community 206"
Cohesion: 1.0
Nodes (1): Personality is style layer not refusal layer

### Community 207 - "Community 207"
Cohesion: 1.0
Nodes (1): Phase 3 — File tree + terminal + diff viewer shipped 2026-04-17

### Community 208 - "Community 208"
Cohesion: 1.0
Nodes (1): Deferred — Honeycomb MCP integration (blocker: account+config)

### Community 209 - "Community 209"
Cohesion: 1.0
Nodes (1): Deferred — Automated tests beyond write-channel layer

### Community 210 - "Community 210"
Cohesion: 1.0
Nodes (1): Deferred — /api/health model field rename (defaultModel)

### Community 211 - "Community 211"
Cohesion: 1.0
Nodes (1): Light-theme recolour (warm paper) landed 2026-04-21

### Community 212 - "Community 212"
Cohesion: 1.0
Nodes (1): Not planned — Hosted SaaS with shared state

### Community 213 - "Community 213"
Cohesion: 1.0
Nodes (1): Not planned — Cross-project memory

### Community 214 - "Community 214"
Cohesion: 1.0
Nodes (1): Not planned — Broad auto-mode heuristics for model switching

### Community 215 - "Community 215"
Cohesion: 1.0
Nodes (1): Brain Circuit Idle Icon (build copy)

### Community 216 - "Community 216"
Cohesion: 1.0
Nodes (1): Brain Circuit Active Icon (build copy)

### Community 217 - "Community 217"
Cohesion: 1.0
Nodes (1): Brain Circuit App Icon (build copy)

### Community 218 - "Community 218"
Cohesion: 1.0
Nodes (0): 

### Community 219 - "Community 219"
Cohesion: 1.0
Nodes (1): brainMetalShaderSource (MSL Shader String)

### Community 220 - "Community 220"
Cohesion: 1.0
Nodes (1): ChatServiceError (Chat Client Error Types)

### Community 221 - "Community 221"
Cohesion: 1.0
Nodes (1): GitStatusBranch

### Community 222 - "Community 222"
Cohesion: 1.0
Nodes (1): ChatAttachment kind type

### Community 223 - "Community 223"
Cohesion: 1.0
Nodes (1): ChatRequest

### Community 224 - "Community 224"
Cohesion: 1.0
Nodes (1): SessionRecord

### Community 225 - "Community 225"
Cohesion: 1.0
Nodes (1): ConfirmRequest

### Community 226 - "Community 226"
Cohesion: 1.0
Nodes (1): iOS App Icon Variants (Tauri Desktop)

## Ambiguous Edges - Review These
- `ADR-0016 (Swift Migration Decision)` → `MARVIN hero image (hero.png)`  [AMBIGUOUS]
  hero.png · relation: conceptually_related_to

## Knowledge Gaps
- **490 isolated node(s):** `packages/tools/tests/policy.test.ts (26-case Vitest pin)`, `packages/tools/src/fs-constants.ts (IGNORE_DIR_NAMES)`, `scout-agent.test.ts (SCOUT_AGENT invariants)`, `packages/runtime/src/fs-write-confirm-registry.ts (session-scoped token ledger)`, `packages/graphify-bridge/src/mcp-server.ts (createGraphMcpServer)` (+485 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 66`** (2 nodes): `tabs.tsx`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (2 nodes): `utils.ts`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (2 nodes): `tooltip.tsx`, `TooltipContent()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (2 nodes): `Badge()`, `badge.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (2 nodes): `separator.tsx`, `Separator()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 71`** (2 nodes): `cn()`, `button.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (2 nodes): `Input()`, `input.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 73`** (2 nodes): `Skeleton()`, `skeleton.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (2 nodes): `mkTmp()`, `fs-sandbox.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 75`** (2 nodes): `writeConfig()`, `honeycomb-telemetry.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 76`** (2 nodes): `parse-porcelain-v2.test.ts`, `stream()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 77`** (2 nodes): `permission-toggle.tsx`, `PermissionToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 78`** (2 nodes): `personality-toggle.tsx`, `PersonalityToggle()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 79`** (2 nodes): `use-confirm-title-badge.ts`, `useConfirmTitleBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 80`** (2 nodes): `useProjects()`, `use-projects.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 81`** (2 nodes): `project-picker.tsx`, `fmtWhen()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 82`** (2 nodes): `confirm-git-op-dialog.tsx`, `ConfirmGitOpDialog()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 83`** (2 nodes): `use-git-status.ts`, `useGitStatus()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 84`** (2 nodes): `status-badge.tsx`, `StatusBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 85`** (2 nodes): `use-dirty-state.ts`, `useDirtyState()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 86`** (2 nodes): `confirm-delete-dialog.tsx`, `ConfirmDeleteDialog()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 87`** (2 nodes): `Remote error taxonomy (auth-publickey, network, etc)`, `apps/web/src/lib/git-remote-errors.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 88`** (2 nodes): `build.rs`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 89`** (2 nodes): `main.rs`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 90`** (2 nodes): `Do-not-report list (typecheck / lint / formatting / scoped tests)`, `Cap: max 5 nits per review`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 91`** (2 nodes): `Debugging a Turn Workflow`, `Per-Turn JSONL Logs (~/.marvin/sessions/*)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 92`** (2 nodes): `Global Keyboard Shortcuts (⌘K, ⌘P, ⌘⇧N, ⌘., ?, Esc)`, `Pane Toggle Shortcuts (⌘B/G/J/⇧P)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 93`** (2 nodes): `Finding #16 — localStorage proliferation (7 keys, no reset)`, `Finding #18 — page.tsx 923-line god component, 18-prop bag`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 94`** (2 nodes): `launchd user agent — net.marvin.desktop.server.plist`, `apps/desktop/README.md — Tauri wrapper docs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 95`** (2 nodes): `readAuditLines()`, `can-use-tool-dispatch.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 96`** (2 nodes): `layout.tsx`, `RootLayout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 97`** (2 nodes): `marvin-shell-bridge.tsx`, `MarvinShellBridge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 98`** (2 nodes): `top-bar.tsx`, `TopBar()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 99`** (2 nodes): `cost-pill.tsx`, `fmtUsd()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 100`** (2 nodes): `branch-badge.tsx`, `BranchBadge()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 101`** (2 nodes): `shoot()`, `dev-screenshot.mjs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 102`** (2 nodes): `FileQuickLookItem`, `QuickLookCoordinator`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 103`** (2 nodes): `Android Launcher Icons mipmap-hdpi (Tauri Desktop)`, `Android Launcher Icons mipmap-mdpi (Tauri Desktop)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 104`** (1 nodes): `MARVIN Tauri Desktop App Icon Set`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 105`** (1 nodes): `vitest.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 106`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 107`** (1 nodes): `fs-constants.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 108`** (1 nodes): `fs-write-policy.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 109`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 110`** (1 nodes): `scout-agent.test.ts (SCOUT_AGENT invariants)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 111`** (1 nodes): `honeycomb-config.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 112`** (1 nodes): `fs-write-confirm-registry.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 113`** (1 nodes): `packages/runtime/src/fs-write-confirm-registry.ts (session-scoped token ledger)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 114`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 115`** (1 nodes): `packages/graphify-bridge/src/mcp-server.ts (createGraphMcpServer)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 116`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 117`** (1 nodes): `packages/project-context/src/index.ts (ADR + memory injection)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 118`** (1 nodes): `git-write-policy.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 119`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 120`** (1 nodes): `argv-guards.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 121`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 122`** (1 nodes): `next.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 123`** (1 nodes): `model-picker-presets.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 124`** (1 nodes): `file-tree-filter.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 125`** (1 nodes): `model-picker-types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 126`** (1 nodes): `settings-panel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 127`** (1 nodes): `models-dialog.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 128`** (1 nodes): `message-view.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 129`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 130`** (1 nodes): `page-helpers.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 131`** (1 nodes): `graph-panel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 132`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 133`** (1 nodes): `branch-switcher.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 134`** (1 nodes): `branch-bar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 135`** (1 nodes): `remote-error-banner.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 136`** (1 nodes): `advisor-orb.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 137`** (1 nodes): `unsaved-guard.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 138`** (1 nodes): `editor-toolbar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 139`** (1 nodes): `tree-context-menu.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 140`** (1 nodes): `upload-progress-toast.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 141`** (1 nodes): `tree-node.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 142`** (1 nodes): `inline-rename.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 143`** (1 nodes): `Always-check checklist (api.md, MCP, tool policy, fs-constants, git argv)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 144`** (1 nodes): `Grep-and-pray flag (Golden Rule 7 violation pattern)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 145`** (1 nodes): `file:line citation requirement for findings`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 146`** (1 nodes): `docs/security/tool-policy.md`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 147`** (1 nodes): `tool-policy.md — Subagent tool constraints table`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 148`** (1 nodes): `tool-policy.md — Three mutation channels`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 149`** (1 nodes): `Sensitive Data Handling Rules`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 150`** (1 nodes): `Git Credentials Inherited, Never Handled`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 151`** (1 nodes): `Local setup doc`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 152`** (1 nodes): `Dev loop (pnpm dev)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 153`** (1 nodes): `Data dir while developing (MARVIN_DATA_DIR)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 154`** (1 nodes): `Debugging the Agent SDK (DEBUG env)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 155`** (1 nodes): `ADR-0005 — Per-project isolation`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 156`** (1 nodes): `ADR-0006 — Light-first theme cascade`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 157`** (1 nodes): `ADR-0002 — Default to Claude Opus 4.7`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 158`** (1 nodes): `ADR-0010 — Desktop wrapper via Tauri`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 159`** (1 nodes): `ADR-0011 — Sidecar Node bundling (Deprecated)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 160`** (1 nodes): `ADR-0001 — Single assistant, not an agent team`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 161`** (1 nodes): `Cost Ledger (~/.marvin/cost-tracker.json)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 162`** (1 nodes): `UI State Indicators (brain, status rail, cost pill, branch badge)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 163`** (1 nodes): `confirm-registry`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 164`** (1 nodes): `/api/projects routes (list/add/delete/active/verify)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 165`** (1 nodes): `/api/sessions routes (list + by-id)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 166`** (1 nodes): `GET /api/cost`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 167`** (1 nodes): `POST /api/terminal/run`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 168`** (1 nodes): `POST /api/graph/query`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 169`** (1 nodes): `GET /api/models`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 170`** (1 nodes): `GET /api/health`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 171`** (1 nodes): `Chat Input Shortcuts (⏎, ⇧⏎, ⌘⏎)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 172`** (1 nodes): `File Tree Shortcuts (⌘⌫, F2, Shift/⌘-click, drag)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 173`** (1 nodes): `Editor Shortcut (⌘S save with CAS-on-mtime)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 174`** (1 nodes): `Source Control Panel Shortcuts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 175`** (1 nodes): `Terminal Shortcuts (↑↓, Ctrl-C, Ctrl-L)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 176`** (1 nodes): `Wordmark-Click Return-to-Hero Affordance`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 177`** (1 nodes): `Finding #9 — chat surface squeezed at 37% viewport`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 178`** (1 nodes): `Finding #13 — auto-scroll yanks user back to bottom`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 179`** (1 nodes): `Finding #14 — stream-end recovery is text-only`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 180`** (1 nodes): `Finding #20 — no virtualisation on chat or file tree`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 181`** (1 nodes): `Finding #21 — tool name set declared in two places`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 182`** (1 nodes): `Audit method — graph first, file reads when graph poisoned`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 183`** (1 nodes): `friendly-error.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 184`** (1 nodes): `Phase 5a — State the Definition of Done`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 185`** (1 nodes): `Phase 7 — Match-not-improve verification`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 186`** (1 nodes): `ADR template — ## Scope of Done block`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 187`** (1 nodes): `Package.swift`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 188`** (1 nodes): `next-env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 189`** (1 nodes): `virtual-message-list.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 190`** (1 nodes): `source-control-panel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 191`** (1 nodes): `ADR-0002 — Default to Claude Opus 4.7`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 192`** (1 nodes): `ADR-0006 — Light-first theme cascade`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 193`** (1 nodes): `Definition of Done (docs/reviews/DEFINITION_OF_DONE.md)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 194`** (1 nodes): `Source control panel (VSCode-style)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 195`** (1 nodes): `Workspace status bar (branch + ahead/behind)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 196`** (1 nodes): `Light + dark themes (OKLCH-based)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 197`** (1 nodes): `Model picker (executor + advisor slots)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 198`** (1 nodes): `Cost tracker (daily/weekly/lifetime)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 199`** (1 nodes): `Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘., ?, Esc)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 200`** (1 nodes): `Own Playwright MCP server (drives real browsers against localhost)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 201`** (1 nodes): `Refresh-safe turns (close tab without killing turn)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 202`** (1 nodes): `Prerequisites — Node>=22, pnpm 10.33, Claude CLI, credentials`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 203`** (1 nodes): `Credential priority — ANTHROPIC_API_KEY > ~/.claude/.credentials.json > Keychain`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 204`** (1 nodes): `bin/marvin lifecycle (start/status/logs/stop/restart/doctor)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 205`** (1 nodes): `MARVIN_DATA_DIR layout (sessions/cost-tracker/projects)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 206`** (1 nodes): `Personality is style layer not refusal layer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 207`** (1 nodes): `Phase 3 — File tree + terminal + diff viewer shipped 2026-04-17`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 208`** (1 nodes): `Deferred — Honeycomb MCP integration (blocker: account+config)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 209`** (1 nodes): `Deferred — Automated tests beyond write-channel layer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 210`** (1 nodes): `Deferred — /api/health model field rename (defaultModel)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 211`** (1 nodes): `Light-theme recolour (warm paper) landed 2026-04-21`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 212`** (1 nodes): `Not planned — Hosted SaaS with shared state`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 213`** (1 nodes): `Not planned — Cross-project memory`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 214`** (1 nodes): `Not planned — Broad auto-mode heuristics for model switching`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 215`** (1 nodes): `Brain Circuit Idle Icon (build copy)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 216`** (1 nodes): `Brain Circuit Active Icon (build copy)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 217`** (1 nodes): `Brain Circuit App Icon (build copy)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 218`** (1 nodes): `postcss.config.mjs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 219`** (1 nodes): `brainMetalShaderSource (MSL Shader String)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 220`** (1 nodes): `ChatServiceError (Chat Client Error Types)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 221`** (1 nodes): `GitStatusBranch`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 222`** (1 nodes): `ChatAttachment kind type`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 223`** (1 nodes): `ChatRequest`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 224`** (1 nodes): `SessionRecord`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 225`** (1 nodes): `ConfirmRequest`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 226`** (1 nodes): `iOS App Icon Variants (Tauri Desktop)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `ADR-0016 (Swift Migration Decision)` and `MARVIN hero image (hero.png)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `string` connect `Swift macOS App Shell + Tauri Wrapper` to `Next.js API Routes (Web Server)`, `Swift Data Models + Bridge Types`, `Native Pane Views (Input, Preview, Split)`, `File Viewer (Native + Web)`, `Files Service + Chat Stream Reducer`, `Confirm Gate + Auth + Subprocess`, `Terminal Pane (Native SSE)`, `macOS Status Bar + App Delegate`, `Community 30`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `GET()` connect `Next.js API Routes (Web Server)` to `Community 32`, `Swift macOS App Shell + Tauri Wrapper`, `Brain Rendering (Metal + Web Canvas)`, `Confirm Gate + Auth + Subprocess`, `Quick Open + File Tree Interactions`, `Git Porcelain v2 Parser`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `POST()` connect `Next.js API Routes (Web Server)` to `Community 25`, `Swift macOS App Shell + Tauri Wrapper`, `Files Service + Chat Stream Reducer`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Are the 38 inferred relationships involving `GET()` (e.g. with `detectNewCommits()` and `honeycombTelemetryStatus()`) actually correct?**
  _`GET()` has 38 INFERRED edges - model-reasoned connections that need verification._
- **Are the 26 inferred relationships involving `POST()` (e.g. with `fsWritePolicy()` and `applyHoneycombTelemetryEnv()`) actually correct?**
  _`POST()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 37 inferred relationships involving `string` (e.g. with `verifyWorkDir()` and `writeHoneycombConfig()`) actually correct?**
  _`string` has 37 INFERRED edges - model-reasoned connections that need verification._
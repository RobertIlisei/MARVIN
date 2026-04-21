# Roadmap

Pulled from [PLAN.md](../PLAN.md). That file is the authoritative delivery plan; this page is the narrative view.

> Phase 1-4 shipped 2026-04-17. Most of Phase 5 shipped 2026-04-18/19. MARVIN is v1-complete pending the deferred items below.

## Done

### Phase 1 — Foundations · shipped 2026-04-17

- `~/marvin/` monorepo scaffold, pnpm workspaces + Turbo.
- `apps/web/` Next.js 16 on port 3030.
- `packages/runtime/` — Claude CLI + Agent SDK wrappers, auth, session, cost, personality.
- `packages/project-context/` — first-message injection (docs + ADRs + memory + graph header + workflow audit).
- `packages/graphify-bridge/` — watchdog, read-graph, in-process MCP server.
- `packages/git-watch/`, `packages/tools/`, `packages/ui/` — supporting packages.
- Baseline `/api/chat` SSE streaming, JSONL session persistence.

**Milestone:** `curl http://localhost:3030/api/health` returns 200; `/api/chat` SSE-streams a MARVIN-voiced reply.

### Phase 2 — Chat + tools · shipped 2026-04-17

- Type system: Geist Sans + Instrument Serif + JetBrains Mono.
- `<MarvinBrain>` hand-authored SVG component with 5 states.
- Chat stream hook + message rendering + collapsible tool-call cards.
- Status bar (state · duration · tokens · cost · session id).
- **Structural confirm-before-act gate** — migration from raw CLI to `@anthropic-ai/claude-agent-sdk`'s `canUseTool`. See [ADR-0004](./decisions/0004-structural-confirm-gate.md).
- `/api/confirm` + `<ConfirmPrompt>` inline in tool-call cards.
- `personality.ts` enriched — runtime grep in Impact Analysis, ADR template enforcement, Future-MARVIN critique subagent.

**Milestone:** in a throw-away sample project, chat "build a logout route" — MARVIN reads, proposes, applies, verifies, offers to commit.

### Phase 3 — File tree + terminal + diff viewer · shipped 2026-04-17

- `/api/files/tree`, `/api/files/content`, `/api/files/status` — project-scoped fs walker + git status.
- `<FileTree>` with dirty-file badges, branch pill, dirty-ancestor dots.
- `<FileViewer>` with sticky line numbers + language label.
- `<Terminal>` (xterm.js + fit-addon) — SSE command runner, persisted history, Ctrl-C cancellation, Ctrl-L clear.
- `<DiffViewer>` (monaco-editor) — Edit / Write cards + ConfirmPrompt integration.
- Resizable splits via `react-resizable-panels` — horizontal + vertical panels persist to localStorage.

**Milestone:** visual parity with the 3-pane mock-up; editing a file updates the tree badge; terminal reflects chat-driven changes.

### Phase 4 — Persistence, project picker, cost, personality, graph panel · shipped 2026-04-17

- `@marvin/runtime/projects` — registry backed by `~/.marvin/projects.json`.
- `@marvin/runtime/cost-tracker` — append-on-turn ledger + aggregation.
- `<ProjectPicker>`, `<AddProjectDialog>`, `<CostPill>`, `<PersonalityToggle>`, `<GraphPanel>`.
- New API routes: `/api/projects{,active,verify}`, `/api/sessions{,[id]}`, `/api/cost`, `/api/graph/query`.
- `useChatStream.hydrateFromSession()` — rebuilds UI from a JSONL transcript.
- Widened chat frame, header controls, pane-toggle persistence.

**Milestone:** ship MARVIN v1 — dog-food on a fresh Next.js + Prisma starter end-to-end.

### Phase 5 — Stretch · partially shipped 2026-04-18/19

- **[done 2026-04-18]** Advisor strategy. See [ADR-0003](./decisions/0003-advisor-strategy.md).
- **[done 2026-04-18]** Browser preview pane (iframe-based). Stackable beside file viewer + terminal.
- **[done 2026-04-18]** Graph-aware chat via in-process MCP server (`marvin-graph`). `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`.
- **[done 2026-04-18]** Keyboard shortcuts (⌘K, ⌘B/G/J/P, ⌘⇧N, ⌘., `?`, `Esc`), session search in picker, `<ShortcutsHelp>` overlay.
- **[done 2026-04-18]** Refresh-safe turns (`turn-registry.ts`) — closing the tab doesn't kill a running turn; `/api/chat/resume` tails live event bus; `/api/chat/cancel` as the explicit abort.
- **[done 2026-04-18]** Dynamic model discovery (`/api/models`) + `<ModelPicker>` — two-slot executor + advisor with live-or-fallback list.
- **[done 2026-04-18]** Astronomical-ledger hero pass — orbital rings, constellation drift, staggered `hero-stage` reveals, moon-phase status glyphs.
- **[done 2026-04-18]** `marvin-playwright` MCP — own Playwright stdio server, unsandboxed against localhost.
- **[done 2026-04-18]** Workflow-audit fires on every turn while gaps exist; stack-agnostic detector; Mode A/B/C execution split.
- **[done 2026-04-19]** Dual-theme support. Light baseline + icy-blue-on-black dark override per the Claude Design handoff. See [ADR-0006](./decisions/0006-light-first-theme-cascade.md). Monaco + xterm follow the toggle.
- **[done 2026-04-19]** BrainLiquid canvas particle brain — curl-noise flow, roaming attractors, per-state profiles, theme-aware painting.
- **[done 2026-04-19]** Clickable wordmark as "return to hero" nav. Hydration warning suppression.
- **[done 2026-04-19]** Full documentation pass — `docs/` with 30 files (this page).

## Deferred (blockers, not capacity)

### Honeycomb MCP integration for observability

Registered as `marvin-honeycomb`. Would expose trace querying as tools the executor could invoke while debugging production issues.

**Blocker:** requires a Honeycomb account + team-specific configuration. Violates [isolation contract](./concepts/isolation-contract.md) if baked into MARVIN's source; belongs in `<workDir>/.marvin/` config. No shipping ETA until a user has a Honeycomb environment to be the first to try.

### Automated tests for surfaces beyond the write-channel security layer

**Partial shipment 2026-04-21** — Vitest harness + 61 tests cover
`fs-sandbox` / `fs-write-policy` / `fs-constants` /
`fs-write-confirm-registry`. The Agent SDK interaction loop,
streaming UI, and individual API routes remain uncovered — still
opportunistic. See [Testing](./development/testing.md).

### `/api/health` `model` field rename

Old response has `model: claude-opus-4-7` which users mistake for "the live model." Renamed to `defaultModel` on 2026-04-19 — some docs or scripts may still reference the old name. Update callers.

### Light-theme recolour

The current light theme bases on `oklch(0.985 0.003 80)` — effectively
pure warm white. User feedback: too bright, especially over long
sessions. Target: drop `--color-bg` to the ~0.93–0.95 lightness range
so surfaces read as warm paper rather than pure-white. The dark
theme is fine; this is a light-side-only pass. Likely touches
`apps/web/src/app/globals.css`'s `@theme` block + the Monaco `marvin-
light` theme in `apps/web/src/components/settings/monaco-themes.ts`
to match.

## Not planned

Things MARVIN deliberately won't do. See [Vision](./business/vision.md) for the reasoning.

- Multi-agent orchestration ([ADR-0001](./decisions/0001-single-assistant.md)).
- Hosted SaaS with shared state.
- Cross-project memory.
- Broad "auto-mode heuristics" that switch models based on guessed complexity ([ADR-0002](./decisions/0002-default-to-opus-4-7.md)).

## Related

- [PLAN.md](../PLAN.md) — authoritative delivery plan + changelog.
- [Vision](./business/vision.md) — what MARVIN is trying to be.
- [ADRs](./decisions/) — material decisions.

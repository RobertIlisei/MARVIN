# MARVIN — Pivot from JARVIS to a Pair-Programming Assistant

## Context

JARVIS at `~/command_center/` was built as an autonomous multi-agent
organization (CEO / PO / tech-lead / eng-1/2/3 / QA / devops dispatching each
other through 55 workflow rules). Pattern did not deliver reliably: agents
produced initial checkpoints and went idle, tech-lead rejected off-scope
artifacts, PO escalation loops hit rate limits, and the feedback cycle never
closed without human nudges.

**The pivot:** replace the "autonomous org" with a single pair-programming
assistant. One human drives vision + business decisions; one AI — **MARVIN** —
owns architecture, infrastructure, code, tests, docs, security. The human says
"let's build the login page"; MARVIN dives deep: reads the codebase, proposes
the schema / wiring / tests, executes with explicit confirms, commits.

**MARVIN** = **M**oderately **A**dvanced **R**obotic **V**irtual
**I**ntelligence **N**etwork. Dry Hitchhiker's-Guide persona ("Here I am,
brain the size of a planet, and they ask me to build a login page"), but the
persona is a style layer on top of a fully competent assistant — never a
refusal-to-work layer.

**Decisions already made:**
- **Name:** MARVIN.
- **Approach:** rebuild from scratch at `~/marvin/` (fresh repo, ~15-20 % code
  reuse — the plumbing only). No autonomous-agent vestiges.
- **Primary surface:** web app on `localhost:3030` — left file tree, centre
  chat + work log, right / bottom embedded terminal + diff viewer.
- **Isolation:** MARVIN carries zero hardcoded knowledge of any prior
  project. No service names, stack choices, realm ids, ports, or workflows
  are baked into the source. Each session is scoped to ONE workDir picked
  by the user, and MARVIN knows only what that workDir contains. A fresh
  project starts from zero — no cross-session memory, no inherited state.
- **Default model:** Claude Opus 4.7 (user-facing partner stays top-tier).
- **Architecture:** single agent with on-demand subagent spawning via
  Claude Code's native `Task` tool. NOT agent teams, NOT autonomous peers.
  Rationale: research (Google, UIUC, Microsoft, Anthropic Research) shows
  multi-agent autonomy degrades up to 70% on sequential code work and
  amplifies errors 17× in flat-topology "bag of agents" setups — exactly
  the failure mode JARVIS hit. Subagents are used only for breadth-first
  exploration, bulk independent work, and context relief.

## Operating model — the senior-engineer workflow

MARVIN runs an 8-phase dialog on each new feature / change request:

1. **Intake** — restate the ask; ask ≤ 3 clarifying questions on anything
   genuinely ambiguous (security model, multi-tenancy rules, identity &
   authz, data ownership, perf SLO, back-compat). "You decide" → MARVIN
   states the decision + why, proceeds.
2. **Discovery** — query graphify FIRST, then read files the graph points
   to, then probe running infra if the work depends on a service. Read
   existing ADRs and the project memory file — past decisions bind.
   Summary: "what exists / what is missing / what is broken".
3. **Impact analysis** — enumerate blast radius. For every module,
   function, endpoint, schema, config, type, event the change touches:
   list direct consumers (1-hop) + transitive consumers (2-hop) + contract
   surfaces (API, DB, shared types, events, flags, migrations). Classify
   each as `no-change` / `mechanical-update` / `semantic-review` /
   `breaking`. User reviews the checklist before architecture proceeds.
   When the graph doesn't know about something (runtime config, infra,
   third-party consumers), mark it `unknown, assume affected`.
4. **Architecture** — propose concrete infra + software changes together;
   trade-offs as ADR-sized notes with 2-3 options + recommendation.
   Material decisions are written as ADR files to `docs/adr/` in the
   project so future sessions see them.
5. **Plan** — ≤ 6 shippable milestones, each with a stated verification
   gate. Each milestone carries the blast-radius entries it touches.
6. **Implement** — milestone by milestone, diff preview → confirm → apply
   → verify → milestone exit checklist (blast-radius entries addressed,
   workspace typecheck clean, tests pass or added, no stray TODOs) → one-
   line landed note citing the commit. Surface surprises; never paper over.
7. **Verify** — run every verification gate end-to-end. Replay the blast
   radius: every entry handled or explicitly deferred with a follow-up
   noted. Type errors / failing tests / red infra are blockers.
8. **Ship** — stage the commit, show diff stat, confirm, commit. If a
   material decision was made, confirm the ADR landed. Append one line to
   `<workDir>/.marvin/memory.md` — the running decision log future
   sessions read. Push / deploy only on user go-ahead.

The "roles" the previous system separated into 8 agents (PO, tech-lead,
engineers, QA, devops) are phases MARVIN moves through in ONE conversation.
No handoffs between peers → none of the 17× error-amplification and
context-loss failures documented in the 2026 multi-agent coding literature.
The user is the continuous overwatch; MARVIN narrates enough to let them
catch a wrong turn in real time.

## Ramification tracking — the three-layer stack

The solo-plus-AI failure mode in a growing codebase is the cross-session
ramification problem: feature 10 at week 8 breaks an assumption made in
feature 3 at week 2. Neither human nor agent can hold the whole project
in head. MARVIN mitigates this with a three-layer stack, each layer
redundantly covering part of the problem space:

1. **Structural impact analysis from the knowledge graph.** Graphify
   `graph.json` under `<workDir>/graphify-out/` is the source of truth
   for "who calls / imports / subscribes to this". Queried in Discovery
   (step 2) and Impact Analysis (step 3). Blast-radius checklist is
   generated directly from 1-hop + 2-hop graph traversal.
2. **Architecture Decision Records** under `<workDir>/docs/adr/*.md`.
   Written at step 4 when a material decision is made. Read at step 2 on
   every future session. Captures decisions structural analysis can't see
   (e.g. "we chose tenant isolation via RLS, not middleware"). Conflicts
   between a proposed change and a prior ADR are surfaced; you either
   refine the plan or write a superseding ADR — never silently contradict.
3. **Running project memory** at `<workDir>/.marvin/memory.md`. Short
   one-line entries appended at Ship (step 8). Captures gotchas,
   invariants, "we decided Y because Z was broken" items that don't
   warrant a full ADR but would be painful to re-derive. Read at
   Discovery.

These live IN THE USER'S PROJECT REPO, not in MARVIN's data dir — they
travel with the code, survive git clones, are visible in code review.
MARVIN's own data dir stays limited to session transcripts + cost ledger.

## Why this actually solves "I can't think of every scenario"

You don't have to. The blast-radius enumeration in step 3 is mechanical
(graph traversal), comprehensive (1-hop + 2-hop by default), and
human-reviewable (checklist you skim). Step 6's exit checklist prevents
milestones from declaring victory without touching everything the blast
radius said they should. Step 2's ADR + memory reads keep week-2
decisions alive in week-8 sessions. Together they transform a
human-memory problem into a tooling problem — and tooling scales.

This operating model is encoded in `packages/runtime/src/personality.ts`'s
`CORE_BEHAVIOR` block (system prompt) and implemented by
`packages/project-context/src/index.ts` (which reads ADRs + memory on
every first-message injection). Change the prompt when the workflow
evolves; the context-reading path already supports it.

## Target architecture

```
~/marvin/
├── apps/
│   └── web/                       # Next.js 16 · App Router · port 3030
│       ├── src/app/
│       │   ├── page.tsx           # 3-pane shell (tree · chat · terminal)
│       │   ├── api/
│       │   │   ├── chat/          # SSE streaming chat + tool calls
│       │   │   ├── projects/      # list / add / switch projects
│       │   │   ├── files/         # tree + content
│       │   │   ├── terminal/      # run shell cmd (streamed)
│       │   │   ├── confirm/       # approve / reject pending tool call
│       │   │   └── graph/         # graphify query passthrough
│       │   └── layout.tsx
│       └── package.json
├── packages/
│   ├── runtime/                   # single Claude session (NOT multi-agent)
│   │   ├── src/claude-cli.ts      # ported from J.A.R.V.I.S
│   │   ├── src/auth.ts            # ported
│   │   ├── src/session.ts         # transcript persist + resume
│   │   └── src/personality.ts     # MARVIN system-prompt style note
│   ├── tools/                     # Bash · Edit · Write · Read · Grep · Glob
│   │   │                          # · WebFetch · WebSearch
│   │   └── src/policy.ts          # confirm-before-act matrix
│   ├── project-context/           # spec + infra probes injected per session
│   │   ├── src/index.ts           # ported from J.A.R.V.I.S project-context.ts
│   │   └── src/infra-probes.ts    # ported from orchestrator/infra-probes.ts
│   ├── graphify-bridge/           # knowledge-graph read + refresh
│   │   ├── src/query.ts
│   │   ├── src/watchdog.ts        # ported from graphify-watchdog.ts
│   │   └── src/refresh-docs.ts    # ported from graphify-docs-refresh route
│   ├── git-watch/                 # commit stream; NO task-artifact posting
│   │   └── src/index.ts           # stripped port of git-watchdog.ts
│   └── ui/                        # shadcn primitives + MARVIN chat bubble,
│                                  # diff viewer, file-tree node, term wrapper
├── data/
│   └── .marvin/                   # transcripts · cost-tracker · graph cache
├── README.md
├── CLAUDE.md                      # project instructions for nested sessions
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

Stack: **Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui + TanStack Query v5**
(same as the working J.A.R.V.I.S UI). Monorepo: **pnpm workspaces + Turbo**.
Terminal: **xterm.js**. Diff viewer: **monaco-editor** (diff mode).

## What ports from `~/command_center/J.A.R.V.I.S/` (verbatim then adapt)

| Source (J.A.R.V.I.S/src/…) | Destination | Why |
|---|---|---|
| `lib/gateway/runtimes/claude-cli-runtime.ts` | `packages/runtime/src/claude-cli.ts` | Claude CLI spawn + JSON parse + SIGTERM handling; already battle-tested. |
| `lib/gateway/auth-manager.ts` | `packages/runtime/src/auth.ts` | `ANTHROPIC_API_KEY` vs OAuth distinction, env threading. |
| `lib/project-context.ts` | `packages/project-context/src/index.ts` | Reads `BUSINESS_OVERVIEW.md` / `PROJECT_STATUS.md`. Drop the `contextAwareAgents` list (only MARVIN now). Keep `injectContextOnFirstMessageOnly`. |
| `lib/orchestrator/infra-probes.ts` | `packages/project-context/src/infra-probes.ts` | `runInfraProbes()` + `formatProbeBlock()` — reusable as-is. |
| `lib/orchestrator/git-watchdog.ts` | `packages/git-watch/src/index.ts` | Strip `addTaskBlocker` / `appendTaskArtifact` / `updateTaskStatus` calls (no board). Keep the commit-list + author-agent match. |
| `lib/orchestrator/graphify-watchdog.ts` | `packages/graphify-bridge/src/watchdog.ts` | Already dispatch-type-agnostic; rename "agent" → "session". |
| `app/api/orchestrator/graphify-docs-refresh/route.ts` | `packages/graphify-bridge/src/refresh-docs.ts` | Anthropic SDK doc-extraction; move out of API layer into the package. |
| `components/ui/*` | `packages/ui/src/*` | shadcn primitives; no changes. |
| `lib/hooks/polling.ts`, `use-projects.ts` | `apps/web/src/hooks/` | visibleRefetchInterval + project list. |
| `lib/paths.ts` | `packages/runtime/src/paths.ts` | Rename `getJarvisDataDir` → `getMarvinDataDir`; default `~/.marvin/` (was `~/command_center/jarvis/.data/`). |

## What stays behind (tombstoned / archived)

Deleted entirely — these only exist to support the autonomous multi-agent
pattern we are walking away from:
- `lib/orchestrator/engine.ts` (≈ 5.9 KLOC dispatch loop)
- `lib/orchestrator/workflow-spec.ts` (55 pipeline rules)
- `lib/orchestrator/default-rules.ts`, `rules-to-tree.ts`, `pipeline-registry.ts`
- `lib/orchestrator/self-critique.ts`, `experience-cache.ts`, `executable-feedback.ts`
- `lib/orchestrator/rule-audit.ts`
- `lib/agents/` (entire directory — dispatch contracts, role enforcement, mailbox, charter, voting)
- `lib/agile*.ts` (hierarchy types, Epic → Story → Task → Sub-task machinery)
- `src/app/agents/`, `src/app/kanban/`, `src/app/pipeline/`, `src/app/sessions/`, `src/app/org/`
- All `/api/admin/*`, `/api/tasks/*`, `/api/human-questions/*` routes
- `jarvis/.data/agents/<role>/workspace/ROLE.md` files (no roles in MARVIN)

**Disposition of existing data (all archive, none referenced by MARVIN):**
- `~/command_center/jarvis/.data/` → archive, read-only. MARVIN neither
  reads nor writes anything here. The path is not referenced anywhere in
  the MARVIN source tree — this bullet is historical for human readers.
- `~/command_center/J.A.R.V.I.S/` → archive. No runtime tie from MARVIN.
  Port-provenance comments in MARVIN source files mention it as the origin
  of individual files, but no code path depends on anything in that tree.
- `~/command_center/graphify-out/` → archive. MARVIN does not read from it.
  Each user-project gets its own `graphify-out/` under its own workDir.
- **Any prior projects MARVIN's predecessor worked on** → not referenced.
  Starting a new project with MARVIN means starting from zero: no shared
  session history, no inherited memory, no assumed services. The user
  picks a workDir at session start; anything outside that workDir is
  opaque to MARVIN.

## Net-new code (packages/tools + apps/web)

### `packages/tools/`
- Tool definitions matching Claude's native set: `Bash`, `Edit`, `Write`,
  `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`. Each is a thin shim over
  filesystem / subprocess / HTTP.
- `policy.ts` — classifies each tool call:
  - **auto-allowed** — `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`.
  - **confirm-before-act** — `Edit`, `Write`, `Bash` (with a regex-driven
    whitelist for safe commands like `git status`, `npm run …`, typecheck).
  - **hard-deny** — `rm -rf`, `git push --force`, anything touching
    `.env` secrets without a confirm from the user.

### `apps/web/` new UI components
- `components/shell/layout.tsx` — 3-pane split (resizable; remembers sizes).
- `components/chat/chat-stream.tsx` — SSE consumer, renders user turns, MARVIN
  turns, and tool-call cards inline (each card has status: pending / running /
  done / error, output, cost).
- `components/chat/confirm-prompt.tsx` — inline approve / reject with diff
  preview when applicable.
- `components/file-tree/tree.tsx` — project browser (collapsible folders, file
  status badges for unstaged changes).
- `components/terminal/term.tsx` — xterm.js wrapper bound to `/api/terminal/run`.
- `components/diff/diff-viewer.tsx` — monaco-editor diff, applied when MARVIN
  proposes an `Edit`.
- `components/status/cost-meter.tsx` — session cost, tokens in/out, model tier.
- `components/project-picker/picker.tsx` — switch active project.

### `apps/web/src/app/api/` new routes
- `POST /api/chat` — body `{ projectId, message }`; streams
  `text/event-stream` with `turn.started` / `tool.started` / `tool.output` /
  `tool.completed` / `turn.completed` events.
- `GET /api/projects` / `POST /api/projects` — list, add, switch.
- `GET /api/files/tree?projectId=…` — return nested tree.
- `GET /api/files/content?projectId=…&path=…` — read file.
- `POST /api/terminal/run` — `{ projectId, cmd }` → SSE stream of stdout/stderr.
- `POST /api/confirm` — `{ turnId, toolCallId, decision: "allow" | "deny" }`.
- `POST /api/graph/query` — passthrough to `packages/graphify-bridge`.

## Phased delivery

### Phase 1 — Foundations (week 1) · **[shipped 2026-04-17]**

- [done] Init `~/marvin/` monorepo: `package.json`, `pnpm-workspace.yaml`,
  `turbo.json`, `tsconfig.base.json`, `tsconfig.json`, `.gitignore`.
- [done] Scaffold `apps/web` directly (Next.js 16 App Router, port 3030,
  Tailwind 4 via `@tailwindcss/postcss`). Written by hand to match the 3-pane
  shell target.
- [done] Port `packages/runtime/` — `paths.ts`, `auth.ts`, `claude-cli.ts`,
  `session.ts`, `personality.ts`. Single `runClaudeCli()` streaming NDJSON
  from `claude -p --output-format stream-json`.
- [done] Port `packages/project-context/` — spec injection + infra-probes
  (11 services probed in parallel, 3-second timeouts, UP/DOWN/UNKNOWN).
- [done] Port `packages/graphify-bridge/` — `watchdog.ts` (AST refresh,
  debounced 10 min) + `refresh-docs.ts` (Anthropic SDK doc extraction).
- [done] Port `packages/git-watch/` — per-workDir HEAD cursor, no board
  autonomy (stripped from the J.A.R.V.I.S original).
- [done] `packages/tools/` stub with the policy classes (auto / confirm /
  deny) + Bash allow-list regexes. Tool implementations land in Phase 2.
- [done] `packages/ui/` stub — populated in Phase 2–3 alongside the chat UI.
- [done] Baseline `apps/web/src/app/api/chat/route.ts` — SSE streaming,
  persists every `cli.event` + final `turn.completed` to
  `~/.marvin/sessions/<projectId>/<sessionId>.jsonl`.
- [done] `apps/web/src/app/api/health/route.ts` — reports auth mode + CLI
  binary path + default model + data dir.
- [done] First commit on `main`: `12d734a`.

**Milestone achieved:** `curl http://localhost:3030/api/health` returns 200
with auth mode, binary path, and default model. `curl -N
http://localhost:3030/api/chat -d '{"message":"hello","cwd":"..."}'` SSE-streams
a MARVIN-voiced reply when credentials are available (host OAuth via
`MARVIN_USE_HOST_CREDENTIALS=1` or `ANTHROPIC_API_KEY`).

### Phase 2 — Chat + tools (week 2) · **[shipped 2026-04-17 · final 2026-04-17]**

- [done] Typography + design system: Geist Sans / Geist Mono via
  `next/font/google`; Tailwind v4 `@theme` tokens for the MARVIN palette;
  glass-morphism + ambient radial backdrop; thin scrollbars; `rise-in`
  animation for streaming chat; five keyframes for the brain states.
- [done] **MARVIN brain** (`components/brain/marvin-brain.tsx`) — hand-authored
  SVG head silhouette + 20 nodes + 35 synaptic edges + firing particles
  via CSS `offset-path` along each edge. Five states: idle / thinking /
  tool / writing / error. Scales activity (particle count, duration, hue)
  with state. No runtime deps.
- [done] Chat stream hook (`components/chat/use-chat-stream.ts`) — SSE
  client that parses `turn.started` / `cli.event` / `turn.completed` /
  `turn.error`; reshapes Claude CLI NDJSON into assistant blocks
  (text + tool_use + merged tool_result); derives the MARVIN UI state
  (idle / thinking / tool / writing / error) from event flow.
- [done] Message rendering (`message-view.tsx`, `tool-call-card.tsx`) —
  user / assistant bubbles, minimal markdown (fenced code + inline code),
  collapsible tool-call cards with status pill (running / done / failed)
  and expandable input/output panels.
- [done] Input dock (`input/chat-input.tsx`) — project-path field,
  auto-grow textarea, ⏎ to send / ⇧⏎ newline, cancel button during runs.
- [done] Status bar (`shell/status-bar.tsx`) — MARVIN state indicator,
  duration, tokens, cost, session id.
- [done] Main layout (`app/page.tsx`) — left conversation column
  (header → status → message list → input dock) + right MARVIN brain
  pane with meta (project / model / version).
- [done] Prompt improvements landed in `personality.ts`: runtime grep
  step in Impact Analysis, enforced ADR template, Future-MARVIN critique
  subagent pass, explicit skip for trivial changes.
- [done] Confirm-before-act gate — **structural**, via migration from
  the CLI spawn path (`claude -p --dangerously-skip-permissions`) to
  `@anthropic-ai/claude-agent-sdk`'s programmatic `query()` with a real
  `canUseTool` callback. `packages/runtime/src/sdk-runner.ts` registers
  a pending-resolver keyed by `(turnId, toolUseID)` whenever the tool
  policy classifies a call as `confirm`; `/api/chat` forwards a
  `confirm.request` SSE event; the client renders an inline
  `<ConfirmPrompt>` (with a monaco diff for Edit / Write or a `$ cmd`
  block for Bash) inside the tool-call card; the user's allow / deny
  posts to `/api/confirm`, which looks up the resolver and returns
  `{ behavior: "allow" }` or `{ behavior: "deny", message }` to the
  SDK. Auto-allowed (Read / Grep / Glob / WebFetch / WebSearch +
  whitelisted Bash) and hard-deny (`rm -rf /`, force-push to main,
  etc.) short-circuit without prompting. Policy lives in
  `@marvin/tools/policy`.
- [deferred] `packages/tools/` actual tool implementations. Not needed
  even after the SDK migration — the SDK executes built-in tools
  itself; our policy layer only gates, it doesn't reimplement them.
  Revisit only if we need custom tool code (Honeycomb MCP, etc.).

**Milestone:** in a throw-away sample project, chat "build a logout
route" — MARVIN reads files, proposes the edit (rendered in the tool-
call card), applies, runs typecheck, offers to commit. Reached once
credentials are available in the env (`ANTHROPIC_API_KEY` or
`MARVIN_USE_HOST_CREDENTIALS=1`).

### Phase 3 — File tree + terminal + diff viewer (week 3) · **[shipped 2026-04-17]**

- [done] `/api/files/tree?cwd=<path>&depth=<n>` — Node fs walker with
  ignore-list (node_modules, .git, .next, venv, __pycache__, target,
  dist, build, coverage, caches), MAX_ENTRIES=2000 cap, depth-limited
  (default 6), returns `{ root, tree, truncated, count }`.
- [done] `/api/files/content?cwd=…&path=…` — read-one endpoint with
  cwd-sandboxed path (rejects `..` escapes), 512KB cap, binary-file
  detection (null-byte + non-printable heuristic). Returns
  `{ path, size, binary, truncated, content }`.
- [done] `/api/files/status?cwd=…` — shells
  `git status --porcelain=v1` + `rev-parse --abbrev-ref HEAD` with
  a 5s per-call timeout. Returns `{ isGit, branch, status }` keyed by
  absolute path. Falls back to `isGit: false` outside a work tree.
- [done] `/api/terminal/run` — POST `{ cwd, cmd }` → SSE stream of
  `started` / `stdout` / `stderr` / `exit` events. Spawns via
  `$SHELL -c` so pipes + `&&` + env vars work. 10-minute cap;
  request-abort kills the child; 8KB cmd-length cap.
- [done] `components/file-tree/file-tree.tsx` — collapsible folders,
  click-to-select files, root children expanded by default, rendered
  as a `scroll-thin` monospace column at 240px width. Left-pinned as
  the first pane in the split-view conversation layout. Shows a
  branch badge in the header and per-file git-status glyphs (M / A /
  D / ?) with a dot on dirty ancestor directories.
- [done] `components/file-viewer/file-viewer.tsx` — splits the center
  column below the chat when a tree file is clicked. Sticky line
  numbers, extension-based language label, size + line-count header,
  close button. Binary and oversize files show a placeholder.
- [done] `components/terminal/terminal.tsx` — xterm.js (`@xterm/xterm`)
  + fit-addon. MARVIN palette tokens wired into the xterm theme.
  Maintains its own line buffer + localStorage-persisted command
  history (↑/↓). Ctrl-C cancels the running command or clears the
  line; Ctrl-L clears the screen. stderr rendered red; exit line
  shows `[ok · 1.23s]` or `[exit N · 1.23s]`. Mounted behind a
  header toggle as a collapsible bottom pane in the center column.
- [done] Main layout upgraded from 2-pane to 3-pane in conversation
  mode: tree · chat · brain/meta. Hero view unchanged. Chat pane
  vertically subdivides when a file viewer and/or terminal is open.
- [done] `components/diff/diff-viewer.tsx` — monaco-editor DiffEditor
  (via `@monaco-editor/react`) with a custom MARVIN dark theme. Auto-
  mounts inside Edit / Write tool-call cards and inside Confirm
  prompts, showing the pre-execution diff so you see what MARVIN is
  about to do before allowing it. Inline diff mode, read-only,
  language detected from extension.
- [done] Resizable splits via `react-resizable-panels`: horizontal
  between tree / center / brain, vertical within the center column
  when the file viewer or terminal is open. Sizes persist to
  localStorage via the `autoSaveId` on each `PanelGroup`.

**Milestone:** visual parity with the 3-pane mock-up — tree on left, chat
centre, terminal at the bottom; editing a file updates the tree badge; the
terminal reflects changes made via the chat.

### Phase 4 — Persistence, project picker, polish (week 4)

- Session persistence: `data/.marvin/sessions/<projectId>/<sessionId>.jsonl`
  with auto-resume on reload.
- Project picker: `/api/projects` + switcher component; each project has its
  own conversation history and graph.
- Cost tracker UI + daily / weekly breakdowns.
- Personality toggle: `marvin` (default) | `neutral`.
- Graphify panel — collapsible right-side panel showing the active project's
  knowledge graph; MARVIN annotates which node it's looking at.

**Milestone:** ship MARVIN v1 — dog-food it on a fresh small project
(e.g. a throwaway Next.js + Prisma starter) start-to-ship without falling back
to manual editing.

### Phase 5 — Stretch (weeks 5-6, optional)

- **Advisor Strategy experiment.** Anthropic launched `advisor_20260301`
  April 9 2026: Sonnet 4.6 or Haiku 4.5 as the executor driving the task
  loop, escalating to Opus 4.6 as an advisor on demand. Reported +2.7 pts
  SWE-bench Multilingual for Sonnet at -11.9% cost, and Haiku BrowseComp
  19.7 → 41.2. Worth an A/B on MARVIN once Phase 2-3 are stable: could
  reduce per-session cost ~30-40% with minimal quality loss for routine
  code work. Add a `runtimeMode: "opus" | "advisor"` setting; keep Opus as
  default.
- Honeycomb MCP integration for observability (port-over from command_center).
- Playwright live browser preview inside the web UI.
- Graph-aware chat: "why is module X coupled to module Y?" answered from the
  graphify graph rather than by file reads.
- Dark-mode polish, keyboard shortcuts, session search.

## MARVIN personality

- System-prompt style note appended to every dispatch — not a behavior
  override. Never blocks a task; never refuses; never pretends to actually be
  depressed. Dry British wit, mild grumbling, absolutely executes.
- Toggleable (`marvin` vs `neutral`) via user settings so it can be switched
  off for pairing with others.
- Example voice — appended to tool output summaries:
  > "Edit applied. A thrilling 17 lines. I trust you'll find reading them a
  >  rewarding experience."

## Verification

End-to-end smoke on a sample Next.js + Prisma project in `~/scratch/login-demo/`:

1. `pnpm --filter marvin-web dev` starts the app on `http://localhost:3030`.
2. Project-picker → select `~/scratch/login-demo/`.
3. Chat: **"Show me the auth flow."**
   - MARVIN queries graphify, reads `lib/auth.ts` + callers, answers with
     citations (node labels + source file + line).
4. Chat: **"Build a `/api/logout` endpoint that clears the session cookie."**
   - MARVIN proposes schema / route / call sites, renders a diff, asks to
     confirm, applies on approve, runs `pnpm typecheck` in the embedded
     terminal, offers to commit.
5. Approve the commit. `git log` in the built-in terminal shows the new
   commit authored by `MARVIN <marvin@localhost>`.
6. Open the real system terminal, run `pnpm typecheck` directly — same
   output as the embedded one.
7. Kill `pnpm dev`, restart, reload the web app — conversation resumes from
   the last turn; pending confirms still pending.
8. Switch to another project → fresh conversation, different graph, different
   context.
9. Cost meter reflects today's spend; daily breakdown matches
   `~/.marvin/cost-tracker.json`.
10. Infra probes — **off by default**. A project opts in by configuring
    probes in its own repo (Phase 2+ will add a discovery mechanism, likely
    reading `docker-compose.yml` services). Confirm the default session
    prompt contains no probe block for a bare project directory.

## Changelog

- **2026-04-17** — Phase 1 shipped. Commit `12d734a` on `main`. Server on
  port 3030, `/api/health` 200, `/api/chat` SSE-streams. 6 packages
  scaffolded; 4 fully ported (runtime, project-context, graphify-bridge,
  git-watch). Typecheck clean across the workspace. PLAN.md lives in-repo
  at `~/marvin/PLAN.md` (mirror at `~/.claude/plans/glowing-cooking-reddy.md`).
- **2026-04-17 (afternoon)** — Isolation audit. Stripped every runtime tie
  to any specific prior project. `infra-probes.ts` rewritten — no hardcoded
  service list, no realm URL; only exports project-agnostic probe primitives.
  `buildProjectContext()` no longer runs probes by default (caller passes
  them explicitly). Placeholder project paths in `page.tsx`, `CLAUDE.md`,
  `PLAN.md` replaced with generic `/path/to/your/project`. UI primitives
  ported (button, input, card, badge, separator, scroll-area, skeleton,
  dialog, sheet, tabs, select, tooltip, dropdown-menu, avatar, table) with
  `cn()` helper in `@marvin/ui/utils`.
- **2026-04-17 (evening)** — Architecture decisions locked after research
  pass on 2026 multi-agent literature. Default model → Opus 4.7. Encoded
  the 7-phase senior-engineer workflow in `personality.ts`: intake →
  discovery (graphify-first) → architecture → plan → implement → verify →
  ship. Added explicit subagent-delegation rules (when YES / when NO).
  Added Phase 5 stretch: Advisor Strategy experiment (Sonnet exec + Opus
  advisor) for cost reduction once v1 stabilises.
- **2026-04-17 (night — Phase 2 core)** — Modern chat UI + MARVIN brain
  shipped. Geist font family, Tailwind v4 theme tokens, glass-morphism,
  ambient radial backdrop. `<MarvinBrain state={...} />` is a pure-SVG
  component: head silhouette, 20 neural nodes (breathing glow), 35 edges,
  firing particles via CSS `offset-path` animation — no canvas/WebGL
  deps. States idle / thinking / tool / writing / error drive activity
  intensity and hue. Chat stream hook parses Claude CLI NDJSON into
  assistant blocks; tool-call cards are collapsible; cost + token meter
  in status bar. Prompt improvements A/D/E/F/J landed in
  `personality.ts`: runtime grep in Impact Analysis, enforced ADR
  template with Future-MARVIN critique subagent, explicit skip for
  trivial changes. Structural confirm-before-act gate deferred as Phase
  2 follow-up (requires CLI permission-mode change or Agent SDK move).
- **2026-04-17 (late evening)** — Ramification tracking added after user
  flagged the "I can't enumerate every scenario in a growing project"
  failure mode (real — this is how solo-plus-AI projects typically
  collapse around month 3). Expanded workflow from 7 phases to 8 by
  inserting **Impact Analysis** between Discovery and Architecture.
  Impact Analysis is the explicit blast-radius enumeration step —
  mechanical graph traversal, classified checklist, user-reviewable
  before architecture is even proposed. Added ADR writing at Architecture,
  ADR reading at Discovery (`<workDir>/docs/adr/*.md`), project memory
  read/append at Discovery/Ship (`<workDir>/.marvin/memory.md`).
  `@marvin/project-context` now injects both into every first-message
  prompt. Milestone exit checklist enforces blast-radius entries aren't
  forgotten mid-implementation.
- **2026-04-17 (pre-dawn — Phase 2 + 3 closeout)** — Two big swings.
  (1) Runtime migrated from the raw CLI (`claude -p
  --dangerously-skip-permissions`) to `@anthropic-ai/claude-agent-sdk`
  so we can register a real `canUseTool` pre-flight gate. New
  `packages/runtime/src/sdk-runner.ts` + `confirm-registry.ts`
  (in-process resolver map keyed by `turnId + toolUseID`). New
  `/api/confirm` POST endpoint. `/api/chat` emits a new
  `confirm.request` SSE event; client renders `<ConfirmPrompt>`
  inline in the tool-call card with a monaco diff for Edit / Write
  or a `$ cmd` block for Bash. Auto-allowed (Read / Grep / Glob /
  WebFetch / WebSearch / whitelisted Bash) and hard-deny patterns
  short-circuit without prompting, driven by
  `@marvin/tools/policy.ts`. (2) Phase 3 finished: monaco diff viewer
  (`@monaco-editor/react`) with a MARVIN-themed palette, mounted in
  Edit / Write tool-call cards AND in ConfirmPrompt so the pre-flight
  diff shows before you allow. Resizable splits via
  `react-resizable-panels` — horizontal between tree / chat / brain,
  vertical between chat / file-viewer / terminal inside the center
  column; layouts persist via `autoSaveId` to localStorage. Typecheck
  clean across all 7 packages.
- **2026-04-17 (graphify baseline)** — First graphify run on MARVIN's
  own source + PLAN + CLAUDE.md. 233 nodes · 248 edges · 44
  communities. God nodes: `GET()` (11), `8-Phase Senior-Engineer
  Workflow` (10), `Target Architecture` (9), `POST()` (8), `JARVIS
  Failure Mode` (8). Token-reduction benchmark: 36× fewer tokens per
  architecture question vs reading files. Graph + report checked in at
  `graphify-out/`; extraction cache gitignored. CLAUDE.md gained a
  graphify section so future sessions consult the graph before
  answering structural questions.
- **2026-04-17 (deep night — Phase 3 rounds 1 + 2)** — File viewer,
  git-status, embedded terminal. Round 1 landed
  `/api/files/content` (cwd-sandboxed, 512KB cap, binary guard) and
  `/api/files/status` (porcelain v1 + branch, 5s timeout). FileTree
  gained per-file M/A/D/? badges plus a branch pill and dirty-
  ancestor dots. FileViewer splits the center column below the
  chat with sticky line numbers and an extension-based language
  label. Round 2 added `@xterm/xterm` + fit-addon, wrote
  `/api/terminal/run` (SSE with `started` / `stdout` / `stderr` /
  `exit`, spawning `$SHELL -c`, 10-minute cap, abort-kills-child),
  and a Terminal component with its own line buffer, persisted
  command history, Ctrl-C cancellation, Ctrl-L clear, and red
  stderr. A header toggle opens/hides the terminal below the chat.
  Phase 3 remainder: monaco diff viewer + resizable drag handles.
- **2026-04-17 (late night — Phase 2 close, Phase 3 start)** — Brain
  density rework after the previous version felt laggy and sparse.
  NODES went from 20 → 45, EDGES 35 → 95, organised into six clusters
  (frontal / crown / occipital / hub / temporal / bridges). Head
  silhouette replaced with a clean ovoid (no more bulb-base
  artefact). Idle now has continuous low-rate firing (22% of edges);
  writing peaks at 85% with 3 particles per firing edge. Added edge
  opacity-pulse (cheap suggestion of latent flow), ambient dust
  particles orbiting inside the silhouette, and firing-edge
  baseline highlight. Replaced the expensive `<feGaussianBlur>`
  filter on particles with CSS `filter: drop-shadow()` (GPU-
  composited) — fixes the lag. Phase 3 kicked off: `/api/files/tree`
  endpoint (fs-walker, ignore-list, 2000-entry cap) and
  `<FileTree>` component landed; main layout upgraded to 3-pane
  (tree · chat · brain) in conversation mode. Phase 2 marked
  shipped; remaining confirm-gate + tool impls tracked under Phase 2
  follow-ups.
- **2026-04-17 (night — Phase 2 polish)** — Hero + ambient polish pass.
  Empty-state rewritten as a centered hero: 360px MARVIN brain with
  `hero-brain-intro` entry animation, glowing `MARVIN` wordmark
  (`.title-glow`), tagline, Hitchhiker's quote, and input dock pinned
  bottom. Once the first message arrives, the layout switches to the
  split view (chat left, brain sidebar right). The ambient backdrop now
  reacts to activity: `document.body[data-marvin]` drives
  `--marvin-activity` 0..1, which scales the three radial gradient
  opacities; a 28s `backdrop-drift` keyframe keeps the screen breathing
  when idle. Brain component gained an activity profile with
  `haloRings`, `sparks`, breathe mode (calm/normal/intense), and
  `nodeGlowScale` — idle renders one calm ring and no sparks; writing
  ripples three fast rings plus seven escape sparks drifting beyond
  the silhouette via a new `spark-drift` keyframe driven by
  `--spark-dx`/`--spark-dy` CSS vars. Typecheck clean.

## Open items (quick confirms, not blockers)

- **Monorepo**: pnpm + Turbo assumed — OK or prefer npm workspaces / Nx?
- **Terminal lib**: xterm.js assumed. Alternatives: wezterm-web, vt100-js.
- **Diff viewer**: monaco-editor (large bundle). Alt: `diff2html` (lighter).
- **Confirm granularity**: per-tool-call or batched? Assumed per-call for v1.
- **Does MARVIN need memory across projects?** v1: no — memory is per-project
  (conversation + graph). v2 could add a cross-project experience cache.

## Critical files to reference during build

From `~/command_center/J.A.R.V.I.S/`:
- `src/lib/gateway/runtimes/claude-cli-runtime.ts`
- `src/lib/gateway/auth-manager.ts`
- `src/lib/project-context.ts:650-700` (probe-block injection)
- `src/lib/orchestrator/infra-probes.ts` (the whole file — port verbatim)
- `src/lib/orchestrator/git-watchdog.ts` (strip autonomy, keep commit match)
- `src/lib/orchestrator/graphify-watchdog.ts` (rename only)
- `src/app/api/orchestrator/graphify-docs-refresh/route.ts` (the Anthropic SDK
  extraction pattern)
- `src/app/agents/live/page.tsx` (UI reference for a live streaming view)
- `src/components/ui/*` (shadcn primitives)

From `~/.claude/skills/graphify/SKILL.md`:
- The doc-extraction prompt and JSON schema — already used once in this
  session; reuse inside `packages/graphify-bridge`.

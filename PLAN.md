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

**Disposition of existing data:**
- `~/command_center/jarvis/.data/` → archive read-only. Historical memories,
  audit logs, session transcripts, cost-tracker. Not migrated.
- `~/command_center/J.A.R.V.I.S/` → leave in place with a `DEPRECATED.md`
  pointing to `~/marvin/`. Delete after MARVIN has shipped v1 and proven out.
- `~/command_center/graphify-out/` → stays; referenced by `~/marvin/` as the
  `~/command_center` project graph. New project graphs live under each
  project's `graphify-out/`.
- `~/Projects/my-other-project/` → continues unchanged. MARVIN operates on it the
  same way it operates on any project, just through the new UX.

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

### Phase 2 — Chat + tools (week 2)

- Build `packages/tools/` (the 8 tools + policy).
- Wire tools into `packages/runtime/`.
- Build chat UI: `chat-stream`, `confirm-prompt`, cost meter.
- Port `packages/git-watch/` and `packages/graphify-bridge/`.
- Confirm-before-act: every `Edit` / `Write` / risky `Bash` renders a prompt
  card the user must allow / deny before execution.

**Milestone:** in a throw-away sample project, chat "build a logout route" —
MARVIN reads files, proposes the edit, renders the diff, asks for confirm,
applies on approval, runs typecheck, offers to commit.

### Phase 3 — File tree + terminal + diff viewer (week 3)

- `components/file-tree/` — fetches `/api/files/tree`, shows unstaged badges
  by shelling `git status --porcelain`.
- `components/terminal/` — xterm.js bound to `/api/terminal/run` SSE.
- `components/diff/` — monaco diff viewer, mounts automatically when an `Edit`
  tool call is pending.
- Layout shell (`components/shell/layout.tsx`) wires all three panes with
  resizable splits.

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
10. Infra probes surface in system prompt — verified by asking "what services
    does this project depend on?" and checking MARVIN cites the probe block.

## Changelog

- **2026-04-17** — Phase 1 shipped. Commit `12d734a` on `main`. Server on
  port 3030, `/api/health` 200, `/api/chat` SSE-streams. 6 packages
  scaffolded; 4 fully ported (runtime, project-context, graphify-bridge,
  git-watch). Typecheck clean across the workspace. PLAN.md lives in-repo
  at `~/marvin/PLAN.md` (mirror at `~/.claude/plans/glowing-cooking-reddy.md`).

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

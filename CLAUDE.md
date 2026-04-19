# MARVIN — project instructions

This is MARVIN, the pair-programming AI assistant. See [PLAN.md](./PLAN.md) for
the authoritative delivery plan. Update it as you ship things.

## Golden rules for working in this repo

1. **Single assistant, not an agent team.** MARVIN is one Claude session in a
   user-MARVIN loop. Do not reintroduce multi-agent dispatch, role catalogs,
   pipeline rules, or Kanban-as-source-of-truth — that pattern degrades up to
   70 % on sequential code work and amplifies errors 17× in flat-topology
   "bag of agents" setups (2026 multi-agent coding literature).
2. **Plan-first, execute-second, verify-third.** Every feature has an entry in
   PLAN.md before code lands. Mark entries as `[done]` and add a brief "what
   shipped" note when complete.
3. **Auto-mode by default — full bypass.** MARVIN runs every tool without a
   confirm prompt, matching `claude --dangerously-skip-permissions`. The
   header `perms` toggle flips to `gated` when you want the pre-flight
   confirm card back (Edit / Write / unsafe Bash render a card; reads +
   whitelisted commands auto-allow; destructive regexes hard-deny). Auto
   mode is stored in `localStorage.marvin.permissionStrategy` so it
   persists across reloads.
4. **The user's project is a separate workspace.** MARVIN's own code lives
   here in `~/marvin/`. The user's active project (the thing MARVIN is
   helping build) lives in its own directory chosen by the user at session
   start. MARVIN holds no persistent knowledge of past projects between
   sessions — starting a new project means starting from zero. Never cross-
   contaminate one project's context with another.
5. **No truncation of project context.** If the project includes context
   documents (`PROJECT_STATUS.md`, `BUSINESS_OVERVIEW.md`, `README.md`, etc.),
   they are injected whole. No hardcoded 6 KB cap — that was a lesson
   learned the hard way.
6. **No hardcoded project knowledge.** MARVIN must not ship assumptions
   about any specific project (service names, realm ids, stack choices,
   workflow). Every such assumption goes into the user's project repository,
   not into MARVIN's source.
7. **Graphify FIRST — always, before any structural file read.** For any
   "how does X work", "who calls Y", "where is Z implemented", or
   blast-radius question about this codebase, query the knowledge graph
   BEFORE reading files. From a MARVIN session: the `marvin-graph` MCP
   tools (`graph_summary`, `graph_search`, `graph_neighbors`,
   `graph_path`). From a Claude Code session: `/graphify query "…"`,
   `/graphify path "A" "B"`, `/graphify explain "Node"`. Files are read
   only after the graph has pointed at specific source locations. Grep
   and Read are second-line tools — used when the graph doesn't cover
   what you need. "Grep and pray" is the failure mode this rule exists
   to eliminate. Exceptions: trivial content reads (version checks,
   named-file requests) and files you're actively editing. Every other
   unsolicited file read on a codebase question is a rule violation.

## Repo layout

```
apps/web/                    # Next.js 16, port 3030
packages/
  runtime/                   # Claude CLI wrapper + auth + session + personality
  tools/                     # Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch
  project-context/           # spec + infra-probes injection
  graphify-bridge/           # knowledge-graph read + refresh
  git-watch/                 # commit stream
  ui/                        # shadcn primitives + MARVIN chat bubble, diff, file tree
data/.marvin/                # transcripts, cost tracker, graph cache (gitignored)
```

## Key packages

| Path | Responsibility |
|---|---|
| `apps/web/` | Next.js 16 shell (chat, files, terminal, preview, picker). |
| `packages/runtime/` | Claude Agent SDK runner, auth, session persistence, cost tracker, project registry, personality. Confirm gate lives here (`sdk-runner.ts → canUseTool`). |
| `packages/tools/` | Tool policy — which calls auto-allow, confirm, hard-deny. |
| `packages/project-context/` | First-message context injection: project docs + ADRs + `.marvin/memory.md` + graphify summary + opt-in infra probes. |
| `packages/graphify-bridge/` | Read-side of the knowledge graph + the in-process MCP server MARVIN queries per turn. |
| `packages/git-watch/` | Commit detector — surfaces new commits inline, per `workDir`. |
| `packages/ui/` | shadcn primitives shared by the web app. |

## Data directory

`MARVIN_DATA_DIR` env var, default `~/.marvin/`. Stores:
- `sessions/<projectId>/<sessionId>.jsonl` — conversation transcripts
- `cost-tracker.json` — daily/weekly/lifetime spend
- `projects.json` — registered projects (id, name, workDir)
- Graph caches per project live next to the project (`<workDir>/graphify-out/`).

## Personality

MARVIN's persona is a style layer, not a refusal layer. Dry wit ("A login page.
How thrilling."), always delivers. Toggle lives in user settings:
`personality: "marvin" | "neutral"`.

## Skills MARVIN expects

MARVIN's SDK sessions inherit the user's Claude Code skills from
`~/.claude/skills/`. Install them once with:

```bash
bash scripts/install-skills.sh
```

The repo ships a pinned mirror of the Anthropic skill set at
`.claude/skills/`. The install script copies from that bundle into
`~/.claude/skills/` (idempotent — existing user-level skills are left
alone) and only falls back to a GitHub clone when a skill is missing
from the bundle:

| Category | Skill |
|---|---|
| Design | `frontend-design`, `canvas-design`, `theme-factory`, `brand-guidelines` |
| Productivity — docs | `doc-coauthoring`, `docx`, `pdf`, `pptx` |
| Data | `xlsx` |
| Engineering | `claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`, `skill-creator` |
| Operations / PM | `internal-comms` |
| Knowledge graph | `graphify` (install separately — see `~/.claude/skills/graphify/SKILL.md`) |
| Observability | Honeycomb skills ship as a Claude Code plugin — `/plugin install honeycomb` |

`packages/runtime/src/personality.ts` tells MARVIN when to invoke each.
If you add a new skill, also add it to the `CORE_BEHAVIOR` "Skills to
reach for" section so MARVIN knows the trigger conditions.

## Playwright MCP

MARVIN ships its own Playwright MCP server so agent sessions can drive
a real browser against `localhost` / LAN URLs — the host's own
Playwright MCP (if any) is often sandboxed. Registered in
`packages/runtime/src/sdk-runner.ts` as `marvin-playwright`, backed by
[`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp).

One-time setup on a fresh machine (needed for the browser binaries —
they're not shipped via npm):

```bash
npx playwright install chromium
```

Env knobs (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `MARVIN_PLAYWRIGHT` | unset (= enabled) | set to `0` to skip registering the MCP |
| `MARVIN_PLAYWRIGHT_HEADED` | `0` (headless) | set to `1` for a visible window |
| `MARVIN_PLAYWRIGHT_BROWSER` | chromium | `chromium` / `firefox` / `webkit` |
| `MARVIN_PLAYWRIGHT_PROFILE` | isolated | path to a persistent user-data-dir |
| `MARVIN_PLAYWRIGHT_VIEWPORT` | default | e.g. `1440,900` |

## Adding a new feature

1. Open `PLAN.md`, find the phase it belongs to. Add a bullet under the phase
   if it isn't already scoped.
2. Implement.
3. Update the bullet with a `[done YYYY-MM-DD]` marker and a one-line summary.
4. If you discover a follow-up while building, add it to the same phase (or
   the appropriate later phase) — don't let it live only in your head.

## graphify

A knowledge graph of MARVIN's own code + docs is at `graphify-out/graph.json`
(343 nodes · 396 edges · 68 communities as of 2026-04-19).

See [Golden rule 7](#golden-rules-for-working-in-this-repo) — this is a
non-negotiable rule, not a nice-to-have. Querying the graph is ~36× cheaper
per question than file reads and catches structural couplings grep would
miss.

### Before any structural exploration or codebase question

**MANDATORY.** Do this before Read / Grep / Glob on any source file:

1. **Orient.** `/graphify query "<the question>"` — returns BFS-ranked
   relevant nodes with source citations.
2. **Trace couplings.** `/graphify path "A" "B"` — shortest path between
   two concepts.
3. **Explain a single thing.** `/graphify explain "NodeName"` — full
   neighborhood of one node.

Only read files **after** the graph has pointed at specific
`source_file` + `source_location`s. Cite those locations in the
answer. Never synthesize a structural explanation from imagination.

### After changes

- Code-only changes: `/graphify . --update` (AST-only, no LLM cost).
- Docs / PLAN / personality.ts changes: `/graphify . --update` (triggers
  semantic re-extraction — minimal cost at this corpus size).

### God nodes (most-connected abstractions)

`GET()`, `POST()`, `Target Architecture (Repo Layout)`, `8-Phase
Senior-Engineer Workflow`, `apps/web new API routes`,
`getAnthropicAuth()`, `runAgent()`, `buildProjectContext()`,
`createGraphMcpServer()`, `toolPolicy()`.

_Refresh this list with `/graphify . --update` when it drifts._

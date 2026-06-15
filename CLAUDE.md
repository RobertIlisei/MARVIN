# MARVIN — project instructions

This is MARVIN, the pair-programming AI assistant. For the current state of
the project (in flight / shipped / deferred / not planned) see
[`docs/roadmap.md`](./docs/roadmap.md). For chronological history with the
diagnostic trail per change, see [`docs/history/CHANGELOG.md`](./docs/history/CHANGELOG.md).

## Golden rules for working in this repo

1. **Single assistant, not an agent team.** MARVIN is one Claude session in a
   user-MARVIN loop. Do not reintroduce multi-agent dispatch, role catalogs,
   pipeline rules, or Kanban-as-source-of-truth — that pattern degrades up to
   70 % on sequential code work and amplifies errors 17× in flat-topology
   "bag of agents" setups (2026 multi-agent coding literature). The three
   sanctioned exceptions are bounded, **read-only** subagents spawned by the
   main session for a parenthetical task: the **advisor** (second opinion on
   hard decisions — [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md)),
   the **scout** (breadth-first read-only research — [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md)),
   and **dynamic workflows** (read-only audit / research / discovery fan-out
   at `effort: xhigh`, opt-in — [ADR-0030](./docs/decisions/0030-dynamic-workflows-read-only-fan-out.md)).
   All three share one enforced invariant: **a subagent cannot mutate the
   workspace** — the permission gate hard-denies Write/Edit/NotebookEdit and
   unsafe Bash from any call that carries an SDK `agentID`. Parallel
   *implementation* remains forbidden; that's the failure this rule exists to
   prevent. Any new subagent type requires a new ADR; these carve-outs are
   not a precedent for general multi-agent dispatch.
2. **Plan-first, execute-second, verify-third.** For non-trivial work,
   sketch the approach before writing code, then verify it after. This is a
   practice, not an artifact rule — write things down where they help (chat,
   a `Plan`, a roadmap entry, an ADR), not because a doc requires it.
   The repo's roadmap lives at [`docs/roadmap.md`](./docs/roadmap.md);
   keep its `## In flight` section current as work moves through.
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
8. **Define done before doing — match-not-improve.** For any
   non-trivial work, state a falsifiable Definition of Done (3-5
   bullets, each something an observer could mark "yes that happened"
   or "no, not yet") BEFORE writing code. Phase 7 verifies against
   that DoD, not against an evolving sense of quality. If you spot
   adjacent improvements while implementing, list them as "noticed
   while in flight, not in scope" and ask the user — never silently
   land them. End real-work turns with `**Scope met:** <DoD as past
   tense>. Anything else, or should I stop?` The "helpful spiral"
   (six commits past the small ask, each step seemed worth doing) is
   the failure mode this rule exists to prevent. ADRs carry their own
   `## Scope of Done` block per the template in `personality.ts`.

### The firm surfaces

MARVIN's prompt (`sidecar/packages/runtime/src/personality.ts`) codifies several
enumerated trigger / contract lists that replace soft "use judgement"
language with deterministic MUST / MUST-NOT categories. When the prompt
and a human doc disagree, the prompt wins — it's what MARVIN actually
reads at turn time.

| Rule | Location | Purpose |
|---|---|---|
| **Graphify first** | Cross-phase rule 6 in `personality.ts`; Golden Rule 7 above; "Per-tool MUST triggers" section in `personality.ts` | When to consult the graph before reading source files. The 2026-05-27 audit found ~7:1 file-ops to graph-ops drift and that `graph_search` was overused as a glorified grep while `graph_summary` / `graph_query` / `graph_save_result` were near-zero. Each of the 6 graph_* MCP tools now has its own enumerated MUST trigger + MUST-NOT bypass list; AppStatusBar surfaces the live ratio. |
| **Advisor triggers** | Cross-phase rule 7 + "Advisor consult — how to run one" section | When to run a Task-based advisor consult (user-directed + 7 deterministic triggers + anti-triggers). See [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md) for why it's a Task subagent, not an SDK tool. |
| **Scout triggers** | "Scout subagents — when to dispatch one" section | When to dispatch a read-only research subagent via `Task { subagent_type: "scout" }` (3+ deterministic triggers + MUST-NOT list). See [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md) for the SDK-level read-only enforcement. |
| **Dynamic workflows** | "Dynamic workflows — read-only fan-out only" section in `personality.ts` | When `effort: xhigh` may fan out parallel subagents — read-only audit / research / discovery ONLY, opt-in, never parallel implementation. Enforced by the subagent read-only invariant in `classifyToolCall` (any `agentID` call that mutates is hard-denied). See [ADR-0030](./docs/decisions/0030-dynamic-workflows-read-only-fan-out.md). |
| **ADR triggers** | Phase 4 "Deterministic ADR triggers" | When a decision requires an ADR (9 categories + anti-triggers + re-derivation test) |
| **Definition of Done** | Phase 5a "State the Definition of Done" + Phase 7 "Match-not-improve" + ADR template `## Scope of Done` | Bound scope before coding; verify against the DoD; end real-work turns with explicit handoff. See Golden Rule 8 above. |
| **Skill triggers** | "Skill triggers — deterministic invocation" section | When to invoke `test-driven-development`, `systematic-debugging`, `pr-review`, `security-audit`, `frontend-design` via the `Skill` tool (per-skill MUST + MUST-NOT). The 2026-05-22 audit found 5 of 6 skills had soft-nudge language and fired ~0× across thousands of qualifying contexts; this section converts each to a deterministic trigger with NO bypass. |
| **Project memory** | "Project memory — what goes in it" section in `personality.ts`; [ADR-0042](./docs/decisions/0042-memory-as-durable-facts.md) | What may be written to `.marvin/memory.md` and how. Durable facts only (invariants / gotchas / constraints / external facts), via the `remember` MCP tool — MUST-NOT Edit/Write memory.md directly or log activity/decisions/status. The 2026-06-14 audit found a project's memory.md at 419 KB / ~99 % redundant with ADRs/git/changelog; the tool enforces brevity + content-class at the write boundary where prose guidance failed. |

The pattern is the same across all of them: a MUST list, a MUST-NOT list,
and a fallback judgement test for cases the lists don't cover.

## Repo layout

```
macos/                       # SwiftUI macOS app (Xcode / SPM)
  MARVIN/                    # Swift sources
  project.yml                # xcodegen manifest
  Package.swift              # SPM manifest (swift build fallback)
sidecar/                     # Next.js 16 sidecar, port 3030
  src/                       # Next.js app (API routes + React UI)
  packages/
    runtime/                 # Claude CLI wrapper + auth + session + personality
    tools/                   # Tool policy — auto / confirm / deny
    project-context/         # spec + infra-probes injection
    graphify-bridge/         # knowledge-graph read + refresh
    git-watch/               # commit stream
    ui/                      # shadcn primitives
.claude/                     # Claude Code project surface (shared)
  commands/                  # repo-specific slash commands
                             #   /graph-refresh — rebuild code + knowledge
                             #   /rebuild-app   — bundle + install MARVIN.app
  hooks/validate-bash.sh     # PreToolUse: deny --no-verify, force-push to
                             # main, reset --hard origin/*, gpgsign bypass
  settings.json              # shared permissions + hook wiring
  settings.local.json        # personal overrides (gitignored)
  skills/                    # pinned Anthropic skill bundle (see Skills section)
data/.marvin/                # transcripts, cost tracker, graph cache (gitignored)
```

## Key packages

| Path | Responsibility |
|---|---|
| `sidecar/` | Next.js 16 shell (chat, files, terminal, preview, picker). |
| `sidecar/packages/runtime/` | Claude Agent SDK runner, auth, session persistence, cost tracker, project registry, personality. Confirm gate lives here (`sdk-runner.ts → canUseTool`). |
| `sidecar/packages/tools/` | Tool policy — which calls auto-allow, confirm, hard-deny. |
| `sidecar/packages/project-context/` | First-message context injection: project docs + ADRs + `.marvin/memory.md` + graphify summary + opt-in infra probes. |
| `sidecar/packages/graphify-bridge/` | Read-side of the knowledge graph + the in-process MCP server MARVIN queries per turn. |
| `sidecar/packages/git-watch/` | Commit detector — surfaces new commits inline, per `workDir`. |
| `sidecar/packages/ui/` | shadcn primitives shared by the sidecar. |

## Cross-session continuity — `.marvin/memory.md`

MARVIN holds **no** persistent in-memory state between sessions (Golden
rule 4). The bridge across sessions lives in `<workDir>/.marvin/` and is
re-read by `buildProjectContext` on the first turn of every new session.

**memory is a curated durable-facts layer, not an activity log (ADR-0042).**
`.marvin/memory.md` is a one-line-per-fact **index**; each fact is a small file
under `.marvin/memory/<slug>.md`. It holds ONLY what the next session can't
re-derive from ADRs, git, or the changelog — invariants, gotchas, hard
constraints, external facts. Per-turn activity belongs in git/changelog;
decisions belong in ADRs; verification/commit status is ephemeral and goes
nowhere.

- **Write path is the `remember` MCP tool** (`marvin-memory`, `memory-mcp.ts`),
  NOT Edit/Write on memory.md. `remember` writes the fact file + rebuilds the
  index, supersedes by name, caps the hook/body, and rejects activity/status
  payloads. **`recall`** searches the facts. `personality.ts` carries the
  MUST/MUST-NOT firm surface; `/memory-compact` distills a bloated log.
  (This replaces the old "append a line on Ship" model, which let memory.md
  bloat to 419 KB / ~99 % redundant on a real project — the cause of the
  ADR-0041 context overflow.)
- **AppStatusBar context indicator** hover tooltip notes the memory layer is
  active. The **Scope-met chip** now writes a one-liner to
  `.marvin/session-notes.md` ("Save session note") — a lightweight activity
  sink, NOT the durable-facts index (it would otherwise be clobbered by the
  next `remember`). Originally ADR-0022; retargeted by ADR-0042.

`.marvin/memory.md` + `.marvin/memory/` is the only sanctioned cross-session
durable-facts persistence. Don't shadow it with a parallel sidecar cache, a
remote KV, or hidden state in `~/.marvin/` — keeping it in the project
directory makes it the user's thing, not MARVIN's.

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

Only the four **MARVIN-adopted** skills (ports with no upstream source —
`pr-review`, `security-audit`, `systematic-debugging`,
`test-driven-development`) are vendored at `.claude/skills/`. The upstream
Anthropic skills are **not committed** (they're ~10 MB; open-source tidy
2026-06-15) — `install-skills.sh` shallow-clones them from `anthropics/skills`
on demand and copies all of them into `~/.claude/skills/` (idempotent — existing
user-level skills are left alone):

| Category | Skill |
|---|---|
| Design | `frontend-design`, `canvas-design`, `theme-factory`, `brand-guidelines` |
| Productivity — docs | `doc-coauthoring`, `docx`, `pdf`, `pptx` |
| Data | `xlsx` |
| Engineering | `claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`, `skill-creator` |
| Engineering — MARVIN-adopted | `test-driven-development`, `systematic-debugging`, `pr-review`, `security-audit` (ports from Superpowers + gstack; honour `REVIEW.md` at repo root) |
| Operations / PM | `internal-comms` |
| Knowledge graph | `graphify` (install separately — see `~/.claude/skills/graphify/SKILL.md`) |
| Observability | Honeycomb skills ship as a Claude Code plugin — `/plugin install honeycomb` |
| Built-in Claude Code | `/review` (reviews a PR), `/security-review` (security pass on pending changes), `/init` (scaffolds CLAUDE.md) — no install step |

`sidecar/packages/runtime/src/personality.ts` tells MARVIN when to invoke each.
If you add a new skill, also add it to the `CORE_BEHAVIOR` "Skills to
reach for" section so MARVIN knows the trigger conditions.

## Browser automation — Playwright CLI via Bash

When MARVIN needs a browser (visual verification after UI work, end-to-end checks, "doesn't work on my machine" debugging), it shells out via `Bash` to the Playwright CLI directly. `npx playwright` is on PATH after the one-time setup:

```bash
npx playwright install chromium
```

Common shapes MARVIN reaches for (documented in `personality.ts` ▸ "Browser tools"):

- One-shot screenshot: `npx -y playwright screenshot --browser=chromium <url> /tmp/out.png`
- Scripted check: write `/tmp/check.mjs` using the Playwright Node API, run with `node /tmp/check.mjs`
- Full e2e: `npx playwright test` against the project's config

## Adding a new feature

1. Sketch the approach. For anything non-trivial, add a one-line entry under
   `## In flight` in [`docs/roadmap.md`](./docs/roadmap.md) so the work is
   visible. Material design decisions get an ADR under
   [`docs/decisions/`](./docs/decisions/) — see "Deterministic ADR triggers"
   in `personality.ts` for when one is required.
2. Implement.
3. When it lands, move the roadmap entry from `## In flight` to the
   appropriate `## Shipped` block (date-stamped) with a one-line summary.
   For meaningful releases, also add a long-form entry to
   [`docs/history/CHANGELOG.md`](./docs/history/CHANGELOG.md) with the
   diagnostic / decision / verification trail.
4. If you discover a follow-up while building, capture it — as a roadmap
   entry, an ADR, or a GitHub issue — don't let it live only in your head.

**Definition of Done.** Audit and task DoD live at
[`docs/reviews/DEFINITION_OF_DONE.md`](./docs/reviews/DEFINITION_OF_DONE.md).
Apply it before claiming anything is shipped.

## graphify

**Two graphs per project (ADR-0028, development branch).** MARVIN's own
repo:

- **Code graph** at `graphify-out/graph.json` — AST extraction of source
  files. 2011 nodes · 3904 edges · 124 communities (2026-06-14 rebuild;
  honours [`.graphifyignore`](./.graphifyignore)).
- **Knowledge graph** at `graphify-out/knowledge/graph.json` — heading
  structure + cross-doc links from `docs/`, ADRs, `README.md`, `CLAUDE.md`,
  `.marvin/memory.md`. 1085 nodes · 1305 edges · 84 communities (built
  2026-06-14, 81 files).

**Who builds them (ADR-0041).** When the **running IDE** has a project open, it
auto-refreshes that project's *code AND knowledge* graphs per turn — fire-and-
forget from `/api/chat`, debounced, AST-only (no LLM cost), scoped to the
active project's workDir (never MARVIN's own repo). The richer *semantic*
`/graphify` pass (LLM, `GRAPH_REPORT.md` + `cost.json`) stays manual/opt-in.
For a **Claude Code session working on MARVIN's own source** (no running IDE in
the loop), rebuild manually: `/graphify . --update` (code) and
`bin/marvin knowledge-graph .` (knowledge) — both free. (Before ADR-0041 the
code-graph watchdog existed but was dormant — never wired to a trigger.)

Each MCP tool (`graph_summary`, `graph_search`, `graph_neighbors`,
`graph_path`, `graph_query`, `graph_save_result`) takes a `scope` parameter
of `"code"` (default), `"knowledge"`, or `"all"`. Default preserves
backwards-compatible behaviour — every existing call site queries the
code graph as before.

See [Golden rule 7](#golden-rules-for-working-in-this-repo) — this is a
non-negotiable rule, not a nice-to-have. Querying a graph is ~36× cheaper
per question than file reads and catches structural couplings grep would
miss.

### What the graph excludes

[`.graphifyignore`](./.graphifyignore) extends graphify's built-in skip list
with MARVIN-specific noise — `graphify-out/` itself, `.turbo/`, `.next/`,
`.build/`, `.marvin/`, `data/`, `vendor/`, `*.xcodeproj/`, `macos/Vendored/`
(tree-sitter grammars), test outputs (`coverage/`, `playwright-report/`,
`*.snap`), `*.log`, `*.icns`, binary distribution artefacts (`*.zip`,
`*.tar.gz`, `*.dmg`). Test **code** (`*.test.ts`, `*.spec.ts`) stays in
the graph — that's contract-by-example signal worth keeping.

Use the gitignore-syntax `.graphifyignore` at any project's root to scope
graphify the same way — `graphify` honours the file relative to where it
runs. Inline `# comments` after a pattern are NOT supported by graphify's
parser as of v0.4.23; put comments on their own line.

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

In a Claude Code session on MARVIN's own source, rebuild manually (the
ADR-0041 per-turn auto-refresh only runs inside the running IDE on an open
project):

- **Code changes** (`*.ts`, `*.swift`, etc.): `/graphify . --update`
  (AST-only, no LLM cost).
- **Doc changes** (`docs/`, ADRs, README, memory.md): the code graph
  doesn't include these; rebuild the knowledge graph with
  `bin/marvin knowledge-graph .` (AST-only, no LLM cost).
- **`personality.ts` changes** (which influences MARVIN's behaviour but
  is a TS file): `/graphify . --update` picks it up via the code graph.

### God nodes (most-connected abstractions)

After the 2026-06-14 rebuild: `POST()` (116 edges), `GET()` (112),
`.push()` (62), `trim()` (52), `.split()` (49), `.append()` (43) are the
real architectural anchors. Language primitives also bubble to the top —
`string`, `text`, `font`, `View`, `data`, `Kind`, `Equatable`, `Codable` —
those are AST-noise from the tree-sitter pass, not concepts; treat them as
background. The `.graphifyignore` filters files, not node kinds; a follow-up
to filter language primitives from the AST extractor would need to live in
graphify itself.

_Refresh this list with `/graphify . --update` when it drifts._

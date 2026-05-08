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
   "bag of agents" setups (2026 multi-agent coding literature). The two
   sanctioned exceptions are bounded, read-only subagents spawned by the main
   session for a parenthetical task: the **advisor** (second opinion on hard
   decisions — [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md))
   and the **scout** (breadth-first read-only research — [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md)).
   Any new subagent type requires a new ADR; the orchestrator-with-scouts
   shape is a carve-out, not a precedent.
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
| **Graphify first** | Cross-phase rule 6 in `personality.ts`; Golden Rule 7 above | When to consult the graph before reading source files |
| **Advisor triggers** | Cross-phase rule 7 + "Advisor consult — how to run one" section | When to run a Task-based advisor consult (user-directed + 7 deterministic triggers + anti-triggers). See [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md) for why it's a Task subagent, not an SDK tool. |
| **Scout triggers** | "Scout subagents — when to dispatch one" section | When to dispatch a read-only research subagent via `Task { subagent_type: "scout" }` (3+ deterministic triggers + MUST-NOT list). See [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md) for the SDK-level read-only enforcement. |
| **ADR triggers** | Phase 4 "Deterministic ADR triggers" | When a decision requires an ADR (9 categories + anti-triggers + re-derivation test) |
| **Definition of Done** | Phase 5a "State the Definition of Done" + Phase 7 "Match-not-improve" + ADR template `## Scope of Done` | Bound scope before coding; verify against the DoD; end real-work turns with explicit handoff. See Golden Rule 8 above. |

The pattern is the same across all three: a MUST list, a MUST-NOT list,
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
rule 4). The bridge across sessions is a single file: `<workDir>/.marvin/memory.md`,
appended to during the Ship phase and re-read by `buildProjectContext`
on the first turn of every new session. This is the place to record
decisions, invariants, and gotchas that the next session needs to know
without re-deriving them — Anthropic's "memory tool" pattern, file-backed.

The chat surfaces this in two places (ADR-0022):

- **AppStatusBar context indicator** hover tooltip notes
  `memory.md auto-loaded` so the user can see the layer is active.
- **Scope-met chip strip** offers a `Save to memory.md` button below
  the latest message when a real-work turn closes, so the just-completed
  scope can be persisted before clicking `Start fresh next turn (⌘⇧N)`.

`memory.md` is the only sanctioned cross-session persistence. Don't
shadow it with a parallel sidecar cache, a remote KV, or hidden state
in `~/.marvin/` — keeping it in the project directory makes it the
user's thing, not MARVIN's.

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
| Engineering — MARVIN-adopted | `test-driven-development`, `systematic-debugging`, `pr-review`, `security-audit` (ports from Superpowers + gstack; honour `REVIEW.md` at repo root) |
| Operations / PM | `internal-comms` |
| Knowledge graph | `graphify` (install separately — see `~/.claude/skills/graphify/SKILL.md`) |
| Observability | Honeycomb skills ship as a Claude Code plugin — `/plugin install honeycomb` |
| Built-in Claude Code | `/review` (reviews a PR), `/security-review` (security pass on pending changes), `/init` (scaffolds CLAUDE.md) — no install step |

`sidecar/packages/runtime/src/personality.ts` tells MARVIN when to invoke each.
If you add a new skill, also add it to the `CORE_BEHAVIOR` "Skills to
reach for" section so MARVIN knows the trigger conditions.

## Browser automation — plain Playwright via Bash

MARVIN does NOT register a Playwright MCP server. The prior
`@playwright/mcp` integration leaked subprocesses on long sessions
(observed: stdio MCP children holding the parent CLI alive past
`result`, wedging turns for 20+ min) and made every turn pay
subprocess-spawn latency even when no browser work happened.

The replacement is straightforward: when MARVIN needs a browser, it
shells out via `Bash` to `npx playwright` directly. Same capability,
zero per-turn cost, no orphan-process risk.

One-time setup on a fresh machine:

```bash
npx playwright install chromium
```

Common shapes MARVIN reaches for (documented in `personality.ts` ▸
"Browser tools"):

- One-shot screenshot: `npx -y playwright screenshot --browser=chromium <url> /tmp/out.png`
- Scripted check: write `/tmp/check.mjs` using the Playwright Node API,
  run with `node /tmp/check.mjs`
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

A knowledge graph of MARVIN's own code + docs is at `graphify-out/graph.json`
(820 nodes · 988 edges · 167 communities as of 2026-05-04, post the
PLAN.md retirement + DoD discipline pass).

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
- Docs / `personality.ts` changes: `/graphify . --update` (triggers
  semantic re-extraction — minimal cost at this corpus size).

### God nodes (most-connected abstractions)

`GET()` (61 edges), `POST()` (58), `trim()` (29), `ADR-0015 — Auto-mode
policy floor + audit log` (17), `/api/git/* third mutation channel` (17),
`ADR index` (15), `8-phase senior-engineer workflow` (15), `Changelog
(docs/history/CHANGELOG.md)` (15), `projects.ts` (13), `resolve()` (13).

_Refresh this list with `/graphify . --update` when it drifts._

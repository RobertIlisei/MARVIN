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
   "bag of agents" setups (2026 multi-agent coding literature). The
   sanctioned exceptions are bounded, **read-only** subagents spawned by the
   main session for a parenthetical task: the **advisor** (second opinion on
   hard decisions — [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md)),
   the **scout** (breadth-first read-only research — [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md)),
   **dynamic workflows** (read-only audit / research / discovery fan-out
   at `effort: xhigh`, opt-in — [ADR-0030](./docs/decisions/0030-dynamic-workflows-read-only-fan-out.md)),
   and **plugin-shipped agents** (opt-in per project, dispatch confirm-gated,
   analyse-and-report only — [ADR-0054](./docs/decisions/0054-plugin-agents-read-only-hooks-stay-stripped.md)).
   All of them share one enforced invariant: **a subagent cannot mutate the
   workspace** — the permission gate hard-denies Write/Edit/NotebookEdit and
   unsafe Bash from any call that carries an SDK `agentID`. Parallel
   *implementation* remains forbidden; that's the failure this rule exists to
   prevent.
   **What this rule does NOT forbid ([ADR-0077](./docs/decisions/0077-ai-native-sdlc-selective-adoption.md)):**
   the banned shape is *model dispatching model* on shared state — a flat
   swarm with no human between the agents. It is not "more than one session
   exists". A human running several MARVIN sessions in parallel, each on its
   own project or worktree and each steered by them, is N independent
   single-assistant loops — this topology multiplied, not violated. The one
   constraint is that two sessions must not point at the same working tree. Any new subagent type requires a new ADR; these carve-outs are
   not a precedent for general multi-agent dispatch.
   **A standing supervisor agent was considered and rejected** (2026-07-24) —
   that's ADR-0001's camp 2, the shape this project was rebuilt to escape, and
   a supervisor spawned/briefed by the executor it supervises is theater. What
   exists instead: the *mechanical* supervisor (gate + ADR-0055/0057 guards)
   and the **session auditor** ([ADR-0059](./docs/decisions/0059-session-auditor-runtime-dispatched-read-only.md))
   — runtime-dispatched (never executor-spawned), read-only, zero enforcement
   authority, reports to the **user**. No model ever commands another model.
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
   **Gate on the SCOPE boundary, not the turn boundary
   ([ADR-0067](./docs/decisions/0067-gate-on-scope-not-turn-boundaries.md)).**
   An approved plan is standing authorization for every step in it: while
   steps remain and the last one passed its checks, CONTINUE in the same
   turn — don't stop, don't emit the scope-met block, and don't ask
   permission the plan already granted. Stop at the plan's end, when the
   next action would leave the plan, on a judgement gap, or on a real
   trade-off. Measured on a real 2-day session: 33.1 h of 49 h was spent
   waiting on the user and **only ~10 % of that wait was legitimate** —
   17.8 h was MARVIN ending turns mid-plan having asked nothing. This
   doesn't weaken the rule, it aims it: the rule exists to stop you
   wandering OUT of scope, never to stop you finishing what was approved.
   Re-measure with `scripts/session-time-breakdown.py --latest <projectId>`.

### The firm surfaces

MARVIN's prompt (`sidecar/packages/runtime/src/personality.ts`) codifies several
enumerated trigger / contract lists that replace soft "use judgement"
language with deterministic MUST / MUST-NOT categories. When the prompt
and a human doc disagree, the prompt wins — it's what MARVIN actually
reads at turn time.

| Rule | Location | Purpose |
|---|---|---|
| **Graphify first** | Cross-phase rule 6 in `personality.ts`; Golden Rule 7 above; "Per-tool MUST triggers" section in `personality.ts` | When to consult the graph before reading source files. The 2026-05-27 audit found ~7:1 file-ops to graph-ops drift and that `graph_search` was overused as a glorified grep while `graph_summary` / `graph_query` / `graph_save_result` were near-zero. Each of the 6 graph_* MCP tools now has its own enumerated MUST trigger + MUST-NOT bypass list; AppStatusBar surfaces the live ratio. |
| **Simplicity + surgical edits** | "Simplicity first — and surgical edits" section in `personality.ts` | What MARVIN MUST NOT ship (features beyond the ask, single-call-site abstractions, unrequested configurability, handling for impossible states) and how it MUST edit (no drive-by improvements to adjacent code, match the file's existing style, delete only the orphans its own change created). Adapted from the Karpathy coding guidelines (`multica-ai/andrej-karpathy-skills`, MIT); its other two principles were rejected — "ask when unclear" contradicts ADR-0067's measured anti-stall rules, and "goal-driven execution" is already Phase 5a's Definition of Done. Before this, the only coverage of overcomplication was one soft line ("Don't over-engineer") — the shape the 2026-05-22 audit found fires ~0×. |
| **Advisor triggers** | Cross-phase rule 7 + "Advisor protocol — registered subagent on the Task tool" section | When to run a Task-based advisor consult (user-directed + 7 deterministic triggers + anti-triggers). See [ADR-0007](./docs/decisions/0007-advisor-as-subagent-pattern.md) for why it's a Task subagent, not an SDK tool. |
| **Scout triggers** | "Scout protocol — read-only parallel research" section | When to dispatch a read-only research subagent via `Task { subagent_type: "scout" }` (3 deterministic triggers + MUST-NOT list). See [ADR-0014](./docs/decisions/0014-scout-subagents-read-only.md) for the SDK-level read-only enforcement. |
| **Dynamic workflows** | "Dynamic workflows — read-only fan-out only" section in `personality.ts` | When `effort: xhigh` may fan out parallel subagents — read-only audit / research / discovery ONLY, opt-in, never parallel implementation. Enforced by the subagent read-only invariant in `classifyToolCall` (any `agentID` call that mutates is hard-denied). See [ADR-0030](./docs/decisions/0030-dynamic-workflows-read-only-fan-out.md). |
| **ADR triggers** | Phase 4 "Deterministic ADR triggers" | When a decision requires an ADR (9 categories + anti-triggers + re-derivation test) |
| **Definition of Done** | Phase 5a "State the Definition of Done" + Phase 7 "Match-not-improve" + ADR template `## Scope of Done` | Bound scope before coding; verify against the DoD; end real-work turns with explicit handoff. See Golden Rule 8 above. |
| **Negative claims** | `"I could not find it" is NOT "it does not exist"` section in `personality.ts`; [ADR-0068](./docs/decisions/0068-plan-dedupe-provenance-and-negative-claims.md) | What MARVIN must establish before saying something doesn't exist, was never done, or was fabricated. On 2026-08-17 it scanned 303 plan files, missed the active plan, and reported that genuine merged work was "fabricated" — the user was one step from discarding it. MUST resolve by identity (the active-plan block now names `id` + `source:` path), search ≥2 ways, and state where it looked; MUST-NOT call the user's project history fabricated without positively establishing the negative. |
| **Scope-boundary gating** | Phase 7 "Gate on the SCOPE boundary, not the turn boundary" + the "would any answer change what I do next?" test in the question-asking rules; [ADR-0067](./docs/decisions/0067-gate-on-scope-not-turn-boundaries.md) | When to CONTINUE inside an approved plan vs STOP and hand off, and which questions are stalls rather than questions. The 2026-08-17 transcript analysis found 33.1 h of a 49 h session spent waiting on the user, ~90 % of it avoidable — 65 turns ended mid-plan with no question asked, 20 asked permission the plan had already granted, and the user typed a "resume the ACTIVE plan" macro 8× to restart a stalled system. Transport errors now auto-continue via the ADR-0031 wakeup rails instead of leaving the session dead (5.1 h across 4 incidents). |
| **Skill triggers** | "Skill triggers — deterministic invocation" section | When to invoke `test-driven-development`, `systematic-debugging`, `pr-review`, `security-audit`, `frontend-design` via the `Skill` tool (per-skill MUST + MUST-NOT). The 2026-05-22 audit found 5 of 6 skills had soft-nudge language and fired ~0× across thousands of qualifying contexts; this section converts each to a deterministic trigger with NO bypass. |
| **Project memory** | "Project memory — what goes in it" section in `personality.ts`; [ADR-0042](./docs/decisions/0042-memory-as-durable-facts.md) | What may be written to `.marvin/memory.md` and how. Durable facts only (invariants / gotchas / constraints / external facts), via the `remember` MCP tool — MUST-NOT Edit/Write memory.md directly or log activity/decisions/status. The 2026-06-14 audit found a project's memory.md at 419 KB / ~99 % redundant with ADRs/git/changelog; the tool enforces brevity + content-class at the write boundary where prose guidance failed. Since 2026-07-02 the gate also hard-denies direct model writes to `.marvin/memory.md` / `.marvin/memory/` (ADR-0042 enforcement addendum — same mechanism as the `.marvin/plans/` deny). |
| **Project backlog** | "Project backlog — what goes in it" section in `personality.ts`; [ADR-0044](./docs/decisions/0044-project-backlog.md) | What may be parked to `.marvin/backlog/` and how. Actionable deferred work only ("noticed in flight, not in scope" follow-ups / out-of-scope improvements / blockers), via the `backlog_add` MCP tool — MUST-NOT park facts (→`remember`), status (→git), or decisions (→ADR). **Anti-Kanban (Golden Rule 1):** a parking lot read by MARVIN + the user — no subagent pull, never auto-executed, never overrides plan-first. Capture is un-gated at discovery (`provisional: true`, ADR-0047); consent moves to the keep/dismiss review at the scope-met handoff; open items surface in the next session's context. |

The pattern is the same across all of them: a MUST list, a MUST-NOT list,
and a fallback judgement test for cases the lists don't cover.

## Repo layout

```
macos/                       # SwiftUI macOS app (Xcode / SPM)
  MARVIN/                    # Swift sources
  project.yml                # xcodegen manifest
  Package.swift              # SPM manifest (swift build fallback)
sidecar/                     # Next.js 16 sidecar, port 3030 — API-ONLY
  src/                       # Next.js app (app/api/** route handlers only;
                             #   the browser UI was removed, ADR-0075 — the
                             #   native macOS app is the only client)
  packages/
    runtime/                 # Claude CLI wrapper + auth + session + personality
    tools/                   # Tool policy — auto / confirm / deny
    project-context/         # spec + infra-probes injection
    graphify-bridge/         # knowledge-graph read + refresh
    git-watch/               # commit stream
    ui/                      # shadcn primitives — orphaned since ADR-0075,
                             #   pending removal (nothing left imports it)
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
| `sidecar/` | Next.js 16 API-only backend for the native macOS app ([ADR-0075](./docs/decisions/0075-sidecar-drops-browser-ui.md)) — no browser UI. |
| `sidecar/packages/runtime/` | Claude Agent SDK (**0.3.245**, [ADR-0073](./docs/decisions/0073-agent-sdk-0-3-upgrade.md)) runner, auth, session persistence, cost tracker, project registry, personality. Confirm gate lives here (`sdk-runner.ts → canUseTool`). |
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
- **Project backlog (ADR-0044)** is the *adjacent* cross-session layer:
  `.marvin/backlog/<slug>.md` + a `.marvin/backlog.md` index of open
  *actionable deferred work* — the "noticed in flight, not in scope" follow-ups
  that would otherwise evaporate. Distinct content class from memory: memory
  holds **facts**, the backlog holds **work**. Write path is the `backlog_add`
  MCP tool (`marvin-backlog`, `backlog-mcp.ts`) — capture is un-gated at
  discovery (`provisional: true`, ADR-0047), consent lands at the keep/dismiss
  review at the scope-met handoff; caps + rejects fact/status/decision
  payloads; `backlog_list` /
  `backlog_resolve` read and close; open items are re-injected by
  `buildProjectContext`. A **parking lot**, never a queue agents pull from
  (Golden Rule 1) — surfaced in the macOS backlog panel + a tray chip.

`.marvin/memory.md` + `.marvin/memory/` is the only sanctioned cross-session
durable-facts persistence. Don't shadow it with a parallel sidecar cache, a
remote KV, or hidden state in `~/.marvin/` — keeping it in the project
directory makes it the user's thing, not MARVIN's.

## Data directory

`MARVIN_DATA_DIR` env var, default `~/.marvin/`. Stores:
- `sessions/<projectId>/<sessionId>.jsonl` — conversation transcripts
- `sessions/<projectId>/.summaries.json` — picker cache for the session list
  ([ADR-0072](./docs/decisions/0072-session-list-must-not-parse-transcripts.md)):
  per-session `firstUserMessage` + `turnCount`, keyed on `(mtime, size)`.
  Listing 347 sessions used to `JSON.parse` 2.6 GB per request (23 s — long
  enough for the client to cancel and restart it forever, which read as "all
  my sessions are gone"). Now a marker scan + this cache: 36 ms warm. Safe to
  delete; it rebuilds on the next list.
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

> **`install-skills.sh` never updates.** It *skips* anything already present, so
> a skill installed once stays at that version forever. Pulling a newer version
> is the Skills pane's job ([ADR-0071](./docs/decisions/0071-install-provenance-and-update-path.md)) —
> and it needs a recorded source, which skills installed by this script don't
> have. Use "Set source" on the row once to bind the upstream URL.


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
If you add a new skill, also add it to the "Skill triggers — deterministic
invocation" section (or its "Other skills available by name" list) so
MARVIN knows the trigger conditions.

## Claude Code plugins — opt-in per project (ADR-0053)

MARVIN runs the Agent SDK in **isolation mode** (no `settingSources`), so
plugins installed through the Claude Code `/plugin` UI don't load automatically —
their *enablement* lives in the settings family MARVIN deliberately doesn't read.
[ADR-0053](./docs/decisions/0053-plugins-as-local-plugin-loader.md) bridges that
without the `settingSources` blast radius:

- **Discovery** is from `~/.claude/plugins/` — the same registry the Claude Code
  UI writes — so a plugin installed there is immediately *available* to MARVIN.
- **Activation is opt-in, per project.** A plugin loads into a turn only when
  listed in `<workDir>/.marvin/plugins.json` (`{ "enabled": ["honeycomb", …] }`,
  mirroring `skills.json`). Empty/absent → nothing loads. Managed from the macOS
  **Plugins pane** (`PluginsPane.swift`, a `LeftPane` tab) over the `/api/plugins`
  route (`plugin-loader.ts`: `listInstalledPlugins` / `setEnabledPlugins`).
- **Install from inside MARVIN** (Phase 3): the Plugins pane "Install" sheet →
  `/api/plugins/install` → `plugin-installer.ts` clones a marketplace/plugin repo,
  copies the plugin into `~/.claude/plugins/cache/…`, and registers it in
  `installed_plugins.json` (same registry the Claude Code UI uses — installs are
  bidirectionally visible). Clone+copy only; nothing runs at install.
- **Update an installed plugin** ([ADR-0071](./docs/decisions/0071-install-provenance-and-update-path.md)):
  every install now records where it came from, so "pull the latest" works.
  Provenance lives in `~/.marvin/plugin-sources.json` — deliberately NOT a new
  key in the co-owned `installed_plugins.json`. `POST /api/plugins/update`
  (`checkOnly` / single / `all`); the pane gets Check-for-updates + per-row
  Update. Superseded cache versions are pruned. Plugins installed through the
  Claude Code `/plugin` UI have no MARVIN provenance and are skipped — not ours
  to update. **Skills work the same way** (`POST /api/skills/update`), with
  provenance in `.marvin-source.json` inside each skill folder; a skill with no
  record gets a one-time "Set source" in the Skills pane.
- **Loaded via the SDK `plugins:[{type:'local',path}]` array** (a sanitised
  staged copy under `.marvin/plugins-stage/`). Loads **skills + slash
  commands + MCP servers + agents** — plugin agents run **read-only**
  ([ADR-0054](./docs/decisions/0054-plugin-agents-read-only-hooks-stay-stripped.md)):
  dispatch confirm-gates (unknown `subagent_type`) and the ADR-0030 `agentID`
  invariant hard-denies mutations, so they analyse/report while the main loop
  applies changes. Plugin **hooks** are never loaded (no read-only containment
  exists for "interpose on every tool call" — ADR-0054 §2).
- **Gate change:** `mcpToolPolicy` (`@marvin/tools/policy`) now allowlists
  MARVIN's own in-process servers and routes **every other `mcp__*` tool through
  `confirm`** — closing the prior blanket-allow of unknown MCP tools. Plugin MCP
  tools are therefore confirm-gated, and the subagent read-only invariant applies.

## Agent SDK contract — two pins that keep the plan spine alive (ADR-0073)

MARVIN is on Agent SDK **0.3.245**. Two 0.3 defaults would silently change
what MARVIN does, and both are pinned back in `sdk-runner.ts` with the reason
at the pin ([ADR-0073](./docs/decisions/0073-agent-sdk-0-3-upgrade.md)):

- **`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` + `CLAUDE_CODE_ENABLE_TASKS=0`** in
  `turnEnv`. From 0.3.142, Sonnet 5 / Opus 4.8+ sessions get **no**
  task-tracking tool unless opted in, and the opt-in family defaults to the
  id-based `TaskCreate`/`TaskUpdate`. The entire plan spine (ADR-0046 / 0049 /
  0052 / 0068) reconciles `TodoWrite` snapshots by `[N]`/`[N.M]` tag. Remove
  either flag and every plan freezes at `pending` with no error.
- **`alwaysLoad: true` on all five in-process MCP servers** (`marvin-graph`,
  `-memory`, `-backlog`, `-obsidian`, `-control`). 0.3 defers MCP tools behind
  `ToolSearch` by default; the graphify-first design hooks hard-deny
  Read/Grep/Glob until a `graph_*` call has happened, so a turn-1 prompt with
  no graph tools would deadlock. `alwaysLoad` also blocks startup until the
  server is connected, which closes the 0.2.142 background-connect race.

Verified live, not inferred: a 0.3.245 `system/init` on `claude-sonnet-5`
with the flags reports the subagent tool as **`Task`** (what the gate matches
on) and the todo family as **`TodoWrite`** only. Migrating the spine to Task
ids — which is what retires the ADR-0068 bug class — is a separate, non-neutral
ADR, deliberately not bundled with the upgrade.

## Browser automation — Playwright CLI (default) + opt-in MCP (ADR-0045)

Two paths. **Default:** the Playwright **CLI** via `Bash` — one-shot captures and
full `playwright test` suites (below). **Opt-in:** the Playwright **MCP** server
([ADR-0045](./docs/decisions/0045-playwright-mcp-gated.md)) — first-class,
stateful `mcp__playwright__browser_*` tools for interactive navigate→snapshot→
click→assert flows. It's **off by default** (a browser subprocess per turn is
heavy); toggle it in the header Setup popover (web) / Settings ▸ Browser (macOS).
It's **gated** — observation auto-runs, interaction/navigation confirm in gated
mode, and `browser_run_code_unsafe` is **denied**; the subagent read-only
invariant gives scouts only the observational tools.

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
  files. 6905 nodes · 13419 edges · 393 named communities (2026-08-24
  rebuild on graphify 0.9.48 — CLI now 0.9.51, 2026-08-29; honours [`.graphifyignore`](./.graphifyignore)). For a *full*
  rebuild use `graphify . --code-only` — without `--code-only` the run
  aborts on the docs, which need an LLM backend and belong to the knowledge
  graph anyway. (`graphify update .` is the incremental path and needs no
  such flag.)
- **Knowledge graph** at `graphify-out/knowledge/graph.json` — heading
  structure + cross-doc links from `docs/`, ADRs, `README.md`, `CLAUDE.md`,
  `.marvin/memory.md`. 1484 nodes · 1818 edges · 128 named communities
  (built 2026-08-24).

**Community names.** Both graphs were 100 % `Community N` placeholders until
2026-08-15, which made `graph_summary`'s community section unreadable. They
are now named via `graphify label . --backend=claude-cli` — the `claude-cli`
backend drives the OAuth'd Claude CLI, so this needs **no API key** (this
machine has none).

> **Labels are not durable across a structural rebuild.** When the community
> set shifts, graphify does *not* keep the saved LLM labels — it silently
> renames every community after its hub node, so "Git Write Policy Gate"
> becomes `git/src/index.ts`. Observed 2026-08-15 when a `graphify update .`
> moved the code graph 318 → 392 communities. The fallback is still readable,
> but it is filenames, not concepts. **Re-run `graphify label` after any
> rebuild that changes the community count.** Do NOT wire this into the
> per-turn watchdog — it is an LLM pass, and the watchdog runs on every turn.

> **Gotcha:** `graphify label` has no `--graph` flag, and `cluster-only
> --graph <path>` *reads* that path but *writes* the default one — pointing it
> at the knowledge graph very nearly overwrote the code graph with it (the
> node-count guard refused, 2026-08-15). To label the knowledge graph, stage a
> copy as `graphify-out/graph.json` in a scratch directory, run `label` there,
> and copy the result back.

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
code graph as before. Two further tools landed with
[ADR-0066](./docs/decisions/0066-graphify-directed-call-index-and-work-memory.md):

- **`graph_affected({symbol, depth?})`** — the blast-radius tool: who *calls*
  this symbol, with exact file and line. Use it before modifying, renaming or
  deleting anything. **`graph_neighbors` is not a blast-radius tool** — the
  built graph is undirected (`directed: false`), so its `→`/`←` arrows are
  networkx adjacency-iteration order, not call direction. `graph_affected`
  reads the AST call cache (`graphify-out/cache/*.json`, `raw_calls`) instead,
  which is genuinely directed. Code scope only.
- **`graph_reflect({scope?})`** — aggregates the outcomes recorded by
  `graph_save_result` into `graphify-out/reflections/LESSONS.md`.
  Deterministic, no LLM.
- **`graph_change_impact({files?, base?, limit?})`** — blast radius of a
  whole branch / diff (2026-08-29): symbols and communities the changed files
  define, god nodes among them, and every caller *outside* the branch with
  file and line. No args = current branch vs its base, working tree and
  untracked included. Forge-agnostic by construction — graphify's own PR tools
  (`get_pr_impact` / `triage_prs`) shell out to `gh` and are GitHub-only, and
  the project MARVIN works on is on GitLab. Aggregate counterpart of
  `graph_affected`; wired into the `pr-review` skill and the Phase 3 MUST list.
- **`graph_community({community, limit?, scope?})`** — members of one
  community by id or labelled name, the one lookup `graph_summary` names but
  couldn't open. `graph_query` also gained `context: [...]` (the CLI's
  `--context` edge filter) for questions drowning in `references` noise.

`graph_save_result` now takes **`outcome: useful | dead_end | corrected`**
(plus `correction`). Send it every time: without an outcome the save is a
cache entry and `graph_reflect` has nothing to learn from. A wrong graph
answer recorded as `corrected` is the highest-value signal there is.

See [Golden rule 7](#golden-rules-for-working-in-this-repo) — this is a
non-negotiable rule, not a nice-to-have. **Measured 2026-08-15 with
`graphify benchmark`: 27.5× fewer tokens per query** than naive full-corpus
reads (268,066 naive tokens → ~9,763 per query), and the graph catches
structural couplings grep would miss. (The previously-quoted "~36×" was never
measured on this repo; re-run `graphify benchmark graphify-out/graph.json`
when the number drifts.)

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
runs. Inline `# comments` after a pattern **are** supported as of 0.9.48
(`_parse_gitignore_line` follows the gitignore spec: `#` must be preceded by
whitespace, so `path#with#hash.py` survives). They were NOT supported on
v0.4.23, which is why existing entries keep comments on their own line —
that still works and needs no migration.

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

After the 2026-08-24 rebuild: `cn()` (97 edges), `requireMarvinClient()`
(96), `checkFsPath()` (76), `ChatPreviewModel` (73), `ChatPreviewView` (55),
`validateProjectCwd()` (47), `SkillsPane` (46), `BacklogPanel` (46) are the
real architectural anchors — the shared client guard, the fs-path check and
the project-cwd validator are the widest coupling points in the repo.
(An incremental `update` can transiently drop a hot node out of the top 10:
re-extracting only some of its source files prunes its cross-file edges, so
prefer a full rebuild when counts look off.) This list moves a lot — it
changed twice in one afternoon across two rebuilds — so **read it with
`graphify god-nodes --top 8` rather than trusting the transcription here**,
which had drifted badly by the time ADR-0066 checked it.
Language primitives also bubble to the top —
`string`, `text`, `font`, `View`, `data`, `image`, `Kind`, `Codable` —
those are AST-noise from the tree-sitter pass, not concepts; treat them as
background. The `.graphifyignore` filters files, not node kinds; a follow-up
to filter language primitives from the AST extractor would need to live in
graphify itself.

_Refresh this list with `/graphify . --update` when it drifts._

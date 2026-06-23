# Roadmap

What's in flight, what's deferred, and what MARVIN deliberately won't do. The chronological record of what shipped, when, and why lives in [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). Material decisions live in [`docs/decisions/`](./decisions/).

## In flight

_Active work. Add a one-line entry when a piece of work starts; move it out (to CHANGELOG, with the date) when it lands._



- **Multi-graph architecture — code + knowledge** ([ADR-0028](./decisions/0028-multi-graph-architecture.md), development branch only). Two graphs per project: `graphify-out/graph.json` (code, auto-rebuild on commit, unchanged) and `graphify-out/knowledge/graph.json` (docs / ADRs / memory, manual rebuild via `bin/marvin knowledge-graph`, AST-only, no LLM cost). All six MCP graph tools accept a new `scope: "code" | "knowledge" | "all"` parameter, default `"code"` for backwards compatibility. Stable v0.1.13 cask + main branch unchanged — rollback is `git checkout main` or `brew install --cask marvin-ai`. Cross-graph joins, tool-history graph, semantic doc extraction deferred per the ADR.
- **macOS 26 Gatekeeper fix — install to `~/Applications`** ([ADR-0027](./decisions/0027-macos-26-gatekeeper-user-applications.md)). macOS 26 (Tahoe) kernel-kills ad-hoc-signed bundles in `/Applications` regardless of signature state; the same `.app` runs cleanly from `~/Applications`. `bin/marvin install-macos-app` and the Homebrew cask both retarget to `~/Applications/MARVIN.app`; uninstall cleans up the legacy `/Applications` path. New users still hit the user-space Privacy & Security popup on first Finder launch (one-time whitelist via "Open Anyway"). README + cask `caveats` document the click-through.
- **Syntax-highlighter coverage — YAML.** Add `tree-sitter-yaml` SPM dep + `Resources/Queries/yaml.scm`. Trivial; every project has compose / workflow / kubeconfig files. ~15 min.
- **Syntax-highlighter coverage — Markdown.** Vendor `tree-sitter-markdown` to bypass the upstream `tree-sitter/swift-tree-sitter` binding-conflict documented in `macos/Package.swift`. Half of all docs are `.md`. ~30 min.
- **Syntax-highlighter coverage — Python.** Vendor `tree-sitter-python` with a patched `Package.swift` (the upstream runtime `FileManager.fileExists("src/scanner.c")` check is the documented blocker). Most-asked-for missing language. ~1 hr.
- **Terminal pane — ANSI colour passthrough.** Replace the current `stripANSI(_:)` with a small CSI-colour parser that maps the 16 standard + 8 bright ANSI colours to `NSAttributedString` foreground attributes. `cargo`, `pnpm`, `pytest`, `make`, `gradle` output becomes legible. Contained to `macos/MARVIN/TerminalPaneView.swift`. ~half day.

_When a work item lands, move its line out of this section into a dated `## Recent milestones` entry (with the cask + tag + ADR if any)._

## Current version

**v0.1.44** — Plan-step join key + subtask roll-up
([ADR-0049](./decisions/0049-plan-step-join-key-and-rollup.md), revising
[ADR-0046](./decisions/0046-plan-as-durable-spine.md)). Plan tracking linked
tasks to the plan's action items by *fuzzy text match* — so a `TodoWrite` item
the model reworded at execution time failed to match its step, landing as an
orphan sub-task, and the plan never advanced because a step only moved when its
exact text matched. v0.1.44 replaces that with a **stable join key**: the
executor tags each `TodoWrite` item `[N]` (plan step N) or `[N.M]` (sub-task M
of step N), so a reworded task still links to the right step. Adds **upward
roll-up** — a step auto-completes when all its `[N.M]` sub-tasks complete
(in_progress while partial) — directly fixing "tasks don't link to the plan" and
"the plan never updates". Fuzzy matching is kept as the untagged backstop, so a
turn that ignores the contract degrades to v0.1.41 behaviour rather than
regressing. `personality.ts` + the `approvePlan()` execute instruction teach the
tagging contract + roll-up rule. `swift build` clean; `personality.ts` `tsc`
clean; an 11-assertion standalone logic test covers tag-linking, nesting, full +
partial roll-up, key-based de-dup, and fuzzy fallback. Builds on v0.1.43.

**v0.1.43** — Full session history via incremental paging
([ADR-0048](./decisions/0048-full-session-history-tail-first.md)). Cold-start
restore loaded only the last 200 `cli.event` lines (`hydrate(tail:200)` + the
server's `turns.slice(-tail)`), so a restored session showed truncated history
with no signal it was clipped — only auto-restore was affected (manual
history-pick already loaded full). The server now returns `truncated` +
`totalTurns`; the client paints the last 200 lines instantly, then a
top-of-list control loads the **next 200** (`loadNextHistoryPage`) or jumps to
the **full log** (`loadFullHistory`) on demand, with a live "N of M lines"
count. Loads decode off-main and replay into the lazy `LazyVStack`, are guarded
(same session, not mid-send), and reset on session switch. Fast first paint +
user-controlled completeness, never auto-paying the 120 MB worst case.
`swift build` + sidecar `tsc` clean. Builds on v0.1.42.

**v0.1.42** — Plan persistence + review-window fixes + backlog capture-at-discovery.
Three changes shipped together. **(1) Plan persists across chat switches**
([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up): the plan
strip was in-memory/session-scoped, so switching chats or relaunching lost it;
`replay` now reconstructs the plan + checklist from the transcript on session
load (last `# Plan` reply + latest `TodoWrite` for step progress), and a later
`TodoWrite` reconciles into the restored plan instead of orphaning as a tier-1
task list. **(2) Review window** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md)
bugfix): a newly-written file (one all-added hunk) rendered a half-empty
side-by-side and hung the window — added/deleted files now render single-column
with a banner, the diff flattens to a virtualised row-level `LazyVStack`, and a
>1500-line diff is gated behind "Show anyway" (mirrors GitHub/VS Code). **(3)
Backlog capture-at-discovery** ([ADR-0047](./decisions/0047-backlog-capture-at-discovery.md),
revises [ADR-0044](./decisions/0044-project-backlog.md)): a new `provisional`
status + `backlog_add … provisional:true` auto-park a "noticed in flight" item
the instant it's seen (no go-ahead), with a keep/dismiss review at the handoff,
so discoveries survive a turn that never reaches the handoff. `swift build` +
runtime `tsc`/tests clean. Builds on v0.1.41.

**v0.1.41** — Plan as the durable spine ([ADR-0046](./decisions/0046-plan-as-durable-spine.md),
revising [ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Fixes two
plan-tracking bugs: a `TodoWrite` emitted mid-plan wholesale-replaced the
checklist (sub-tasks erased the plan's steps + fired a false "Plan complete"),
and a second plan overwrote the single plan slot (the original became
untrackable). The active plan now owns hierarchical `PlanStep`s; incoming
`TodoWrite`s **reconcile** into them via `PlanProgress` (matched step → status
update, unmatched item → nested sub-task) instead of replacing the list;
completion is computed over top-level steps only; plans live in a revision-aware
session list (`plans` + `activePlanId`) with a `TodoListStrip` picker so prior
plans stay navigable. `personality.ts` + the approve-to-execute instruction now
require a full carry-forward `TodoWrite`. `swift build` + runtime `tsc` clean.
Builds on v0.1.40.

**v0.1.40** — Fix: AskUserQuestion's "Send choice" silently doing nothing. The
interactive decision sheet (ADR-0040) registered its confirm with the default
**5-minute** auto-deny timeout — the same one used for permission confirms. A
human weighing detailed options for >5 min was silently auto-DENIED (the turn
proceeded ignoring the choice; the registry entry was deleted), so a later
"Send choice" click hit a dead confirm (404) and did nothing. AskUserQuestion is
the model explicitly blocking on a human decision, so it now registers with NO
auto-deny timer (`timeoutMs: 0`) — it waits for the human; the turn's `finally`
(`clearTurnConfirms`) + Stop unwind an abandoned one. Regression test in
`confirm-registry-timeout.test.ts`. Builds on v0.1.39.

**v0.1.39** — Playwright MCP, opt-in + gated ([ADR-0045](./decisions/0045-playwright-mcp-gated.md)).
MARVIN's first EXTERNAL (stdio) MCP server (`npx @playwright/mcp@latest`), **off
by default**. The gate previously blanket-allowed every MCP tool — safe for the
in-process graph/memory/backlog servers, unsafe for Playwright's code-exec/egress
tools. `policy.ts mcpToolPolicy` now classifies the `playwright` tools
(observation auto · interaction/navigation confirm · `browser_run_code_unsafe`
deny) and `classifyToolCall` consults it before the blanket-allow, reusing the
ADR-0030 subagent collapse so scouts get only observational tools. The
`playwrightEnabled` toggle is threaded end-to-end (web Setup popover + macOS
Settings ▸ Browser). Builds on v0.1.38.

**v0.1.38** — Project backlog ([ADR-0044](./decisions/0044-project-backlog.md)). A
durable, per-project parking lot for *actionable* "noticed in flight, not in
scope" follow-ups that previously evaporated with the chat (Golden Rule 4).
Shared `backlog.ts` store (file-per-item + index, mirrors memory ADR-0042) ←
`marvin-backlog` MCP tool (`backlog_add`/`list`/`resolve`, content-class
enforced) + `GET/POST/PATCH /api/backlog`. Consent-gated capture at the
scope-met handoff; open items re-injected by `buildProjectContext`; macOS
`BacklogPanel` + tray chip with Done / Dismiss / Promote-to-plan / optional
GitHub-issue export. A parking lot, never a Kanban queue (Golden Rule 1). Builds
on v0.1.37.

**v0.1.37** — Server-initiated turns reach an idle client ([ADR-0043](./decisions/0043-server-turn-announcements.md)).
ADR-0038's background-job completion (and ADR-0031 wakeups) fire a real turn
server-side, but the idle macOS app only attached to a turn's stream on session
*hydrate* (`attachLive` had one caller) — so a job-completion / wakeup turn ran
into the bus with no listener and was invisible until the next session switch.
A new per-project always-on SSE (`GET /api/chat/announce`) forwards a
`turn.registered` emitted from `registerLiveTurn`; the idle client, when it has
no live stream of its own, calls the existing `attachLive` and the turn renders.
Plus a "background job running" chip so in-flight ≠ done. Completes the ADR-0038
loop on the client axis. 3 new announcer tests (26 runtime green); `swift build`
clean. Builds on v0.1.36.

**v0.1.36** — A fired wakeup no longer evicts a live interactive turn. The
v0.1.33 one-live-turn 409 guard only covered `POST /api/chat`; the wakeup
dispatch path bypassed it, so a scheduled/event-driven wakeup firing during an
interactive turn evicted it ("replaced by a newer turn on the same session",
aborting the user's work). `wakeup-scheduler` now yields — defers + re-arms —
while a turn is live (`deferIfSessionBusy` in `fire`/`fireNow`). Builds on v0.1.35.

**v0.1.35** — Context-usage panel. The status-bar `ctx` chip is now a
click-to-open popover (`ContextDetailPopover`): exact resident/window % from
live SDK usage with window-relative colour bands (a 1M `[1m]` model no longer
reads "critical" at 140K), plus an estimated per-category breakdown (system
prompt · tools+MCP · project-context sub-sections · derived transcript · free).
New `GET /api/context`; `buildProjectContext` now returns `{ text, breakdown }`.
Builds on v0.1.34.

**v0.1.34** — "Stop" is authoritative. `cancelLiveTurn` now force-ends the turn
(abort + synchronous `endLiveTurn`) so a wedged agent can't lock the session
behind the 409 guard with no in-app recovery. Builds on v0.1.33.

**v0.1.33** — One live turn per session. `POST /api/chat` now returns
`409 turn-in-progress` instead of silently evicting a running turn, and turn
eviction `abort()`s the displaced agent rather than just disconnecting it —
fixing the "replaced by a newer turn on the same session" stream error that
froze heavy multi-step turns mid-plan and left an orphaned agent still mutating
the workspace. Regression test in `turn-registry.test.ts`. Builds on v0.1.32.

**v0.1.32** — memory.md becomes a curated durable-facts layer (ADR-0042). A
real project's `.marvin/memory.md` had bloated to 419 KB / ~99% redundant with
ADRs/git/changelog. Now a `marvin-memory` MCP tool (`remember`/`recall`) is the
enforced write path — one fact → `.marvin/memory/<slug>.md` + a one-line index,
with caps + content-class guards that reject activity/status. `personality.ts`
firm surface routes facts through `remember`; a `/memory-compact` command
distills existing logs. The native Scope-met chip is retargeted to
`session-notes.md` so it no longer pollutes the index. Builds on v0.1.31.

**v0.1.31** — Fixes "Prompt is too long" on the first message of a mature
project. Two layers (ADR-0041): MARVIN now **builds/maintains the active
project's graphs** (code + knowledge, AST-only/free, cwd-scoped — never its own
repo), and the **first-message context is budgeted** — ADRs inject as a titles
index (details via the knowledge graph + targeted reads), memory.md as a recent
tail, curated docs stay whole. agri-saas-platform's first-message context drops
from ~566K to ~13.4K tokens. Builds on v0.1.30.

**v0.1.30** — Interactive AskUserQuestion: when the model hits a real
decision it can call `AskUserQuestion` and MARVIN renders the options as
clickable buttons (single/multi-select + "Other"), returning your pick to the
model as the tool result — instead of prose "(a)/(b)" you could only answer by
typing. Routed through the existing confirm channel in every mode (ADR-0040);
a fallback chip still handles prose questions. Also bumped CI actions to their
Node-24 majors ahead of GitHub's June 16 cutoff. Builds on v0.1.29.

**v0.1.29** — No "Approve & execute" chip on an already-complete plan: a
finished plan showed both "Plan complete 10/10" and the approve chip. The
tray now gates the approve chip on `!planComplete` and clears
`planAwaitingApproval` at turn-end when the plan is done, so a completed plan
shows only the collapsed "Plan complete" strip. Builds on v0.1.28.

**v0.1.28** — Plan title/file robust to preamble + the Homebrew "damaged"
fix. The saved plan file + tier-2 strip header now derive the title from the
`# Plan — <title>` heading wherever it sits (the model often writes diagnosis
prose first), so filenames stop coming out as
`i-have-the-root-cause-nailed-….md`; the chat splits that preamble off and
renders the plan portion as the structured card. Separately, the cask now
strips `com.apple.quarantine` in a `postflight` — modern Homebrew quarantines
casks by default, and an ad-hoc bundle + quarantine triggers macOS 26's
"MARVIN.app is damaged" rejection. Builds on v0.1.27's two-tier to-do / plan.
Install via
`brew tap RobertIlisei/marvin && brew install --cask marvin-ai`. Earlier
tags v0.1.0–v0.1.5 carried pre-scrub code and have been deleted from
GitHub; stray tags v1.2.0/v1.3.0 have no release. Per-release detail in the
[changelog](./history/CHANGELOG.md).

## Recent milestones

The high-water marks. Diagnostic detail per release in the [changelog](./history/CHANGELOG.md).

- **2026-06-23 — plan file mirrors live progress** ([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up). The saved plan at `.marvin/plans/<slug>.md` is now a live projection of the plan text + step status (`PlanFile.render`): completed steps get a `[x]` checkbox overlaid on their original line (numbering/prose preserved), discovered sub-tasks nest beneath their step, and the "Additional work" bucket is appended. `applyTodoWrite` re-persists on every reconcile (`open: false`), so checkmarks + additions reach the file — previously only the chat strip showed them.
- **2026-06-22 — v0.1.43 full session history via incremental paging** ([ADR-0048](./decisions/0048-full-session-history-tail-first.md)). Cold-start restore was tail-capped to 200 `cli.event` lines with no signal it clipped; the server now reports `truncated`/`totalTurns` and the client pages older lines in on demand (next 200 / full log) with an "N of M" count — fast first paint, full history always reachable.
- **2026-06-22 — v0.1.42 plan persistence + review-window + backlog capture-at-discovery.** Plan now survives chat switches/relaunch ([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up — `replay` rebuilds it from the transcript); the review window renders added/deleted files single-column + virtualises the diff + gates large diffs ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) bugfix); and the backlog auto-captures "noticed in flight" items as `provisional` the instant they're seen, reviewed keep/dismiss at the handoff ([ADR-0047](./decisions/0047-backlog-capture-at-discovery.md)).
- **2026-06-22 — plan as the durable spine: reconcile, don't clobber** ([ADR-0046](./decisions/0046-plan-as-durable-spine.md), revises [ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Fixed two plan-tracking bugs: a mid-plan `TodoWrite` wholesale-replaced the checklist (sub-tasks erased the plan + fired a false "Plan complete"), and a second plan overwrote the single plan slot (the original became untrackable). The active plan now owns hierarchical `PlanStep`s; incoming `TodoWrite`s **reconcile** into them (match → update, unmatched → nested sub-task) via `PlanProgress`; completion is computed over top-level steps only; plans live in a session list (`plans` + `activePlanId`, revision-aware by slug) with a strip picker so prior plans stay navigable. `personality.ts` + the approve instruction now require a full carry-forward `TodoWrite`.
- **2026-06-14 — v0.1.32 memory as a curated durable-facts layer** ([ADR-0042](./decisions/0042-memory-as-durable-facts.md)). `.marvin/memory.md` had bloated to 419 KB / ~99% redundant with ADRs/git/changelog. New `marvin-memory` MCP (`remember`/`recall`) is the enforced write path (file-per-fact + one-line index, caps + content-class guards); `personality.ts` firm surface; `buildProjectContext` injects the index; `/memory-compact` migration; native Scope-met chip retargeted to `session-notes.md`.
- **2026-06-14 — v0.1.31 project-graph lifecycle + context budget** ([ADR-0041](./decisions/0041-project-graph-lifecycle-and-context-budget.md)). Fixed "Prompt is too long": `buildProjectContext` injected all ADRs + full memory (~566K tok vs 200K). Now MARVIN auto-builds the active project's code+knowledge graphs (cwd-scoped, free) and the first-message context is budgeted — ADR titles index + memory tail + whole curated docs (~13.4K tok measured).
- **2026-06-14 — v0.1.30 interactive AskUserQuestion** ([ADR-0040](./decisions/0040-interactive-ask-user-question.md)). The model's built-in `AskUserQuestion` tool (surfaced via `canUseTool`, answered via `{behavior:"allow", updatedInput:{questions,answers}}`) now routes through MARVIN's confirm channel in every mode; a native `AskQuestionSheet` renders the options as clickable buttons (single/multi + "Other") and returns the pick as the tool result. The prose `PlanDecision` chip stays as a fallback. CI actions bumped to Node-24 majors (#105).
- **2026-06-13 — v0.1.29 no approve chip on a completed plan** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). A finished plan showed both "Plan complete 10/10" and "Approve & execute". The tray gates the approve chip on `!planComplete` and `turnCompleted` clears `planAwaitingApproval` once the plan's todos are all complete.
- **2026-06-13 — v0.1.28 plan title/file robust to preamble + Homebrew "damaged" fix** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). `PlanCard.split` divides an assistant reply into (preamble, plan) at the first `# Plan` heading — the saved file slug + tier-2 strip header use the clean plan portion (no more `i-have-the-root-cause-nailed-….md`), the chat renders preamble-as-prose + plan-as-card, and `planTitle` scans for the heading anywhere. The `marvin-ai` cask gained a `postflight` that strips `com.apple.quarantine` (modern Homebrew quarantines casks by default → ad-hoc bundle reads as "damaged" on macOS 26).
- **2026-06-13 — v0.1.27 two-tier to-do / plan + plan file in the editor** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). The plan card (in the chat scroll) and the to-do strip (above the input) read as two artifacts replacing each other; Cursor keeps two distinct tiers that coexist. `TodoListStrip` now forks on `planTitle != nil`: a neutral blue "Task list" for bare `TodoWrite` checklists, a purple titled "Plan — <title>" for plan-backed execution that ticks off in place. A presented plan is auto-written to `<workDir>/.marvin/plans/<slug>.md` and opened in the editor pane (`persistAndOpenPlan` → `setSelectedFile`) with an "Open plan" button. `personality.ts` updated to the inline-`# Plan`/stop contract (stale `ExitPlanMode` wording removed) + a tier-1 task-list trigger for 3+ step Agent work.
- **2026-06-12 — v0.1.26 plan card (Cursor-style structured plan rendering)** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). The decoupled Plan mode had left the plan as a plain-text assistant bubble. The plan-mode prompt now mandates the reply open with `# Plan — <title>`; `ChatMessageRow` detects that heading and renders the message as a collapsible `PlanCardView` (title, step count, line-styled markdown: headings / numbered steps / bullets / code fences) — content-shaped detection, so it also fires on transcript replay. Approving the plan seeds the To-dos strip from the plan's steps so execution starts tracked.
- **2026-06-11 — v0.1.25 Plan-mode UX polish** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Session-scoped plan/changes strips; Approve/Continue as hidden control actions (no fake user message); Save plan to a Markdown file; collapse/dismiss + auto-collapse the checklist; relabel "Plan" → "To-dos" (the task tracker; the plan is a distinct inline message + file).
- **2026-06-11 — v0.1.24 Plan mode decoupled + strip tray** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). Plan mode is a read-only planning turn on the chosen advisor model that presents the plan inline (no modal); an "Approve & execute" chip runs it in a separate Agent turn on the executor — role-routed models, no re-planning. The chat's contextual strips moved into one opaque divider-separated tray so they no longer overlap the message log.
- **2026-06-11 — v0.1.23 background jobs + fetch skills + plan follow-through** ([ADR-0038](./decisions/0038-background-jobs-event-wakeups.md), [ADR-0039](./decisions/0039-fetch-skills-from-git.md)). `run_background_job` fires a real follow-up turn on process exit (event-based wakeup); shell backgrounding denied at the gate. "Add from GitHub" fetches skills from a repo / sub-path / plugin marketplace. Plan mode: the plan persists in the chat + seeds the tracked to-do checklist; prompt requires live `TodoWrite` updates. Skills pane reorganised by state (active / available / recommended).
- **2026-06-11 — v0.1.22 modes + Cursor-style chat surface + skill enablement** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md), [ADR-0037](./decisions/0037-skill-enablement-active-set.md)). Ask/Agent/Plan modes (Ask read-only at the gate; Plan = SDK plan mode + an `ExitPlanMode` approval card; Agent unchanged) + a live `TodoWrite` checklist. Mode/reasoning controls relocated into the input box (`ChatModeToolbar`); open/close chat tabs persisted per project. Per-project skill enablement: a core/domain catalog + fingerprint-defaulted active set, named in the system prompt so MARVIN ignores irrelevant installed skills (20→7 here); Skills-pane toggles + `.marvin/skills.json`.
- **2026-06-10 — v0.1.21 diff-gutter accuracy + commit clears the review** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). `DiffGutterBar` now positions change markers from STTextView's real layout fragments (cached) instead of a font-metric line-height guess that drifted on scroll, and is `isFlipped`. `reconcileCommitted` (on `GET /api/changes`) auto-accepts reviewed files now clean vs HEAD, so committing clears them — drops only, never rewrites a baseline. 15/15 checkpoint tests.
- **2026-06-10 — v0.1.20 change review as a real diff editor** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). The review surface moved off a pane-clamped `.sheet` into its own large resizable `Window` with a side-by-side (original | modified) diff, line numbers, and a Split/Inline toggle — the VS Code / Cursor diff-editor layout. Cross-window strip refresh via `.marvinAgentChangesDidMutate`; checkpoint semantics unchanged.
- **2026-06-10 — v0.1.17–v0.1.19 per-role effort + agent change review + port ownership** ([ADR-0033](./decisions/0033-advisor-registered-agent-per-role-effort.md), [ADR-0034](./decisions/0034-agent-change-review-checkpoints.md), [ADR-0035](./decisions/0035-bundled-app-owns-its-port.md)). Advisor is a registered agent with its own model + effort (`adv` chip, "follow executor" default; SDK `advisorModel` Option found unwired). Cursor-style change review: gate-captured pre-image checkpoints, `/api/changes` family, live "N files changed" strip + per-hunk accept/reject sheet (E2E-verified). v0.1.19 closes the stale-sidecar-adoption bug that had masked two releases: the bundled app reclaims `:3030` before spawning and `/api/health` reports the serving process's `version`.
- **2026-06-04 — v0.1.14–v0.1.16 self-scheduled wakeups** ([ADR-0031](./decisions/0031-self-scheduled-wakeups.md), [ADR-0032](./decisions/0032-deny-background-bash.md)). `schedule_wakeup` / `cancel_wakeup` / `list_wakeups` (`marvin-control` MCP) + bounded persistent scheduler; fired wakeups start real turns via the shared `runDetachedTurn` orchestrator. v0.1.15 hard-denies Bash `run_in_background` at the gate. v0.1.16 fixes the standalone module-isolation bug (globalThis singleton + request-path handler wiring) that made fired wakeups evaporate without a turn.
- **2026-05-20 — v0.1.6 Homebrew cask + scrub.** Brew tap `RobertIlisei/marvin` with cask token `marvin-ai` (avoids collision with the unrelated "Amazing Marvin" cask). Vertical-specific recommendation rules removed (PR #81); domain-agnostic skill recommendations only. Personal-path scrub across docs.
- **2026-05-13 — Project-aware skill recommendations** ([ADR-0024](./decisions/0024-project-aware-skill-recommendations.md), [ADR-0025](./decisions/0025-skills-pane-ui.md)). Fingerprint detector at `sidecar/packages/project-context/src/fingerprint.ts` emits ~42 namespaced tags; 25 hand-curated rules in `sidecar/packages/runtime/src/suggestion-rules.ts` map tags → install/build verbs. Skills pane is the 4th tab in `LeftPane.swift`.
- **2026-05-10 — Bundled sidecar + brew-distributable** ([ADR-0023](./decisions/0023-brew-distributable-bundled-sidecar.md)). Sidecar now lives inside `MARVIN.app/Contents/Resources/` (Node 22.11.0 darwin-arm64 + Next standalone tree) and is spawned by the Swift process on launch. The launchd user agent path is opt-in via `bin/marvin install-macos-app --launchd`. Sidecar log path becomes `~/Library/Logs/MARVIN/sidecar.log`.
- **2026-05-05 — Fully-native IDE surface milestone** ([ADR-0021](./decisions/0021-webview-removal-fully-native-swift.md)). WebView removed end-to-end; native SwiftUI replaces every web-rendered panel. 8 sub-milestones: WebView removal, MRU file picker, Find in Files (ripgrep), Symbol Search (graph-backed), diff gutter, file history, build task palette, diagnostics panel + clickable status badge.
- **2026-05-04 — Phase ADRs 0017–0020** lay out the sub-phases that the native-IDE milestone collapsed.
- **2026-04-26 — Audit-driven hardening pass.** Closed every 🔴 finding from the full audit. Permission gate load-bearing in `auto` mode, `BASH_HARD_DENY` plugged ([ADR-0015](./decisions/0015-auto-mode-policy-floor-and-audit-log.md)), confirm-prompt redesign, Honeycomb env race fix, `/api/chat` cwd validation, TopBar collapse.
- **2026-04-21 — install-app + scout subagents.** `bin/marvin install-macos-app` ([ADR-0016](./decisions/0016-swift-migration.md) replaces the original Tauri wrapper from [ADR-0010](./decisions/0010-desktop-wrapper-tauri.md)). Read-only scout subagents ([ADR-0014](./decisions/0014-scout-subagents-read-only.md)).
- **2026-04-17 — initial ship.** Phases 1–4: chat surface, file tree, terminal, diff viewer, project picker, cost tracker, personality toggle, graph panel.

## Deferred (blockers, not capacity)

### Honeycomb MCP integration for observability

Would register as `marvin-honeycomb` and expose trace querying as tools the executor could invoke while debugging production issues. **Blocker:** requires a Honeycomb account + team-specific configuration; baking that into MARVIN's source violates the [isolation contract](./concepts/isolation-contract.md). Belongs in `<workDir>/.marvin/` config; no shipping ETA until a user has a Honeycomb environment to be the first to try.

### Test coverage beyond the write-channel security layer

The Vitest harness covers `fs-sandbox` / `fs-write-policy` / `fs-constants` / `fs-write-confirm-registry` and the new Swift logic targets (`MARVINLogic`, `MARVINTests`). The Agent SDK interaction loop, the React/SwiftUI shells, and individual API routes remain uncovered — still opportunistic. See [Testing](./development/testing.md).

### Real Developer ID + notarization

Today's `bin/marvin install-macos-app` produces an ad-hoc-signed `.app`; first launch needs right-click → Open. Real Developer ID + notarization removes the Gatekeeper warning and unlocks a pre-built signed `.app` distributed via GitHub Releases. **Blocker:** requires an Apple Developer account (~$99/yr) and CI plumbing for notarization.

## Not planned

Things MARVIN deliberately won't do. See [Vision](./business/vision.md) for the reasoning.

- Multi-agent orchestration ([ADR-0001](./decisions/0001-single-assistant.md)).
- Cross-platform desktop (Windows / Linux).
- Hosted SaaS with shared state.
- Cross-project memory.
- Broad "auto-mode heuristics" that switch models based on guessed complexity ([ADR-0002](./decisions/0002-default-to-opus-4-7.md)).

## Related

- [Changelog](./history/CHANGELOG.md) — chronological record of what shipped, when, and why.
- [Vision](./business/vision.md) — what MARVIN is trying to be.
- [ADRs](./decisions/) — material decisions.

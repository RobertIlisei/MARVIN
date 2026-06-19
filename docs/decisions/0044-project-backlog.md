# ADR-0044 — Project backlog: a durable parking lot for deferred work

**Status:** Accepted — 2026-06-19
**Touches:** new `backlog.ts` + `backlog-mcp.ts` (runtime), `sdk-runner.ts`
(register the `marvin-backlog` MCP server), `project-context/src/index.ts`
(first-message injection), `personality.ts` (firm-surface row + scope-met
handoff), new `GET/POST/PATCH /api/backlog` routes, macOS `BacklogService` +
`BacklogPanel` + a tray count chip, `.gitignore`/docs note. Sits beside — and
deliberately distinct from — durable-facts memory ([ADR-0042](./0042-memory-as-durable-facts.md)),
plans ([ADR-0036](./0036-autonomy-modes.md)), and the Definition-of-Done /
"noticed in flight" handoff (Golden Rule 8).

## Context

MARVIN's own working loop keeps generating good deferred-work items it then
*loses*. The Golden-Rule-8 handoff makes MARVIN list **"noticed in flight, not
in scope"** follow-ups and ask the user — but those items live **only in chat
scrollback**. MARVIN holds no state between sessions (Golden Rule 4), so the
moment the session ends the insight is gone unless the user personally
remembers it. A real example that prompted this ADR:

> *"the conformance test's one-directional check (handler-without-spec passes
> silently) is the structural reason these drifted. Tightening it would prevent
> recurrence — but that's beyond this fix. Want me to take it on, or commit
> what's here first?"*

That is a high-value, well-scoped follow-up. Today it evaporates.

**No existing surface holds it, each for a principled reason:**

- **`memory.md` / `remember`** (ADR-0042) is durable *facts*; the tool
  **rejects task/activity/status payloads by regex** (`memory-mcp.ts`). A
  follow-up is an *intention*, not a fact — rejected by design.
- **`plans/`** (ADR-0036) is the *current* task's checklist — transient,
  cleared on session-fresh.
- **`session-notes.md`** is an unstructured activity log with no
  status/lifecycle, and gets clobbered.
- **`docs/roadmap.md`** is MARVIN's **own** repo's roadmap; the item belongs
  to the *user's* project (Golden Rules 4 & 6).
- **TodoWrite/todos** are in-session, memory-only, zeroed on reset.

So there is a well-defined empty slot: **durable, cross-session,
project-scoped, *actionable* deferred-work items with status** — distinct from
facts, current plans, activity, and MARVIN's roadmap.

**The load-bearing constraint.** Golden Rule 1 forbids
"Kanban-as-source-of-truth" and multi-agent dispatch; ADR-0042 is the scar from
a memory log that bloated to 419 KB / ~99 % redundant. So this feature must be
a **parking lot a human and the single assistant consult — never a board that
agents autonomously pull work from**, and its growth must be bounded at the
write boundary (prose guidance demonstrably failed for memory).

## Decision

Add a **project backlog**: a small, durable, per-project store of *actionable*
deferred items, written through an enforcing MCP tool, surfaced to MARVIN on
session start and to the user in a UI panel — captured **only with user
consent** and **never auto-executed**.

### 1. Store — file-per-item + index (mirrors the memory layer)

Per active project, under the **user's** workspace:

- `<workDir>/.marvin/backlog/<slug>.md` — one item per file:
  ```markdown
  ---
  id: <slug>
  title: <one line, imperative>
  status: open            # open | doing | done | dismissed
  severity: med           # low | med | high
  source: { sessionId, turnId, at }   # where it was noticed
  created: <ISO>
  updated: <ISO>
  ---
  Why it matters + the concrete change + an acceptance hint.
  Link related context with [[memory-slug]] / ADR refs.
  ```
- `<workDir>/.marvin/backlog.md` — a one-line-per-item **index** of `open` +
  `doing` items (done/dismissed drop from the index but their files remain as
  history). Same shape as memory's `MEMORY.md`.

It's the user's artifact — they choose to commit or `.gitignore` it (like
`plans/` and `memory.md`). MARVIN ships no backlog content (Golden Rule 6).

### 2. Write path — the `marvin-backlog` MCP tool (the anti-bloat boundary)

An in-process MCP server (`backlog-mcp.ts`), registered in `sdk-runner.ts`
beside `marvin-memory`:

- **`backlog_add({ title, body, severity? })`** — creates the file + rebuilds
  the index. **Enforces content-class** (the ADR-0042 lesson): accepts only an
  *actionable, scoped* follow-up; **rejects** anything that smells like a
  durable fact (→ `remember`), verification/commit status (→ git), or a
  decision (→ ADR), with guidance. Dedups by slug/title; caps title + body
  length and total open-item count (a rail, not a workload).
- **`backlog_list({ status? })`** — read the backlog.
- **`backlog_resolve({ id, resolution: done | dismissed, note? })`** — legal
  status transition only; a resolved item fires no further surfacing.

### 3. Capture — consent-gated, at the scope-met handoff

Wire into the **existing** "noticed in flight, not in scope" moment in
`personality.ts`: when MARVIN lists out-of-scope follow-ups, it **proposes**
parking them and the user confirms. **No silent auto-capture** — that is the
bloat/Kanban trap. The user can also add an item by hand in the UI (§6).

### 4. Surface — capped first-message injection

`buildProjectContext` gains a **Project backlog** section (a new
`ProjectContextSection`, counted in the `/context` breakdown) listing **open**
items, **capped** (token-budgeted tail, like the memory injection in
`index.ts`). Framed explicitly as *"parked follow-ups you may propose resuming
— NOT an auto-queue."* This is what lets next session re-discover its own
parked work instead of losing it.

### 5. Anti-Kanban invariant (Golden Rule 1)

The backlog is a **memo to future-self surfaced at the right moment.** It:
- is read by the **single assistant + the user** — **no subagent pulls from
  it**, no fan-out, no dispatch;
- **never triggers work autonomously** — promotion to a plan/turn is always a
  user action;
- **never overrides plan-first** or the user's decision to act.
A new firm-surface row in `personality.ts` states this as MUST / MUST-NOT, the
same shape as the other surfaces in the CLAUDE.md table.

### 6. UI — a backlog panel + promotion (incl. optional GitHub export)

- New `GET /api/backlog?projectId=&status=` (list), `POST /api/backlog` (manual
  add), `PATCH /api/backlog/:id` (resolve / dismiss / edit / promote).
- macOS `BacklogService` + `BacklogPanel`: open items with severity, a link
  back to the source turn, and per-item actions — **Done**, **Dismiss**,
  **Promote to plan** (seeds a new turn: *"Implement: <title>"*), and an
  **optional Promote to GitHub issue** (`POST /api/backlog/:id/promote-issue`
  via `gh`, for projects with a remote — an *export target*, never the store).
- A tray count chip (like the plan/todo strips) shows the open-item count and
  opens the panel.

## Consequences

- The "noticed in flight" insight stops evaporating: it survives the session as
  a small, structured, user-owned artifact, and resurfaces next session.
- The backlog axis joins memory (facts) / plans (current) / roadmap (MARVIN's
  own) without overlapping them — each has one firm-surface row with a crisp
  boundary.
- One more per-project state dir under `.marvin/`; bounded by write-boundary
  caps + stale-reaping, capped on injection so it can't blow the context budget
  (the ADR-0041 lesson).
- Net-new UI + API surface (the cost of making it *visible*, which is the point
  — an invisible backlog is just another forgotten file).

## Rejected alternatives

- **Do nothing (status quo).** The exact failure this ADR exists to fix —
  items lost on session end.
- **Single `backlog.md` file.** Unstructured, no status machine, no dedup —
  the precise shape that bloated `memory.md` before ADR-0042.
- **Reuse the memory layer.** `remember` rejects task payloads by design; facts
  and intentions are different content classes that must not share a store.
- **GitHub issues as the store.** Requires a remote (not all projects),
  crosses the trust boundary, heavyweight/noisy, not local-first — kept as an
  optional *export*, not the source of truth.
- **Auto-capture every noticed item.** The Kanban/bloat trap; capture stays
  consent-gated.

## Scope of Done

- [x] `backlog.ts` store: file-per-item + index, status transitions; 13 unit
      tests (add/list/resolve, dedup, re-open, index rebuild, caps).
- [x] `marvin-backlog` MCP tool registered in `sdk-runner`; content-class
      enforcement (`classifyBacklogText`) rejects fact/status/decision payloads
      with guidance; caps + dedup; classifier covered by unit tests.
- [x] Consent-gated capture wired into the scope-met / "noticed in flight"
      handoff in `personality.ts` (proposes, never auto-parks).
- [x] `buildProjectContext` injects open items (capped, `BACKLOG_TAIL_TOKENS`)
      on first message, framed as a parking lot; a `/context` breakdown
      category counts them.
- [x] Anti-Kanban invariant encoded as a `personality.ts` firm-surface row
      (MUST/MUST-NOT) + a CLAUDE.md table entry; no subagent-pull path exists.
- [x] `GET/POST/PATCH /api/backlog` + optional `/promote-issue` routes (CSRF +
      `validateProjectCwd`).
- [x] macOS `BacklogService` + `BacklogPanel` + tray count chip; Promote-to-plan
      seeds a turn via `sendControl` + flips the item to `doing`;
      Promote-to-issue behind a remote check.
- [x] sidecar tsc clean for all touched files; runtime tests green (the
      pre-existing `fs-sandbox.test.ts` failure is unrelated — confirmed on the
      stashed clean tree). macOS `swift build` — verified at implementation.
- [x] CLAUDE.md firm-surface table + Cross-session continuity section name the
      backlog and its boundary vs memory/plans/roadmap.

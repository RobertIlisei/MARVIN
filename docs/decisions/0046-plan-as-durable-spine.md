# ADR-0046 — Plan as the durable spine: reconcile, don't clobber

- Status: accepted
- Date: 2026-06-22

## Context

ADR-0036 gave MARVIN a two-tier to-do surface: a bare `TodoWrite` "task list"
(tier 1) and a plan-backed checklist (tier 2). Both tiers are driven by a
**single flat `todos: [TodoItem]` array plus one `currentPlanText` slot** in
`ChatPreviewView`, and both are **wholesale-replaced**: every `TodoWrite` event
does `todos = latest` (`ChatPreviewView.swift:1040`), and every new plan
overwrites `currentPlanText` and re-seeds `todos` (`:1086`, `:1120`). Two user-
reported bugs trace to that single design choice:

1. **Sub-tasks erase the plan.** When the executor emits a `TodoWrite`
   containing only the sub-tasks it is currently focused on (rather than the
   full plan carried forward), the blind `todos = latest` wipes the plan's
   steps from the strip. Worse, `allDone` is computed over whatever is in
   `todos`, so finishing those few sub-tasks flips the strip to "Plan
   complete" while the real plan is unfinished.
2. **A new plan erases the original.** There is exactly one plan slot, so a
   second plan presented mid-work (a fresh `ExitPlanMode`, or a plan-mode
   `turnCompleted`) overwrites `currentPlanText` and re-seeds `todos`. The
   original plan's progress disappears from the UI, and although the old plan
   file may still sit at `.marvin/plans/<old-slug>.md`, nothing surfaces it —
   there is no plan list to navigate back to.

The design *assumes* the model re-sends the whole list every time (carrying
every plan step forward), and `personality.ts` does instruct it to keep "one
item per plan step" — but MARVIN trusts that contract blindly, with no merge
and no guard. Cursor / Claude Code avoid both failures by keeping **one durable
list that is only ever rewritten in full** (items change status, never vanish)
and by treating plans as **navigable artifacts**, not a single ephemeral slot.

## Decision

Make the plan the **durable spine**: the active plan owns an ordered list of
top-level steps, each able to hold nested sub-tasks, and incoming `TodoWrite`
events **reconcile into** that structure instead of replacing it. Keep prior
plans as session-scoped, navigable entries. Tighten the prompt contract so a
well-behaved turn never sends a partial list, with the UI reconciliation as the
backstop for when it does.

- **Hierarchical model.** A new `PlanStep { content, status, activeForm,
  subtasks: [TodoItem] }` and a `Plan { id (slug), title, text, path, steps }`.
  Tier 1 (bare task list, no plan) keeps the existing flat `todos: [TodoItem]`.
  Tier 2 is driven by `Plan.steps`.
- **Reconcile, don't clobber (bug 1 / sub-tasks).** When a plan is active, a
  `TodoWrite` is reconciled (`PlanProgress.reconcile`): each incoming item is
  matched to a plan step by normalized content (exact, else containment with a
  length guard); matches update that step's status/`activeForm`; **unmatched
  items become nested sub-tasks under the active step** (the `in_progress` one,
  else the last incomplete step, else a trailing "Additional work" bucket).
  Sub-task statuses themselves update across successive `TodoWrite`s.
- **Completion over top-level steps only (bug 1 / false-complete).** "Plan
  complete" / `allDone` is computed over `Plan.steps` status, never over
  sub-tasks, so a sub-task-only list can never fire a false completion.
- **Plan list + revision-aware ingest (bug 2 / clobber).** Plans live in a
  session `plans: [Plan]` keyed by slug with an `activePlanId`. Ingesting a
  plan whose slug already exists is treated as a **revision** — the step list
  is rebuilt but existing step/sub-task progress is carried over via the same
  reconcile pass. A new slug **appends** a new plan and makes it active; it
  never overwrites the prior one. The strip header shows a plans picker when
  more than one exists, so the user can switch the active plan.
- **Prompt contract (defense-in-depth).** The Plan-mode / approve-to-execute
  stanzas in `personality.ts` and the `approvePlan()` control instruction now
  state that `TodoWrite` MUST always contain **every** plan step, carried
  forward with its status — new work discovered mid-execution is **added**, and
  MARVIN nests it; a `TodoWrite` that drops plan steps is forbidden.

## Consequences

- Positive: the plan no longer disappears when sub-tasks arrive or when a
  second plan is presented; progress survives revisions; "Plan complete" is
  honest; prior plans stay reachable. The model misbehaving (partial list)
  degrades to "extra sub-tasks nested under the active step" instead of "plan
  wiped".
- Negative / trade-offs: reconciliation is heuristic (content matching) — a
  step the model rephrases heavily may land as a sub-task rather than updating
  its step in place. Acceptable: it never *loses* the work, and the next full
  `TodoWrite` re-matches. The plan list is session-scoped (in-memory); it is
  not rehydrated from `.marvin/plans/` on session load.
- Follow-ups created: (a) ~~rehydrate the session plan on load~~ **done
  2026-06-22** — `replay` reconstructs the plan + checklist from the transcript
  (last `# Plan` reply + latest `TodoWrite` for step progress), so switching
  chats / relaunching no longer loses the plan and a later `TodoWrite`
  reconciles into the restored plan instead of orphaning as a tier-1 list;
  (b) let the user reorder / promote a sub-task to a top-level step (deferred).

## Alternatives considered

- **Trust the contract, prompt-only fix.** Rejected: the prompt already said
  "one item per plan step" and the bug still happened; the firm-surface
  philosophy says enforce at the boundary, not advise.
- **Flat list + merge by content (no hierarchy).** Rejected: merging keeps the
  plan's items but gives the user no place for genuinely-new mid-flight work,
  which is exactly what they asked to see nested under a plan step.
- **Disk-backed plan registry rehydrated each session.** Deferred, not
  rejected: the reported clobber is within-session, so an in-session list fixes
  it; disk rehydration is a follow-up, not a precondition.

## Scope of Done

- [ ] `PlanStep` (with `subtasks`) + `Plan` types exist; `PlanParser` seeds
      steps; tier-1 `todos` behaviour is unchanged when no plan is active.
- [ ] A `TodoWrite` arriving while a plan is active reconciles (match → update,
      unmatched → nested sub-task) instead of wholesale-replacing the list.
- [ ] "Plan complete" / `allDone` is computed over top-level steps only; a
      sub-task-only `TodoWrite` cannot trigger it.
- [ ] A second plan appends a navigable entry (revision-aware by slug,
      progress preserved); the strip exposes a picker to switch active plan;
      no silent clobber of the prior plan.
- [ ] `personality.ts` + the `approvePlan()` instruction require a full,
      carry-forward `TodoWrite` (never a partial list).
- [ ] `swift build` clean; runtime `tsc` clean.

## Related

- Files: `macos/MARVIN/TodoListView.swift`, `macos/MARVIN/ChatPreviewView.swift`,
  `macos/MARVIN/PlanCardView.swift`, `sidecar/packages/runtime/src/personality.ts`
- Supersedes / superseded by: revises ADR-0036 (two-tier to-do/plan model)

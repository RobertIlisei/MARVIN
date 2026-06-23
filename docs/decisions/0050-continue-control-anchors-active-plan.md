# ADR-0050 — The Continue control anchors on the active plan, not a project re-audit

- Status: accepted
- Date: 2026-06-23

## Context

The plan strip's **Continue** chip (`continuePlanChip` → `continuePlan()`) and the
decision strip's **Proceed with recommendation** chip
(`proceedWithRecommendation()`) are Cursor-style *control* actions: pressing one
sends a hidden instruction to resume an in-flight plan, rendered in the chat as a
compact `▶ Continuing` row (ADR-0036 / ADR-0046).

The instruction those controls sent was unscoped:

> "Continue with the remaining plan steps. First re-emit your TodoWrite
> checklist with current statuses, then proceed and keep it updated."

It never told the model **what the plan actually was** — it relied on the model
reconstructing its own checklist from context. On a long, audit-heavy session
(many ADRs, a project `PLAN.md`, `DRIFT.md`, verdict sequences) that context is
diffuse, and "continue with the remaining plan steps" degrades into "go find what
work remains in this project." A user reported exactly that: after a plan
finished ("All items complete… Scope met"), pressing Continue made MARVIN
**re-audit the whole project** — grepping `PLAN.md` for open markers
(`❌ ⚠️ TODO OPEN pending next`), `ls`-ing every ADR (`docs/adr/0163…0180`),
reading `INDEX.md` — instead of resuming (or closing out) the current plan.

Two faults combined:

1. **Stale completion left the chip showing.** Pre-ADR-0049, plan steps were
   matched to `TodoWrite` items by fuzzy text, so a step could stay
   non-`completed` even though its work was done. `planPausedWaiting`
   (`!isSending && trackedItems.contains { $0.status != "completed" }`) then kept
   the Continue chip visible after the model had already said "all complete".
   ADR-0049 (the `[N]`/`[N.M]` join key + roll-up) fixes this cause — a finished
   plan now actually reads as complete, so the chip doesn't show.
2. **The instruction had no anchor and no guardrail.** Even on a *genuinely*
   mid-plan resume, nothing scoped the model to the active plan or forbade a
   project-wide scan. This is independent of fault 1 and needs its own fix.

## Decision

Make the resume controls **inject the active plan's concrete state** and **forbid
a project re-audit**.

- **Anchor.** A new `resumeChecklistBlock()` renders the active plan (or, for a
  tier-1 task list, `model.todos`) as a tagged checklist —
  `[N] <step> — <status>` with `  [N.M] <subtask> — <status>` nested beneath,
  mirroring the ADR-0049 contract. `continuePlan()` and
  `proceedWithRecommendation()` embed that block, so the model resumes against
  the *actual* current steps rather than re-deriving them.
- **Guardrail.** The instruction now states explicitly: resume the ACTIVE plan
  and ONLY this plan — do NOT start a new audit, scan the project for other open
  work, or read unrelated files (no grepping `PLAN.md` / listing ADRs / reading
  `INDEX`). And the completion case is named: if every step is already complete,
  do NOT invent new work — say the plan is complete and stop.
- **Scope.** Pure control-instruction change in `ChatPreviewView.swift`; no
  `personality.ts` edit (the control instruction is the firm surface the model
  reads at turn time) and no data-model change.

## Consequences

- Positive: Continue/Proceed resume the specific in-flight plan deterministically
  and can't wander into a whole-project audit; a finished-but-mis-marked plan
  (legacy transcripts) degrades to "say it's complete and stop" instead of a
  broad scan. Combined with ADR-0049 the reported behaviour is closed from both
  ends — the chip no longer shows on a done plan, and if it does show the
  instruction is bounded.
- Negative / trade-offs: the instruction is longer and embeds the plan text
  (bounded — `PlanParser` caps plans at 20 steps, sub-tasks are few). If the
  model genuinely needs to discover new work it must now be asked in a fresh
  message rather than inferring it from a Continue press — intended, per
  Golden Rule 8 (match-not-improve: don't silently expand scope on resume).

## Alternatives considered

- **Hide the Continue chip once the plan is complete only.** Rejected as
  insufficient: ADR-0049 already makes a complete plan stop tripping
  `planPausedWaiting`, but that doesn't bound a *mid-plan* resume — the unscoped
  instruction would still let the model re-audit.
- **Add the no-re-audit rule to `personality.ts`.** Rejected as the wrong
  surface: the failure is specific to the resume *control*, and the control
  instruction is already where MARVIN reads its marching orders for that turn;
  putting it in the always-on prompt would tax every turn for a control-only
  concern.

## Scope of Done

- [x] `resumeChecklistBlock()` renders the active plan / tier-1 list as a tagged
      `[N]`/`[N.M]` checklist with statuses.
- [x] `continuePlan()` embeds the checklist + an explicit "resume ONLY this
      plan, do not re-audit / scan / list ADRs" guardrail + a "if complete,
      stop" clause.
- [x] `proceedWithRecommendation()` carries the same anchor + guardrail after
      answering the open decisions.
- [x] `swift build` clean.

## Related

- Files: `macos/MARVIN/ChatPreviewView.swift` (`resumeChecklistBlock`,
  `continuePlan`, `proceedWithRecommendation`).
- Builds on: ADR-0036 (Ask/Agent/Plan modes + control chips), ADR-0046 (plan as
  durable spine), ADR-0049 (plan-step join key + roll-up — fixes the stale-chip
  cause this ADR's guardrail complements).

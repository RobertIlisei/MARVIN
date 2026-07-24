# ADR-0057 — Workflow-completion guard: force plan/ADR reconciliation on scope-met

**Status:** Accepted — 2026-07-24
**Touches:** new `workflow-guard.ts` (pure detectors + prompt synth),
`sdk-runner.ts` (turn-end guard: capture last TodoWrite + edited ADR paths;
fire a corrective turn on a premature scope-met), `personality.ts` (Phase-7
firm-surface note). Same mechanism as the check-back guard
([ADR-0055](./0055-checkback-promise-auto-arm-guard.md)); reuses the wakeup
dispatch of [ADR-0031](./0031-self-scheduled-wakeups.md); complements the plan
spine ([ADR-0052](./0052-plan-file-ownership.md)) and the DoD contract
(Golden Rule 8).

## Context

Phase 7 requires that when a real-work turn closes (the `<!-- marvin:scope-met -->`
sentinel), the plan's TodoWrite items are reconciled and any ADR's
`## Scope of Done` is marked. Observed failure: MARVIN completes a plan that
created an ADR, declares it finished, but leaves TodoWrite items `pending` /
`in_progress` and the ADR's `- [ ]` boxes untouched. It's a **prose MUST**, and
prose MUSTs fire unreliably — the recurring lesson behind every firm surface in
this repo. The user reported it directly: *"the scope of done is not followed or
updated after the work … the plan items are not fully updated, and the scope of
done also is not marked as done."*

## Decision

A **mechanical backstop at turn end**, mirroring ADR-0055. When a successful
turn emits the scope-met sentinel but the work isn't reconciled, the runtime
fires a corrective follow-up turn that forces an HONEST reconciliation.

### Detection (`workflow-guard.ts`, pure)

- **Scope-met**: the `<!-- marvin:scope-met -->` sentinel (kept in lockstep with
  personality.ts and Swift `ScopeMetDetector`) in the final assistant text.
- **Open plan items**: the turn's LAST `TodoWrite` payload (authoritative under
  ADR-0046's full-list-rewrite rule) has ≥1 item whose `status !== "completed"`.
  When the completing turn emitted **no** `TodoWrite`, fall back to the persisted
  plan spine (`<sessionId>.plans.json`, ADR-0052) — the ACTIVE plan's open
  top-level steps. This closes the multi-turn "terminal turn declares done
  without re-emitting TodoWrite" gap. The spine is client-owned and server-
  opaque, so `openPlanSteps` parses it fully defensively (any deviation → `[]`,
  no gap, never throws), and the persistence module stays shape-agnostic. The
  fallback is used ONLY when no `TodoWrite` ran this turn — so the plan didn't
  advance and the 500 ms-debounced client PUT can't be racily stale (open steps
  in the spine are then genuinely open). A mismatched session key reads null →
  no gap → safe degradation.
- **Unmarked ADR**: an ADR file edited this turn (`Edit`/`Write`/`NotebookEdit`
  on `docs/decisions/*.md`) whose `## Scope of Done` section is **entirely**
  unticked — ≥1 `- [ ]` and ZERO `- [x]`. **A MIX is not flagged**: a partially
  ticked DoD is usually correct — bullets get legitimately deferred (an ADR may
  leave its "durable follow-up" box unchecked on purpose, e.g. ADR-0056). We
  catch the wholesale miss, never second-guess a considered partial.

### Action — corrective turn (chosen over flag-only / auto-fix)

Auto-ticking is rejected outright: marking a box MARVIN didn't earn is
fabrication, strictly worse than an unmarked box. Flag-only leaves adherence
manual — the user asked to *ensure* the workflow is followed, not to catch it
themselves. So the guard fires a corrective turn (via `scheduleWakeup`, 60 s,
reusing the ADR-0055 path). Its prompt lists the open items + unmarked ADRs and
demands honest reconciliation, **explicitly forbidding ticking-to-satisfy**:
*"mark `completed` ONLY what is genuinely done … for anything NOT actually done,
leave it open, say so plainly, and do NOT claim scope met … a false 'done' is a
worse failure than an unmarked box."*

### Termination

The corrective turn reconciles and closes; on ITS turn-end the todos are
`completed` and the ADR is ticked, so the guard doesn't re-fire. If work is
genuinely incomplete, MARVIN says so and doesn't re-emit scope-met, so no
sentinel → no re-fire. The wakeup chain-depth cap (≤8) backstops any loop.

## Consequences

- **Positive.** "Plan finished" becomes true — bookkeeping is reconciled or the
  claim is retracted, mechanically, not on trust.
- **Negative.** One extra turn per catch. False-positive surface is small and
  deliberately conservative (open todos is exact; the ADR check ignores partials
  to spare legitimate deferrals). A false positive costs one honest re-check.
- **Scope.** The multi-turn terminal case (scope-met with no in-turn TodoWrite)
  is covered by the persisted-plan-state fallback. The only residual miss is a
  plan whose spine was never persisted at all (client PUT never fired) — rare,
  and it degrades to today's behaviour (no false positives).

## Scope of Done

- [x] `openTodos` returns non-completed items; empty on all-done / malformed.
- [x] `scopeOfDoneEntirelyUnticked` flags an all-unticked DoD, NOT a mix or a
      fully-ticked one; stops at the next heading — unit tested.
- [x] `sdk-runner` fires ONE corrective wakeup on scope-met + a real gap, and is
      a no-op otherwise (all-done, no sentinel, no wakeup ctx).
- [x] Prompt forbids ticking-to-satisfy; Phase-7 note added to personality.ts.
- [x] Full suite + typecheck green; app rebuilt.

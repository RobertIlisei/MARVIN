# ADR-0067 — Gate on scope boundaries, not turn boundaries

- **Status:** Accepted
- **Date:** 2026-08-17
- **Related:** Golden Rule 8 (Definition of Done / match-not-improve),
  [ADR-0031](./0031-self-scheduled-wakeups.md) (self-scheduled wakeups),
  [ADR-0036](./0036-ask-agent-plan-modes.md) (autonomy modes),
  [ADR-0046](./0046-plan-as-durable-spine.md) / [ADR-0051](./0051-plan-in-context-injection.md) /
  [ADR-0052](./0052-durable-plan-spine-and-plan-file-ownership.md) (the plan as durable spine)

## Context

A user reported that a plan had been in flight for three days that should not
have taken three days, and that the work kept stalling on questions they were
not present to answer. Rather than design around the complaint, the session
transcript was measured
(`~/.marvin/sessions/users-robertilisei-projects-agri-saas-platform/530c70c6…jsonl`,
10,237 records, 104 turns).

**49.0 h elapsed. MARVIN worked 15.9 h (32.4 %). The user was the critical path
for 33.1 h (67.5 %).**

The composition of that 33.1 h is the finding:

| Cause | Time | Occurrences |
|---|---|---|
| Ended a turn mid-plan having asked **nothing** | **17.8 h (53.8 %)** | 65 |
| Asked permission for work the approved plan already covered | 6.7 h (20.3 %) | 20 |
| Died on a transport error and stayed dead | 5.1 h (15.5 %) | 4 |
| Waiting on a background job — *working as designed* | 3.4 h (10.3 %) | 13 |

**Only ~10 % of the waiting was legitimate.** The two largest single stalls:

- **8.3 h** — MARVIN ended with a status report. No question, mid-plan, at
  23:53. It simply stopped until morning.
- **4.7 h** — *"Want me to go ahead and fix all of these now, or handle a subset
  first?"* The reply was *"Fix all issues and continue with the
  implementation."* No information was transferred; the work was already in the
  plan.

The user typed *"Resume the ACTIVE plan below — and ONLY this plan. Do NOT start
a new audit…"* **8 times**. That macro is a user-built workaround for a product
defect, and it encodes *both* failure modes at once: MARVIN stopped when it
should have continued, **and** wandered into new audits when it should have
stayed.

### The cause is our own rule, working exactly as written

Golden Rule 8 mandates ending real-work turns with `**Scope met:** … Anything
else, or should I stop?`. Phase 7 adds "one gap, one gate". Together they make
**every milestone a blocking handoff**. Across 104 turns that is ~65 designed
full stops, most of them inside an already-approved plan.

The rule was written to prevent the "helpful spiral" — six commits past the ask.
That danger is real and is not in dispute. But the rule gates on the wrong
axis: it fires at **turn boundaries** when the thing worth protecting is the
**scope boundary**.

### Why this matters more than it looks

An autonomous/overnight mode was under discussion when this was measured. Built
on the current loop it would have **autonomously stopped 65 times**. Fixing the
gating is therefore a prerequisite for autonomy being worth anything, not an
alternative to it.

## Decision

### 1. An approved plan is standing authorization

At the end of a milestone MARVIN classifies the boundary it is at.

**CONTINUE in the same turn** when all of: a plan is active, steps remain, the
milestone met its DoD, and the next step is inside that plan.

**STOP and hand off** when any of: the plan's last step is done; the next action
would leave the approved plan (new audit, new subsystem, adjacent improvement —
the helpful spiral, and precisely what Golden Rule 8 is for); a DoD bullet is
unmet for a *judgement* reason; Phase 6's bounded self-remediation hit its cap
or no-progress stop; or a real trade-off needs the user.

The `<!-- marvin:scope-met -->` sentinel is now explicitly an **end-of-scope**
marker, not an end-of-step marker.

**This does not weaken Golden Rule 8 — it aims it.** The rule exists to stop
MARVIN wandering *out* of scope, never to stop it finishing what was approved.

### 2. A "would any answer change what I do next?" test on questions

If the only plausible reply is "yes, continue", it is a stall rather than a
question. `personality.ts` now carries the enumerated anti-triggers observed in
the transcript ("Want me to fix all of these now?", "Shall I continue with the
next step?", "Approve to proceed to the next phase?" mid-plan) alongside the
restatement that **finding facts is MARVIN's job; only decisions are the
user's** — the user is frequently away, so an avoidable question costs hours.

### 3. Self-anchoring

MARVIN re-reads the active plan (`.marvin/plans/`, plus ADR-0051/0052 plan
context) instead of requiring the user to paste a resume macro. Needing that
macro is defined as a violation of this ADR.

### 4. Transport failures auto-continue (the 5.1 h)

A dropped socket is not a verdict about the work. `transient-errors.ts`
classifies a failed turn and `runDetachedTurn` re-enters the session **through
the existing wakeup scheduler**, so ADR-0031's rails (pending cap, re-schedule
depth, chain depth, unchanged permission posture) apply without a bespoke retry
loop.

The classifier is a deliberately **narrow allowlist** — anything unrecognised is
terminal. Two categories that look transient and are explicitly excluded:

- **Context overflow** (`prompt is too long`) — retrying resends the same
  oversized prompt; it cannot succeed and it bills for the attempt.
- **Aborts** — the user or the watchdog stopped this on purpose; restarting it
  inverts their intent.

Auth, permission and billing failures are likewise terminal. Terminal patterns
are checked **first**, so an abort that also mentions a timeout does not retry.
Bounded at `MAX_AUTO_CONTINUES = 3` with 60 s / 180 s / 420 s backoff, and the
resume prompt tells the model to *pick up where it left off, checking what
already landed* — never to restart, which is how a retry duplicates work.

## Scope of Done

- [x] `personality.ts` Phase 7 gates on scope boundaries; CONTINUE/STOP
      conditions enumerated; sentinel scoped to end-of-scope.
- [x] Permission anti-triggers + the "would any answer change what I do next?"
      test added to the question-asking rules.
- [x] Self-anchoring to the active plan replaces the user's resume macro.
- [x] Transport errors auto-continue via the wakeup scheduler, bounded at 3.
- [x] 21 tests over the classifier pin both edges — the real production error
      retries; overflow / abort / auth / unrecognised do not.
- [x] 710 tests pass, 8/8 typecheck, no existing test weakened.

## Consequences

**Expected.** On a session shaped like the measured one, ~24.5 h of the 33.1 h
of waiting becomes unnecessary, and the 5.1 h of dead time becomes minutes.
Three days should become roughly one.

**Risk, stated plainly.** This loosens stop-gates that were protecting against a
real failure. The mitigation is that the *out-of-scope* stop is untouched and
now stated more explicitly than before — but if the helpful spiral returns, this
ADR is the first thing to re-examine. The honest test is whether the user still
needs a "do NOT start a new audit" macro; that macro's disappearance is the
success metric.

**Not measured yet.** The behavioural change is prompt-level, so it cannot be
unit-tested — only observed on the next long session. Re-run the transcript
analysis in this ADR against the next multi-day plan and compare the four-way
split. The same script also surfaced **106 rate-limit events**, which inflate
the 15.9 h of "working" time; that is a separate, unexamined cost.

## Addendum (2026-08-18) — this regressed backlog closure

Reported: a session "worked on 3 items and didn't close any". Verified — session
`ecdf068d` called `backlog_list` and `backlog_groom` and **zero**
`backlog_resolve`, while doing real work.

Cause is this ADR. The keep/dismiss review lives in Phase 7's handoff block
("at THIS handoff, `backlog_list status: provisional` and batch-review"), and
this ADR stopped that handoff firing at every milestone. Fewer handoffs, fewer
reviews — and items that the work actually finished were never closed.

An unintended coupling: resolving a backlog item was only ever expressed as
handoff bookkeeping, so removing handoffs removed it entirely.

**Fixed** by moving item closure out of the handoff and into the CONTINUE
branch: if the milestone just finished resolves a parked item,
`backlog_resolve … done` is called *then*, with evidence — not carried to a
handoff that may be several steps away or may never come. The provisional
keep/dismiss review stays at the real scope boundary, where it belongs.

**Lesson worth keeping:** a rule that changes *when turns end* silently changes
everything attached to a turn ending. Anything bound to the handoff should be
re-checked against this ADR — the backlog review was the first casualty found,
and is unlikely to be the only thing coupled that way.

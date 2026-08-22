# ADR-0068 — Plan de-duplication, context provenance, and the discipline of negative claims

- **Status:** Accepted
- **Date:** 2026-08-17
- **Related:** [ADR-0046](./0046-plan-as-durable-spine.md) (plan as durable spine),
  [ADR-0049](./0049-plan-step-join-key-and-rollup.md) (stable sub-task keys),
  [ADR-0051](./0051-plan-in-context-injection.md) (plan-context injection),
  [ADR-0052](./0052-durable-plan-spine-and-plan-file-ownership.md) (durable plan state),
  [ADR-0059](./0059-session-auditor-runtime-dispatched-read-only.md) (auditing claims against evidence)

## Context

MARVIN was asked to reconcile claimed vs actual work on the agri-saas-platform
project. It produced a confident five-point finding, of which the headline items
were:

> **1. No real plan matches the injected checklist.** … none resembling "Grouped
> backlog fix pass". It isn't a tracked plan; it never was.
>
> **3. Other claims have zero evidence anywhere.** `make dev-reset` (volume
> wipe), Docker Desktop force-kill/restart saga, a 300-entry Playwright triage
> with named specs — no matching commits, files, logs, or test output. **Treat
> as fabricated.**

Both are false, and were checked:

- The plan exists at `.marvin/plans/grouped-backlog-fix-pass.md`, titled
  `# Plan — Grouped backlog fix pass`, and is the session's **`activePlanId`**.
- Every "fabricated" item is in that file — `make dev-reset` at line 149 (and a
  real `Makefile` target), Docker force-kill at line 291, Playwright triage 15×.

The user was one step from discarding genuine, already-merged commits on the
strength of an accusation produced by a failed search.

Two of the five findings were correct: the 449 modified `.marvin/backlog/*.md`
files really were a mechanical schema backfill (the ADR-0064 `kind`/`blocked`
fields plus ADR-0065 `marvin:links` footers), and the large uncommitted diff
really did predate the session.

### Why MARVIN was suspicious in the first place — the plan really is corrupt

The injected checklist *is* self-contradictory. Measured on the real file (347
checkbox bullets, 38,980 bytes):

| Symptom | Count |
|---|---|
| Duplicated bullet texts | 24 |
| IDs reused for **different** work (`[7.14.2]` covers 6 items) | 14 |
| Bullets present **both** `[x]` and `[ ]` | 7 |

The mechanism is in `PlanProgress.mergeSubtasks`: it matches an incoming
sub-task by stable key, falls back to normalised-content equality-or-containment,
and **appends when both fail**. A reworded restatement matches neither —

```
Milestone A (sweep-side): zilier_entries + documents widened match, dry-run
counts, TDD RED-GREEN, DoD-completeness tests (purgeStorage chain + …) — 41/41 green
Milestone A (sweep-side): zilier_entries + documents widened match, TDD,
DoD-completeness tests — 41/41 green
```

— neither contains the other, so a second row is appended. Across many sessions
with no reset, one plan accumulated 347 of them.

### And the context block gave no way to check

`activePlanContextBlock()` injected the title and steps, asserted the block was
*"authoritative"* — and included **no plan id and no file path**. It also
renumbered sub-tasks positionally (`i+1.j+1`), discarding the model's own
`[7.14.x]` tags, so the context and the file did not even agree on identifiers.
Asked to verify, the model had to scan 303 plan files, missed the one it wanted,
and inferred absence.

## Decision

### 1. `sameWork` — stop appending reworded duplicates

`PlanTextMatch.sameWork` extends `matches` with a **40-character shared-prefix**
rule, trusted only when both strings exceed the threshold. Genuinely different
items in this codebase diverge early ("Milestone 2: wire ActivityController…"
vs "…TreatmentController…" share 18 characters); a restatement keeps a long
identical head. `mergeSubtasks` now matches on `sameWork`.

Validated against the real file: **347 bullets collapse to 277 (70 merged)**,
and the four *least* similar prefix-merges (similarity 0.46–0.55) were each
manually confirmed to be the same item restated — the threshold does not
over-merge on real data.

### 2. `dedupeSubtasks` — repair plans already corrupted

Run on every `reconcile`, so an existing bad plan heals in place. Idempotent, so
a clean plan pays only the comparison. Semantics chosen deliberately:

- **Order preserved** — a self-reordering checklist is unreadable.
- **Last statement wins for status.** With 7 bullets both checked and unchecked,
  preferring "completed" would mark undone work done — the failure that actually
  misleads a reader. The most recent statement wins instead.
- **Richest wording kept** — restatements shorten and drop evidence ("— 41/41
  green"); keep the longer text.
- **Keys are authoritative** — two rows sharing a key are one row.

### 3. Provenance in the injected block

The active-plan block now carries `id:` and `source: <path>`, and instructs the
model that if the block disagrees with what it can find on disk, it must read
the named source file before concluding anything. Verification becomes one read
instead of a 303-file scan.

### 4. "I could not find it" is not "it does not exist"

A new firm surface in `personality.ts`. Before asserting that something does not
exist, was never done, or was fabricated, MARVIN MUST: resolve by identity
rather than by scanning (the block names the id and path); search at least two
ways; and state where it looked rather than only the verdict. It MUST NOT use
*fabricated* / *invented* / *hallucinated* / *never happened* about the user's
project history without positively establishing the negative, nor treat its own
failure to locate a file as evidence the file is fake.

The sanctioned honest form: *"I could not find X — here is where I looked. It
may exist somewhere I did not check."*

## Scope of Done

- [x] `sameWork` added; `mergeSubtasks` no longer appends reworded duplicates.
- [x] `dedupeSubtasks` repairs existing plans on reconcile; order-preserving,
      idempotent, last-status-wins.
- [x] Active-plan context block carries `id` + `source:` path.
- [x] Negative-claim discipline added to `personality.ts`.
- [x] 8 new Swift tests over the real corrupted strings, incl. the
      over-merge guards; 185 assertions pass, `swift build` clean.
- [x] 710 TS tests, 8/8 typecheck.

## Consequences

**Good.** The injected checklist becomes internally consistent, so the condition
that triggered the false accusation stops occurring. When a model does come up
empty it now says so honestly instead of escalating to fabrication.

**Risk.** Prefix matching *can* over-merge in principle. It was validated only
against this one corpus; the threshold is a constant (`sameWorkPrefix = 40`) so
it can be raised if a false merge is ever observed. A false merge is not silent
— it collapses two checklist rows into one, which is visible in the plan UI.

**Correction (2026-08-17, same day).** This ADR originally said "the plan never
resets between sessions, which is *why* it had room to grow to 347 bullets", and
proposed a session boundary as the structural fix. **That was wrong**, and the
claim was made without checking. Measured afterwards:

- Exactly **one** plan-state file contains this plan (`530c70c6…plans.json`,
  336 sub-tasks). No other session holds it.
- That session spans **2026-08-15 08:23 → 2026-08-17 17:05 — 57 hours**.

The accumulation happened **inside a single chat thread**, not across sessions.
A session-boundary reset would have prevented none of it, and would trade this
bug for a worse one: long-lived plans are a real use case, and it is precisely
that 57 hours of retained context which let the work resume coherently at all.

(Terminology, since it was being used loosely: `marvinSessionId` is the chat
thread — transcript `<projectId>/<id>.jsonl` plus `<id>.plans.json`; the SDK's
`sessionId` is a separate resume handle; and the plan **file**
`.marvin/plans/<slug>.md` is per-**project**, keyed by title slug and rewritten
from state rather than appended to.)

### Addendum — collapse completed sub-tasks in the injected block

The real cost is not storage, it is what the model is shown every turn. On the
same plan: 20 steps, **336 sub-tasks, 61 % already completed**, rendered in full
into **every single turn**:

| | chars | ~tokens/turn |
|---|---|---|
| Before | 36,694 | 9,173 |
| After | 16,294 | 4,073 |
| **Saved** | **56 %** | **~5,100 every turn** |

~5,100 tokens per turn restating finished work — and that pile is not inert, it
is exactly what the model mis-read when it produced the false fabrication claim.
Completed items carry no information about what to do next, which is the only
question this block exists to answer.

So `PlanContextBlock.render` (moved into MARVINLogic so it is testable at all —
it previously lived as a closure inside `ChatPreviewView` with no coverage)
collapses a step's completed sub-tasks into `N of M sub-tasks complete` once
there are more than `collapseThreshold = 3`. Below that, showing them costs
little and reads better than a summary.

Two invariants, both tested:
- **Original numbering is preserved** after omission. Renumbering would move the
  model's own reference points and make the block disagree with the file it
  cites.
- **Omission can never read as "not done"** — the header states that a
  summarised item IS done, must not be redone, and that the source file holds
  the detail.

Nothing is lost: the plan file, the plan state and the UI still carry every
sub-task. Only what the model sees is condensed.

### Addendum 2 — a plan you FOUND is not a plan you are ON

2026-08-17, same day. A **brand-new session** (no `.plans.json`, no injected
plan context — verified) was asked an unrelated question about Mailpit. During
discovery it read `.marvin/plans/production-ready-enrollment-email-dns-silent-failure-fix-e2e.md`
off disk, saw open steps, and offered: *"Want me to resume that plan at step 7?"*

Nothing malfunctioned. The plan is real, step 7 (`End-to-end prod verification
on a demo tenant`) is genuinely unchecked, and MARVIN cited the path rather than
claiming it was the session's active plan. But the file was last modified
**Jul 28 — three weeks earlier** — and it was described as *"an in-flight plan"*.

Two facts collide here:

1. **`.marvin/plans/` is a per-project archive.** Plan *state* resets with a new
   chat; plan *files* never do. That project holds **303** of them, any of which
   can surface in a file read, in any session, indefinitely.
2. **`Read` does not surface mtime.** So unchecked boxes are the only signal a
   reader has — and unchecked means "never finished", not "still current".

Fixed two ways, because the 303 existing files cannot be retro-stamped:

- **New writes carry a freshness trailer.** `PlanFile.stamped` appends
  `<!-- marvin:plan-updated YYYY-MM-DD -->` plus a line stating that unchecked
  boxes do not imply the plan is active. Any future reader gets the date for
  free, with no extra tool call.

  The load-bearing detail is change detection: `persistAndOpenPlan` compares
  **stripped** bodies. Comparing raw text would rewrite the file on every save
  because the date differs, making every plan look freshly touched and
  destroying the exact signal the stamp exists to create. `stripStamp` is also
  idempotent and a no-op on unstamped legacy files.

- **A prompt rule covers everything already on disk.** A discovered plan must be
  described with its age, must not be called "in-flight"/"active"/"current" on
  the strength of unchecked boxes, and resuming it is offered rather than
  assumed.

Six tests pin the stamp, including the two that matter: same body + different
date compares equal, and a real progress change still compares different.

**Still unaddressed:** the context block renumbers sub-tasks positionally rather
than carrying the model's `[7.14.x]` tags, so ids in the block and in the file
still differ. Provenance makes that survivable — the file is now findable — but
it remains a real inconsistency. And a 336-sub-task plan is arguably not one
plan; a size guard that suggests splitting or closing out finished steps is the
remaining structural idea, now that "reset per session" has been ruled out.

### Addendum 3 (2026-08-19) — the model and the UI disagreed on what a "step" is

MARVIN reported *"[Phase 7 · Verify] Plan complete — all 6 top-level steps (and
sub-tasks) verified done"* while the plan strip on the same plan showed
**"1/12 · Paused"**. Both were right about different things, which is worse than
either being wrong: the model reads the plan FILE, the strip renders plan STATE,
and the two disagreed on the step count itself.

Cause: `PlanParser.stepRE` is `^\s*(?:\d+[.)]|[-*•])\s+…` — the leading `\s*`
matches **any indentation**, so every nested sub-bullet was promoted to a
top-level step. Measured on the real plan file:

| matcher | steps found |
|---|---|
| current (`^\s*`) | **66** |
| top-level only (`^`) | **6** |

The file has 6 numbered steps. The extra 60 were sub-bullets — "Sweep shape",
"Garage deletion", "decide deletion order" — each counted as a step of its own.

**Fixed** by counting steps with a top-level-anchored matcher in
`PlanParser.todos(from:)`, the one place steps are enumerated. Nested bullets are
sub-tasks and are nested by tag (ADR-0049), never promoted.

Two deliberate constraints:

- **`PlanFile.render` is untouched.** Its checkbox overlay legitimately marks
  nested lines, and it shares `stepText(of:)`. Only step *counting* changed, so
  sub-bullets keep their checkboxes.
- **A fallback preserves indented plans.** If the strict pass finds zero steps
  (a plan that indents everything), the lenient matcher is retried — parsing to
  zero steps would be a worse failure than over-counting.

Also visible in the same file, and NOT fixed here: the plan had accumulated the
same sub-task block four or five times over, which is the accumulation this ADR
opened. De-duplication runs on `reconcile`; the FILE render appends unmatched
steps at the end, so a file can still collect repeats independently of state.

#### Addendum 3, parts (a) and (b) — the file echo, and repairing existing state

**(a) `PlanFile.render` echoed every sub-task.** It injects a step's reconciled
sub-tasks under the step's line *and* let the model's own nested bullets for the
same items pass through from `plan.text`. Both copies landed in the saved file —
9 redundant checkbox lines in one real plan, far more in others.

The injected copy wins: it carries the reconciled status, while the echoed one is
frozen at whatever the model last typed. Suppression is restricted to **indented**
source lines, so a top-level step whose text happens to match a sub-task name can
never be swallowed (tested).

**(b) `PlanProgress.redriveSteps` repairs state built by the old parser.** The
step-counting fix is prospective; a plan already in state keeps its inflated list
forever, which is why the strip read "1/12" for a 6-step plan. Now applied at
hydration.

It is **lossless by construction**: stored steps are in document order, so a
stored entry that is not a top-level step must have been nested under the last
real step before it — that is exactly where it is put back, keeping its status.
Completed work changes level, not existence. A plan whose counts already agree is
returned untouched, and a text with no parseable markers falls back rather than
wiping the plan.

Verified against the real state file: `stored steps: 12 · top-level in text: 6 →
REPAIR`, and healthy plans report `leave untouched`.

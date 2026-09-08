# ADR-0106 — Plan spine: snapshot semantics for sub-tasks, a `superseded` status, a lenient tag grammar, and a bucket-free re-base guard

- **Status:** Accepted — implemented 2026-09-08
- **Date:** 2026-09-08
- **Related:** [ADR-0046](./0046-plan-as-durable-spine.md) (plan as durable spine; `TodoWrite` is a full-list rewrite), [ADR-0049](./0049-plan-step-join-key-and-rollup.md) (`[N]`/`[N.M]` join keys; the hard completion invariant this ADR narrows), [ADR-0051](./0051-plan-in-context-injection.md) (the block that told the model the plan was still open), [ADR-0052](./0052-durable-plan-spine-and-plan-file-ownership.md) (the re-base guard this ADR corrects), [ADR-0057](./0057-reconcile-before-close-guard.md) (reconcile-before-close), [ADR-0068](./0068-plan-dedup-context-provenance-negative-claims.md) (append-only merge + de-dup)
- **Touches:** `macos/MARVINLogic/PlanModel.swift` (`PlanTag`, `PlanProgress.reconcile`, `PlanFile.render`, stamp), `macos/MARVINLogic/PlanReconcileGuard.swift` (`PlanTextMatch.related`, guard signature 3), `macos/MARVINLogic/PlanContextBlock.swift`, `macos/MARVIN/TodoListView.swift`, `macos/MARVIN/PlansPanel.swift`, `sidecar/packages/runtime/src/personality.ts` (close-out discipline), `macos/MARVINTests/main.swift` (4 new suites, 1 amended test)

## Context

> "for some reason, plan is not updated when marvin is working on it."

The user showed a finished agri-saas session: MR !203 merged, `v1.1.75` tagged
and live in production, MARVIN itself saying *"the plan is complete … not
redoing any verification"* — and the plan strip reading **Paused — 5/9 steps
done · Next: Triaging and fixing red main**. Step 1 (the red-main triage,
merged as `d9093a11` and tagged `v1.1.74` the previous evening) showed
in-progress; steps 5 and 8 and the "Additional work" bucket showed open.

**Measured before touching code.** The transcript
(`274dfac9-3abb-4c52-a4ad-d24e8895aee9.jsonl`) holds **24 `TodoWrite` calls**.
The model did its part: `[1] … completed` appears in the last five batches, the
final batch (14:12:04Z) is six rows, every one `completed`. The stored spine
(`…plans.json`) showed why none of it landed. Three rules, each individually
correct, interlocked:

1. **Append-only merge × hard invariant = permanent veto.** `mergeSubtasks`
   (ADR-0046/0068) updates or appends, never retires. ADR-0049's addendum makes
   a step `completed` *iff every sub-task is completed*. Early in the session the
   model decomposed step 1 into `[1.5]`…`[1.8]` and then — as the work moved —
   into `[1.5a]`…`[1.7c]`; later batches replaced those with summary rows and
   never re-listed them. Step 1 therefore carried **eleven open rows from a
   superseded decomposition**, and `[1] completed` was overridden by the roll-up
   in five consecutive batches. Step 5 (rows `5.1`–`5.5` from before the feature
   shipped as one MR), step 8 (`8.3`, replaced by `[9]`) and the bucket
   (`[8.1c]`) were stuck the same way. This is the exact inverse of the
   ADR-0049 bug: there, a parent over-claimed while its rows were open; here,
   rows the model had *stopped tracking* kept a finished parent open forever.
2. **The re-base guard mis-read the honest close-out.** The 12:33 batch tagged
   `[1]`…`[8]` against an 8-step plan. But the spine had grown a synthetic
   "Additional work" bucket, so the guard saw *K = 8 ≠ 9 steps* (ADR-0052
   signature 2), and signature 3's whole-string containment found no overlap
   between "Cheap wins (commit 9b6399e8)" and a forty-word step. All eight tags
   were stripped and the eight completions were **nested as sub-tasks under
   step 1** — visible in the stored state as unkeyed rows "ADR-0379 authored…",
   "Cheap wins…", "Ship: …" beneath the triage step.
3. **The tag grammar rejected what the model wrote.** `[3-8]`, `[2-8]`,
   `[8.1a]`…`[8.1e]`, `[1.5a]`…`[1.7c]` all failed `^\[(\d+)(?:\.(\d+))?\]` and
   fell to the content backstop, which nested them under whichever step was
   first in progress — `[3-8] Full legal-surface feature…` ended up under
   step 5.

The ADR-0051 block then told the model, every turn, that steps 1/5/8 were open;
the model (correctly) disagreed with the block, said so, and stopped. The
personality already forbids partial lists and re-based numbering (ADR-0046,
ADR-0052) and the model still did both — so a prompt-only fix is not a fix.

## Decision

**1. Snapshot semantics for sub-tasks.** `TodoWrite` is a full-list rewrite:
every call carries every live item (ADR-0046, enforced in the prompt). The
reconcile now takes that contract seriously in one narrow place — **when a
batch explicitly closes step N (`[N]` completed, by tag, range, or content
match), a sub-task of N that the same batch no longer lists is marked
`superseded`.** Never `completed` (it was not done — a tick would be a false
claim), never deleted (the file keeps the evidence of what was dropped). A
sub-task the closing batch *does* still list as open keeps its veto: that is
ADR-0049's over-claim case, unchanged. Nothing is superseded by a batch that
does not close the parent.

**2. `superseded` is a fourth sub-task status.** Roll-up: a step is `completed`
iff every sub-task is *closed* (completed or superseded) **and** either some
sub-task actually completed or the model closed the parent; a step whose rows
are all superseded with nothing completed and no close from the model stays
where it was. Rendering: `[-]` in the plan file (Obsidian's "cancelled"
convention; `completedStepIds` reads only `[x]`, so it can never be recovered
as done), `[-]` in the ADR-0051 block (collapsed with the completed rows, and
counted separately: "3 of 5 sub-tasks complete, 2 superseded"), struck through
with a `minus.circle` icon in the strip and the Plans panel. The file's
freshness trailer explains the glyph.

**3. Lenient tag grammar.** `PlanTag` accepts `[N]`, `[N-M]` (every step in the
range takes the row's status), `[N.M]`, and `[N.Ma]` / `[N.M.x]` (sub-keys are
strings now — `1.5a` and `1.5` are distinct rows). A descending range or a
range with a sub-key is not a tag. The prompt still asks for one `[N]` row per
step; the parser simply stops punishing the model for compressing.

**4. Bucket-free re-base guard, relatedness by token overlap.** The guard
(ADR-0052) is handed only the steps the model was *shown as a plan* — the
synthetic "Additional work" bucket is excluded from the count, so an honest
`[1]`…`[K]` against K real steps is a full-plan update and never guarded. Range
tags are not evidence of a re-base and are left out. Signature 3 uses a new
`PlanTextMatch.related`: whole-string containment *or* at least a third of the
shorter side's significant tokens (4+ chars) reappearing in the longer side.
Measured on the incident batch: 6 of 8 close-out summaries relate to their
steps (the two misses are "ADR-0379 authored, critiqued, approved" and "SPA
acceptance gate", which share no 4-letter token with their steps); the
2026-07-02 foreign list still shares nothing and is still distrusted.

**5. The prompt gets one paragraph** ("Closing a step"): emit `[N]` completed
and carry its `[N.M]` rows to completed; one tagged row per step, no ranges or
untagged summaries; a row you stop listing while closing its step is recorded
as superseded, so drop only what genuinely no longer applies.

### What was considered and rejected

- **Deleting dropped rows.** Loses the record of what the model decided not to
  do, which is exactly what an auditor of a "done" plan needs to see.
- **Marking dropped rows `completed`.** The ADR-0049 addendum exists because a
  false tick misleads worse than an unticked box. Same principle, same answer.
- **Ignoring the model's `[N] completed` when rows are open (the status quo).**
  Observed cost: a shipped, deployed plan frozen at 5/9 for a working day, the
  strip offering "Continue" on merged work, and the model arguing with its own
  plan block. The residual risk this ADR accepts — a model that silently drops
  open rows while claiming done — is a *dishonesty* problem the prompt and the
  ADR-0057/0059 guards own; the client cannot tell it from legitimate
  re-scoping, and freezing every re-scope to catch it was the worse trade.
- **Prompt-only fix.** The prompt already forbade the two behaviours that
  triggered this. A rule the parser cannot survive being broken is not a rail.
- **Migrating the spine to `TaskCreate`/`TaskUpdate` ids** (ADR-0073's
  deferred option). Retires the whole bug class, but is a non-neutral contract
  change to the sidecar pins and every reconcile path; deliberately separate.

## Consequences

- Stored plan state gains a status value (`"superseded"`) on sub-task rows.
  Older builds render it with the default (open) glyph and treat it as open in
  the roll-up — they degrade to today's behaviour, nothing corrupts.
- The 2026-09-08 plan needs one more `TodoWrite` from the model — or a one-off
  state repair — to advance; the fix is prospective by construction.
- `PlanTag.parse`'s `sub` is `String?` (was `Int?`). Its only callers are inside
  `PlanModel.swift` and the tests.

## Verification

- `swift run MARVINTests`: **686 assertions, 0 failures.** New suites
  `plan-tag-grammar` (4), `plan-rebase-guard-adr-0106` (2), `plan-supersession`
  (7, including a verbatim replay of the 14:12:04Z batch against the stored
  9-step state: 5/9 → **9/9**, four stale rows under step 1 superseded, the two
  listed rows completed, step 5's dropped decomposition superseded, `8.3`
  superseded via `[2-8]`, the bucket row superseded via `[9]`, no step added or
  erased), `plan-superseded-rendering` (2). The ADR-0049 invariant test now
  states its real scenario (open row *listed* in the closing batch → parent
  stays in progress) and still passes.
- `tsc --noEmit` on `packages/runtime`: clean.
- All pre-existing plan suites (rebase guard, reconcile, dedupe, context block,
  file stamp, step counting, re-derive) unchanged and green.

## Scope of Done

- [x] Root cause measured from the transcript and stored spine, not inferred
- [x] Supersession pass + narrowed roll-up, with the ADR-0049 listed-open case preserved
- [x] `[N-M]` and suffixed sub-keys parse; ranges close every spanned step
- [x] Guard excludes the bucket; relatedness by token overlap; 2026-07-02 case still caught
- [x] `[-]` rendering in file, context block, strip, Plans panel; trailer legend
- [x] Prompt paragraph on closing a step
- [x] Replay test of the incident batch reaches 9/9
- [ ] The incident plan itself reads 9/9 in the running app (needs the rebuilt app installed — see roadmap)

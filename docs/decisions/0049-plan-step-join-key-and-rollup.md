# ADR-0049 — Plan-step join key + subtask roll-up: link tasks to the plan by tag, not by fuzzy text

- Status: accepted
- Date: 2026-06-23

## Context

ADR-0046 made the plan the durable spine: a presented plan seeds `Plan.steps`,
and each execution-turn `TodoWrite` is *reconciled into* those steps instead of
clobbering them. The linkage between a `TodoWrite` item and the plan step it
belongs to was **fuzzy content matching** (`PlanProgress.matches` — normalized
equality, else substring containment with a length guard). ADR-0046 itself
flagged this as the accepted trade-off: "a step the model rephrases heavily may
land as a sub-task rather than updating its step in place."

In practice that trade-off was the bug. Two user-reported symptoms trace to it:

1. **Tasks don't link to the plan's action items.** The model authors the plan
   as prose in one turn, then re-emits the steps as `TodoWrite` items *from
   memory* in a later turn — paraphrasing, splitting, or merging them. Any
   divergence fails `matches()`, so the work lands as an orphan sub-task or an
   "Additional work" bucket instead of ticking the real step. The longer the
   turn runs (context drift / compaction), the more matches fail — hence "after
   a while".
2. **The plan never updates / never completes.** A step's status was set *only*
   when a `TodoWrite` item text-matched it; its nested sub-tasks completing did
   nothing to it (only the synthetic bucket derived status from its children).
   So the common path — real work lands as sub-tasks because it didn't match the
   step text, the sub-tasks all complete, **but the parent step never flips to
   done** — left the plan frozen with phantom open work.

A scan of how leading tools handle plan→tasks confirmed the diagnosis. None keep
two model-authored structures joined by fuzzy text: **Claude Code** collapses to
one flat todo list (no separate plan entity); **Cursor** shares the *same*
checkbox object between `plan.md` and chat; **Copilot Workspace** — the only true
two-level hierarchy — anchors every plan step to a concrete file as the **join
key**. The throughline: use a structural key, or collapse to one structure; never
reconstruct the link by string similarity.

The user chose the two-level hierarchy (plan steps → sub-tasks with roll-up,
"when the subtasks are completed we complete the main task"), so we need
Copilot's structural-join property, adapted to our tool surface.

## Decision

Introduce a **stable join key** carried in the `TodoWrite` item content, and add
**upward completion propagation**, keeping ADR-0046's fuzzy matcher only as a
backstop.

- **Tag = join key.** During plan execution the model prefixes each `TodoWrite`
  item with its plan-step tag: `[N]` is plan step N (1-based, in presentation
  order), `[N.M]` is the Mth sub-task of step N. The ordinal — not the prose —
  is the key, so the model may reword freely without breaking the link. We use a
  content tag rather than a new tool field because the SDK `TodoWrite` schema is
  fixed (`content` / `status` / `activeForm`); a tag needs no SDK change and
  degrades gracefully.
- **`reconcile` links by tag, then falls back.** `PlanTag.parse` extracts
  `(step, sub, text)` and strips the tag for display. `[N]` updates step N's
  status/activeForm in place; `[N.M]` nests as a keyed sub-task under step N
  (re-matched across writes by its `"N.M"` key, never duplicated on rephrase).
  An untagged or out-of-range item falls back to ADR-0046 content matching, then
  to nesting under the active step / an "Additional work" bucket — so a model
  that forgets to tag still never erases the plan.
- **Upward roll-up.** After reconciling, any step that owns sub-tasks has its
  status **derived** from them: all sub-tasks completed → the step completes;
  any in flight (or the parent already marked in_progress) → in_progress; else
  the model-set status stands. Steps with no sub-tasks keep their model-driven
  status. This is the "sub-tasks done → main task done" behaviour, and it folds
  in the old bucket-specific derivation as one uniform rule.
- **Completion still over top-level steps only (ADR-0046 preserved).** "Plan
  complete" is computed over `Plan.steps`, never over sub-tasks, so a
  sub-task-only list can't fire a false completion — the roll-up flips the
  *parent step*, which is the unit completion already counts.
- **Prompt contract.** The Plan-mode stanza in `personality.ts` and the
  `approvePlan()` execute instruction now teach the tagging contract + the
  auto-complete-on-sub-tasks rule, and keep ADR-0046's full-list carry-forward
  requirement. Tier-1 (no plan) `TodoWrite`s stay untagged; `applyTodoWrite`
  strips any stray tag from them defensively.

## Consequences

- Positive: tasks link to the right plan step deterministically even when the
  model rewords; the plan advances and completes as work is done; the
  fuzzy-match drift class (symptom 1) and the frozen-plan class (symptom 2) are
  both closed. The fuzzy matcher remains as a silent backstop, so a mis-tagged
  or untagged turn degrades to ADR-0046 behaviour rather than regressing.
- Negative / trade-offs: the model must emit the tag — a turn that ignores the
  contract loses the deterministic link and falls back to fuzzy. The tag is a
  positional ordinal, so heavily reordering a plan mid-execution (without
  re-presenting it) could misalign tags; re-presenting the plan (a revision)
  re-seeds the ordinals and is the supported path. The ordinal lives only in the
  emitted content, not in a persisted per-step UUID — acceptable because the
  plan's step order *is* the durable identity.
- The roll-up means a step the model explicitly marked `[N] completed` while it
  still has incomplete sub-tasks is shown in_progress (the sub-tasks win). This
  is intentional integrity, matching the user's stated model.

## Alternatives considered

- **Collapse to one flat list (Claude Code model).** Rejected for this product:
  the user explicitly wants the two-level plan→sub-task hierarchy with roll-up,
  which a flat list doesn't express.
- **New custom tool with `id`/`parentId` fields.** Rejected as heavier than
  needed: it means registering an SDK tool, retraining the model off the
  well-worn `TodoWrite` habit, and changing the macOS extractor — for no gain
  over a parseable content tag, which the model already produces reliably for
  numbered work.
- **Persist a per-step UUID and surface it to the model.** Deferred: positional
  ordinals are stable enough given that re-ordering goes through a plan
  revision, and they're far cheaper to thread through the prompt than opaque
  IDs the model must copy verbatim.

## Scope of Done

- [x] `[N]` / `[N.M]` tags are the join key; `reconcile` links by ordinal, with
      ADR-0046 fuzzy matching retained only as the untagged backstop.
- [x] `[N.M]` sub-tasks nest under step N and re-match by `"N.M"` key across
      successive `TodoWrite`s (no duplicate rows on rephrase).
- [x] A step with sub-tasks auto-completes when all of them complete, shows
      in_progress while partial — verified by a standalone logic test
      (`/tmp/plan_test.swift`, 11 assertions).
- [x] Tags stripped from displayed content on both tiers (strip + tier-1
      `applyTodoWrite`).
- [x] `personality.ts` + `approvePlan()` teach the tagging contract + roll-up
      rule; full-list carry-forward preserved.
- [x] `swift build` clean; runtime `personality.ts` typechecks clean (the only
      `tsc` errors are a pre-existing `readonly []` fixture-type issue in
      `tests/can-use-tool-dispatch.test.ts`, untouched by this change).

## Related

- Files: `macos/MARVIN/TodoListView.swift` (`TodoItem.key`, `PlanTag`,
  `PlanProgress.reconcile` / `mergeSubtasks`), `macos/MARVIN/ChatPreviewView.swift`
  (`applyTodoWrite`, `approvePlan`), `sidecar/packages/runtime/src/personality.ts`.
- Supersedes / superseded by: revises ADR-0046 (plan as the durable spine) —
  replaces its fuzzy-only join with a tag join key + adds upward roll-up.

## Addendum — 2026-06-25: a step with sub-tasks can't complete while any sub-task is open

**Symptom.** A plan step (step [10], "Operator console panel") showed **completed**
(green ✓, struck through) while all eight of its DoD/Tests/Docs/Verify sub-items
were still unchecked — an action item "finished" with its sub-tasks undone.

**Root cause.** The original roll-up handled "all sub-tasks done → complete" and
"some activity → in_progress", but had an implicit `else` that left the
**model-set** status untouched. So when the model emitted `[10] completed` while
every `[10.x]` sub-task was still `pending`, neither branch fired: not all
complete (false), no sub-task in_progress/completed and the parent wasn't
in_progress (it was *completed*) — so the parent kept its model-declared
"completed". The roll-up could downgrade a parent on *partial* progress but not
when the model over-claimed completion over all-pending sub-tasks.

**Fix.** Make completion a hard invariant: a step that owns sub-tasks is
`completed` **iff every sub-task is completed**. Otherwise it's `in_progress`
when there's any activity (a sub-task started/done, or the model marked the
parent in_progress/completed) and `pending` when nothing has started. A parent
can no longer read as done while a leaf is open, regardless of what the model
declares for the parent — the sub-tasks ARE the remaining work.

**Verified.** Standalone test: `[1] completed` + `[1.1]/[1.2] pending` →
parent `in_progress` (not completed); once both sub-tasks complete → parent
completes; a leaf step with no sub-tasks still completes on the model's signal.
`swift build` clean.

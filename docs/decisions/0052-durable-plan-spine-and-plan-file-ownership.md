# ADR-0052 — Durable plan spine, plan-file ownership, and the re-base guard

**Status:** Accepted — 2026-07-02
**Touches:** `runtime/plan-state.ts` (new), `/api/sessions/plans` (new),
`runtime/sdk-runner.ts` (`classifyToolCall`), `runtime/personality.ts`
(plan-authoring contract), `macos/MARVINLogic/PlanReconcileGuard.swift`
(new), `macos/MARVIN/PlanStateService.swift` (new),
`macos/MARVIN/ChatPreviewView.swift`, `macos/MARVIN/TodoListView.swift`.
Revises the durability story of [ADR-0046](./0046-plan-as-durable-spine.md),
closes an [ADR-0048](./0048-full-session-history-tail-first.md) interaction,
hardens [ADR-0049](./0049-plan-step-join-key-and-rollup.md)'s join key.

## Context

A production session (2026-07-02, ~33 MB transcript, a full working day on
one plan) surfaced four interacting failures in the plan-tracking spine:

1. **Agent-mode plans never entered the spine.** The live adoption gate
   required `mode == "plan"`. A user saying *"add to a plan the rest of the
   13 items and let's start working"* in Agent mode got a plan **file**
   written by the model via the Write tool — with a model-invented
   filename, no spine entry, no checkbox overlays ever, no ADR-0051
   plan-context injection. The model then hand-`Edit`ed the file when told
   to "update the plan." The app tracked a *different*, older plan the
   whole time.
2. **Chat switch / relaunch silently dropped long plans.** `hydrate` is
   tail-capped at 200 events (ADR-0048); plan reconstruction scraped the
   transcript for the last `# Plan` reply. A plan presented hours earlier
   was outside the tail → `resetSessionStrips()` had already cleared the
   in-memory spine → `activePlanId = nil` → every subsequent `TodoWrite`
   fell to the tier-1 branch. Observed: the strip degraded to a bare "Task
   list," the plan file froze at 11:12, and no plan file was re-persisted
   for the rest of the day while TodoWrites flowed until 18:56.
3. **Ordinal-only join keys corrupted whichever plan WAS active.** The
   `[N]` tag carries no plan identity. After interruptions the model
   re-based its numbering to its private working list (`[19]…` one turn,
   `[1]…[18]` for 18 micro-tasks the next); reconciling those against the
   active plan overwrote steps 1..N's statuses with unrelated work.
4. **Replay's ingest was mode-ungated while live ingest was mode-gated** —
   the same `# Plan` reply was adopted or ignored depending on whether a
   rehydrate happened to run.

## Decision

Four coordinated changes:

1. **Adopt `# Plan — <title>` replies into the spine in every mode.** The
   live gate drops its `mode == "plan"` requirement for *adoption*;
   `planAwaitingApproval` (the approve-and-execute chip) remains plan-mode
   only — Agent mode is already executing, so there is no read-only/execute
   boundary to approve across. Live and replay paths now share one rule.
2. **The plan spine is server-persisted per session.** The client PUTs
   `{plans, activePlanId}` (debounced 500 ms) on every spine mutation to
   `PUT /api/sessions/plans`; `hydrate` GETs it back and treats it as
   authoritative over transcript scraping, which remains only as a
   fallback for pre-ADR-0052 sessions. State lives next to the transcript
   (`<dataDir>/sessions/<projectId>/<sessionId>.plans.json`, atomic write,
   256 KB cap, path-traversal-safe ids). `clearPlans()` stays in-memory
   only — switching away and back restores the plan.
3. **`.marvin/plans/` is app-owned — the gate enforces it.**
   `classifyToolCall` denies model Write/Edit/NotebookEdit targeting
   `.marvin/plans/`, and mutating Bash shapes (`>`/`>>`, `tee`, `sed -i`,
   `rm`, `mv`, `cp`, `truncate`) referencing it; reads stay allowed. The
   deny reason steers the model to the contract, which `personality.ts` now
   states firmly: present/revise plans as `# Plan` replies, record progress
   via tagged `TodoWrite`, never touch the file. Tag numbers always refer
   to the ACTIVE plan's presented step numbers; finer-grained work is
   `[N.M]` sub-tasks, never a re-based top-level list.
4. **A batch-level re-base guard protects the join.**
   `PlanRebaseGuard.looksRebased` (MARVINLogic, test-covered) distrusts a
   batch's `[N]` tags only when all three signatures hold: ≥3 tagged items,
   tags exactly `1..K` consecutive, `K ≠` plan step count, and ≤⅓ of tagged
   texts match the steps they address. Distrusted tags are stripped and the
   batch routes through the ADR-0046 content backstop (match → update,
   else nest) — work is captured, statuses aren't corrupted. Legitimate
   partial updates, full-plan rewordings (`K ==` step count), and scattered
   ordinals never trip it.

## Consequences

- Positive: a plan survives chat switches, app relaunches, and the
  200-event tail; agent-mode plan requests become tracked plans; the plan
  file can no longer fork from the spine (single writer); a re-based
  TodoWrite can no longer silently corrupt step statuses.
- Negative / trade-offs: one more per-session state file; a debounced PUT
  per spine mutation (a few KB, localhost); the re-base heuristic can in
  principle mis-classify a pathological-but-legitimate batch (bounded by
  its three-signature conservatism — and the failure mode is nesting, not
  loss).
- Follow-ups created: `sdkSessionFresh` still wipes the in-memory spine
  (ADR-0036 rule) — with durable state, a mid-plan SDK-session reset
  (e.g. post-compaction) could now *restore* instead; deferred, needs its
  own look. Tier-1 (plan-less) todos are deliberately not persisted.

## Alternatives considered

- **Scan the full transcript server-side for plan reconstruction** — keeps
  scraping as the source of truth; rejected: re-parses megabytes on every
  hydrate to recover state the client already had in structured form.
- **Plan identity inside the tag (`[P3:7]`)** — precise but changes the
  executor contract everywhere and still trusts the model to echo it;
  rejected in favor of a server-side-verifiable heuristic plus a firmer
  prompt contract.
- **Allow model writes to `.marvin/plans/` and re-ingest the file** — two
  writers, merge conflicts by construction; rejected.

## Scope of Done

- [x] Agent-mode `# Plan` reply is adopted (no approval chip); replay and
      live use the same rule.
- [x] `plan-state.ts` + `/api/sessions/plans` round-trip, id hygiene, size
      cap, corrupt-file fallback — vitest-covered (7 tests).
- [x] Client saves on every spine mutation (ingest / reconcile / select /
      dismiss) and restores on hydrate, authoritative over scrape.
- [x] Gate denies model mutations of `.marvin/plans/` (Edit/Write/
      NotebookEdit + mutating Bash), reads unaffected — vitest-covered
      (4 tests).
- [x] `personality.ts` plan-authoring firm surface (MUST `# Plan` reply /
      MUST-NOT write plan files / never re-base tags).
- [x] `PlanRebaseGuard` in MARVINLogic with the 2026-07-02 corruption as a
      regression test (7 tests, `swift run MARVINTests` green).
- [x] `swift build` clean; runtime `tsc` clean; dispatch + plan-state
      suites green.

## Related

- Files: `sidecar/packages/runtime/src/plan-state.ts`,
  `sidecar/src/app/api/sessions/plans/route.ts`,
  `macos/MARVINLogic/PlanReconcileGuard.swift`,
  `macos/MARVIN/PlanStateService.swift`
- Supersedes / superseded by: revises ADR-0046 (durability),
  ADR-0048 (interaction), ADR-0049 (join integrity)

# ADR-0051 — Plan-in-context: re-inject the active plan into the model every turn

- Status: accepted
- Date: 2026-06-25

## Context

ADR-0046/0049/0050 made the plan a durable, navigable UI spine: a strip
rehydrated from the transcript, a join-key roll-up, anchored resume. But all of
that is **UI state**. A grep of the runtime + chat route for any injection of the
active plan (`activePlan`, `currentPlanText`, `.marvin/plans`) returns nothing:
`buildProjectContext` injects project docs, ADR titles, memory, backlog, and the
graphify summary — **never the plan**. The saved `.marvin/plans/<slug>.md` file is
never read on the model side.

So the model only "knows" the plan if the original `# Plan` message + its
`TodoWrite`s survive in the resumed SDK conversation. They don't survive:
- a **chat switch** (a different session = a different conversation; `clearPlans()`
  fires and the new session never saw the plan), or
- **context compaction** (the lossy summary can drop the plan while the strip,
  rehydrated from the full transcript, still shows it).

Users hit exactly this: "MARVIN stopped tracking the plan", "I told it to continue
and it won't", "it still shows the plan but isn't aware of it." The strip and the
model's context had silently diverged.

Research (Anthropic's *Effective context engineering* and *Effective harnesses
for long-running agents*, Claude Code's own todo handling, Cursor/Cline) is
unanimous: **re-inject the live task/plan state every turn** rather than trusting
history — counting on history/compaction is the documented failure mode. Claude
Code does this via per-turn `<system-reminder>` blocks reflecting the live todo
list.

## Decision

Re-inject a compact, authoritative snapshot of the **active plan + live per-step
status** into the model's context **every turn**, as a `<system-reminder>` suffix
on the user turn.

- **Source of truth = the client's active plan.** The macOS app already owns
  exactly what the user sees (`activePlan` — title + steps + statuses +
  sub-tasks). `activePlanContextBlock()` renders it as a terse block (one line
  per step with `[x]`/`[~]`/`[ ]` glyphs + nested sub-tasks), marked authoritative
  ("supersedes earlier TodoWrite/tool statuses … a step is done only when all its
  sub-tasks are"). nil when no plan is active. It's sent as a new `planContext`
  field on the chat request — exactly mirroring how `playwrightEnabled` / `mode`
  are threaded.
- **Inject as a volatile message suffix, NOT the system prompt.** The runtime
  appends `\n\n<system-reminder>\n{planContext}\n</system-reminder>` to the SDK
  `query` prompt (`sdk-runner.ts`). Per Anthropic's prompt-caching rules the cache
  prefix is tools → system → messages and invalidation cascades from the first
  change; a status block that flips each step would bust the whole system prefix
  if placed there. The new user message is **already** the uncached tail, so the
  plan block riding on it costs nothing in cache terms. This is exactly Claude
  Code's pattern.
- **Never persisted.** The route persists `turn.user` with the **clean**
  `message` (untouched); `planContext` is appended to the SDK prompt only. So
  reloads show the clean message — no `<system-reminder>` leaks into the chat,
  no display strip needed.

## Consequences

- Positive: the model is plan-aware on **every** turn regardless of chat switch,
  compaction, or session reset — the strip and the model can no longer diverge.
  Closes the "MARVIN forgot/ignored the plan" class at the root, complementing the
  tracking (0049) and resume (0050) fixes. Cache-neutral and persistence-clean by
  construction.
- Negative / trade-offs: a small, intentionally-uncached block (tens to low-
  hundreds of tokens) is paid each turn while a plan is active — the right cost,
  paid in the right place. Duplicate-state risk (old `TodoWrite` blocks in history
  show stale statuses) is mitigated by marking the injected block authoritative
  and most-recent (recency wins). Wakeup/background-job turns don't carry a client
  `planContext` (no live UI), so they rely on history as before — acceptable, they
  aren't plan-execution turns.

## Alternatives considered

- **Inject into `buildProjectContext` / the system prompt.** Rejected: it's the
  cached prefix; a per-step-changing block there is the textbook cache anti-pattern
  (busts system + messages caching every progress turn).
- **Append to `body.message` client-side.** Rejected: `turn.user` persists
  `body.message`, so the `<system-reminder>` would leak into the reloaded chat
  bubble (would need a display strip). Threading a separate `planContext` field
  keeps persistence clean.
- **Runtime reads `.marvin/plans/`.** Rejected: that file is project-global and
  can't reliably identify *which* plan is active for *this* session. The client's
  `activePlan` matches the strip exactly.

## Scope of Done

- [x] `ChatRequest.planContext` (macOS) + `body.planContext` (route) +
      `DetachedTurnParams.planContext` + `RunAgentInput.planContext` threaded
      end-to-end, mirroring `playwrightEnabled`.
- [x] `activePlanContextBlock()` renders the active plan (title + `[x]/[~]/[ ]`
      steps + nested sub-tasks); nil when no plan is active.
- [x] Runtime appends it as a `<system-reminder>` suffix on the SDK prompt; the
      persisted `turn.user` message stays clean.
- [x] Injected on the user turn (uncached tail) — prompt-cache-safe; not in the
      system prefix.
- [x] `swift build` clean; runtime + sidecar `tsc` clean for touched files
      (pre-existing `can-use-tool-dispatch.test.ts` / `honeycomb-telemetry.test.ts`
      fixture errors are unrelated).

## Related

- Files: `macos/MARVIN/ChatPreviewView.swift` (`activePlanContextBlock`, send),
  `macos/MARVIN/ChatTypes.swift`, `sidecar/src/app/api/chat/route.ts`,
  `sidecar/src/lib/turn-orchestrator.ts`, `sidecar/packages/runtime/src/sdk-runner.ts`.
- Builds on: ADR-0046 (durable spine), ADR-0049 (join key + roll-up),
  ADR-0050 (resume anchoring). This is the missing half — model *awareness*, where
  those covered UI tracking.

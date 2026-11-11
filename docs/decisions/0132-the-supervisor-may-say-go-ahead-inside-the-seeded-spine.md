# ADR-0132 — The supervisor may say "go ahead" to a plan that stays inside the seeded spine

- **Status:** Proposed (2026-11-11)
- **Amends:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §6 (scope is human-only), by drawing its edge; it does not move it
- **Related:** [ADR-0124](./0124-shell-reads-worktree-graphs-and-a-seeded-plan-spine.md) (the seeded spine), [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (permission the plan already granted), [ADR-0036](./0036-ask-agent-plan-modes.md), [ADR-0130](./0130-a-session-says-what-it-is-waiting-on.md) (the `prose-question` item)
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md)

## Context

ADR-0127 §6 keeps "approving a plan, or changing a tab's DoD or scope" for the human, and catches it mechanically as the Plan → Agent posture change. That is right and stays.

What happened on a real project is a different act that reads the same. A tab in **Agent** mode, opened on a brief that carried its own checklist (so the sidecar seeded a `[1]…[N]` spine, `plan-seed.ts`), wrote a plan that restated those steps, listed what it would leave out, and ended "Shall I go ahead with step 1?". No posture change was pending. ADR-0067 calls this a stall: permission the plan already granted. It cost 25 minutes on 2026-11-11, and every one of the six go-aheads the external supervisor gave in two days was this case: "the brief is the plan".

A built-in supervisor under ADR-0127 has no clear answer. Its policy refuses text that names a human-only act, and "approve the plan" is one. So the largest observed stall is the one it may not clear.

## Decision

**Telling a tab to continue a plan it was already given is answering a question. Approving a new or wider plan is scope and stays human-only. The seeded spine is what tells them apart, mechanically.**

1. **The check.** A supervisor may answer a `prose-question` item (ADR-0130) or an `AskUserQuestion` with "go ahead" when all of these hold:
   - the session has a **seeded** spine (`plan.seeded` in the watch row): the user's own message carried the checklist;
   - the tab is in Agent mode and no posture change is pending;
   - every step the tab proposes joins a seeded step by its `[N]` tag, or is listed by the tab as *left out*; the sidecar does the join (the deterministic half of ADR-0116), and refuses what it cannot join rather than guessing;
   - the answer adds no step, no file area and no acceptance criterion.
2. **Anything else is an escalation**, as today: an unseeded plan, a step that does not join, a tab in Plan mode, a question that offers a wider option. The inbox item shows the tab's plan and which step failed the join.
3. **The verb.** `continue_plan`, delegable under `answer-questions`. Its message is fixed text ("Continue with the plan as you wrote it; the steps are the ones in your brief."), not model-written, so the supervisor cannot smuggle scope into it. Ledgered with the joined step ids.
4. **The stricter gate still applies** to the turn it starts (ADR-0127 §5).

## Consequences

- The commonest stall clears in seconds, and only where the user's own words already fixed the scope.
- A brief with no checklist gets no seeded spine and therefore no `continue_plan`. That is the intended pressure: write the steps down.
- The join is strict, so a tab that renumbers or merges steps will escalate. Accepted: a false escalation costs the user one click.

## Alternatives considered

- **Let the supervisor judge whether the plan is "within the brief".** A model deciding scope is what ADR-0127 §6 exists to prevent.
- **Tell tabs harder not to ask** (prompt text). ADR-0067 already does; the stall still happened, on the current model.
- **Auto-continue with no supervisor at all** when the spine joins. Attractive, and a possible next step once this has been measured in shadow; kept out here because it changes behaviour for users who have no supervisor.

## Open questions (recommended answer first)

1. Ship in shadow first? **Yes**: propose only, for one release, and report how many proposals the user would have accepted.
2. May `continue_plan` answer when the tab lists steps it will *leave out*? **Yes**: leaving out narrows scope; the left-out steps stay open on the spine and block the scope-met close as today.
3. Does a go-ahead count as the user's consent to anything later in the turn? **No** (ADR-0127: a supervisor message is never the user's consent).

## Scope of Done

- [ ] `continue_plan` is refused without a seeded spine, in Plan mode, with a pending posture change, and when any proposed step fails the `[N]` join (one test each).
- [ ] The message text is fixed; a test fails if a model-supplied string reaches it.
- [ ] The ledger records the joined step ids; the turn it starts runs behind the stricter gate.
- [ ] Shadow mode reports proposed vs accepted for a release before the category can be switched to act.

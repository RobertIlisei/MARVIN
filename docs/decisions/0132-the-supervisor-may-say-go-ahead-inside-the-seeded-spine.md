# ADR-0132 — The supervisor may say "go ahead" to a plan that stays inside the seeded spine

- **Status:** Accepted in part (2026-11-11): the Stop-hook rule under "Decisions" is built first; the `continue_plan` verb is **deferred** until that rule has been measured for one release. Build plan in [`docs/plans/supervision-improvements.md`](../plans/supervision-improvements.md)
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

## Decisions (2026-11-11, by the owner's delegation, after checking the text against the code)

1. **The third alternative above is built first, as a built-in rule, and widens nobody's authority.** The Stop hook (`turn-close-hook.ts`) already blocks a turn that stops with plan steps open, and lets an `asked` ending through. A new rule, `builtin:go-ahead`, blocks the close once when all of these hold: the tab is in Agent mode; the session has a seeded spine with open steps; the turn made no `AskUserQuestion` call; the final text is a go-ahead question ("Shall I go ahead with step 1?") and offers no alternative; and this turn's `TodoWrite`, if any, added no step that fails the `[N]` join to the seeded spine. The model then continues in the same request with the reason in front of it (ADR-0067: the brief is the plan). It ships at `nudge` (logged, not blocked), as ADR-0124's graph-pointer rule did, and is promoted to `deny` per project in the Practice pane. The objection recorded above, that it changes behaviour for users with no supervisor, is met by the tier: nothing changes until a user promotes it.
2. **`continue_plan` is deferred, not rejected.** After one release with the rule promoted on a real project, count the `prose-question` attention items (ADR-0130) raised on seeded tabs. If the stall is still common, build the verb with these two corrections to the text above:
   - "Every step the tab proposes" means that turn's `TodoWrite` batch. The sidecar's deterministic join (`applyTodosToSpine`) reads `TodoWrite`, and there is no prose plan parser on the sidecar. A turn with no `TodoWrite` escalates.
   - The verb gets its own autonomy category (`plan-continue`), so it can sit in shadow while the other categories are autonomous. The existing categories are `questions`, `nudges`, `posture` and `confirms`.
3. The three open questions keep their recommended answers for when the verb is built.

The Scope of Done below is the deferred verb's. The rule's Scope of Done is milestone 4 of the build plan.

## Scope of Done

- [ ] `continue_plan` is refused without a seeded spine, in Plan mode, with a pending posture change, and when any proposed step fails the `[N]` join (one test each).
- [ ] The message text is fixed; a test fails if a model-supplied string reaches it.
- [ ] The ledger records the joined step ids; the turn it starts runs behind the stricter gate.
- [ ] Shadow mode reports proposed vs accepted for a release before the category can be switched to act.

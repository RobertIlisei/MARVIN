# ADR-0138: The skills a brief names are recorded and checked when the tab closes its scope

- **Status:** Accepted (2026-11-24)
- **Extends:** [ADR-0104](./0104-ship-review-gate.md) (the two review skills become one case of "any skill"), [ADR-0124](./0124-shell-reads-worktree-graphs-and-a-seeded-plan-spine.md) (a brief seeds state before the first tool call)
- **Related:** [ADR-0105](./0105-practice-loop.md), [ADR-0135](./0135-the-ship-review-gate-does-not-lift-on-a-boundary-path.md), [ADR-0137](./0137-the-backlog-is-checked-when-a-tab-closes-its-scope.md)

## Context

Measured on one real project over three days: 95 tabs named skills in their brief (a line such as ``Skills: `ponytail` (full), `ponytail-review`, `test-driven-development` ``) and closed scope met. Only 3 of the 95 ran every skill they named. Per skill: `ponytail` 12 of 95, `ponytail-review` 22 of 95, `test-driven-development` 7 of 82, `webapp-testing` 0 of 12, `systematic-debugging` 0 of 9. The only two skills above 60 % were `pr-review` (60 of 90) and `security-audit` (22 of 36), and they are the two that ADR-0104 enforces at `git commit`. What is asked for in prose alone is mostly ignored, which is the repo's standing finding.

Four things stopped MARVIN from enforcing the rest, each checked in the code:

1. `recordAllowedTool` recorded a `Skill` run only for `pr-review` and `security-audit`, and the practice rule field `requireSkillThisSession` read that same record, so a row that required any other skill could never be discharged.
2. A practice rule trigger had `boundaryPaths` but no path condition of its own, so "a commit touching these paths needs skill X" could not be a row.
3. Nothing read a brief's `Skills:` line. The plan seed reads steps only, and the turn-close hook had no skills check.
4. Plugin skills arrive namespaced (`ponytail:ponytail`, `marvin-project-local:ponytail-review`), so a name compared whole never matches the name the brief wrote.

## Decision

**Record every skill run; let a rule row require any skill on any paths; and read the brief's skill list at a scope-met close. No skill name and no project knowledge is in MARVIN: the list is whatever the brief or the row says.**

1. **Every `Skill` call is recorded**, per session checkout (`sessionCwd`), under its name normalised to the last `:` segment, lower case, with the `{seq, turnId}` mark the review skills already had. For a skill other than `pr-review` and `security-audit`, "this session" means once is enough. The two review skills keep ADR-0104's freshness rule exactly: a review older than the last commit does not cover a later turn. The names also go to the session meta (`skillsRun`), and each turn restores the in-memory record from it, so a session resumed after a MARVIN restart does not forget what ran. Review skills are not restored, because their freshness depends on commit order, which the restart also forgot.
2. **A rule row gains `trigger.paths`**: globs matched against the files of the commit's own diff (`collectCommitDiff` on the session's checkout). `**` crosses directories, `*` and `?` stay inside one, a plain directory matches everything under it, a pattern with no `/` matches the file name at any depth. The matcher is a small tested module (`path-glob.ts`); the repo had none. The rules file is user data, so `readRules` clamps `paths` (at most 20, each at most 200 characters, no NUL) and `requireSkillThisSession` (at most 10 valid skill names), and a list that holds nothing valid makes the rule never fire rather than widening it. A deny keeps ADR-0104's brake (two a turn, then allowed and counted) and ADR-0135 is untouched: that amendment applies to the built-in ship-review gate, which is a different code path. `POST /api/practice/rules { create: { skills, paths?, tier?, title?, message? } }` makes such a row; the trigger is built server side, so the route cannot plant a regex.
3. **The brief seeds a skill list.** When the session's first user message carries a `Skills:` line, a bold `**Skills:**` label, or a `## Skills` heading followed by a list, the sidecar records the names on the session meta before the model's first tool call (`seedTurnSkills`, next to `seedTurnSpine`). Names must be in backticks; parenthesised notes such as `(full)` are dropped; wakeups and queued replays are never briefs; it seeds once.
4. **At a scope-met close the Stop hook refuses while a seeded skill never ran**, naming the missing ones. It is a gate with ADR-0104's brake: two blocks per session (counted on the session meta, so a restart does not reset it), then the close goes through and `skills.close.bypass` is logged. Two ways out need no skill. The model may write, in the final message, one line per skill: `Skill not used: <name> — <reason>`; that satisfies the check and is logged (`skills.close.waived`). And a skill the project cannot invoke (absent from the SDK's captured command catalog and from the skills on disk) is reported as unavailable instead of blocking for ever; with no captured catalog nothing is reported unavailable, since a wrong "unavailable" would only relax the gate. Machine turns and turns that do not claim scope met are never touched, and a read failure never blocks a close. The gate has a row, `builtin:skills-named` (native tier `deny`), which the Practice pane can lower or switch off, and `MARVIN_DESIGN_HOOKS=measure` logs instead of blocking.
5. **Visibility.** Watch rows carry `skills { required, used, missing }`, and the Sessions pane shows `skills 2/3` on the row with the missing names in the tooltip. The practice loop gets a deterministic extractor, `skill.named.unused:<name>`: the brief named it, the session closed scope met, and it never ran and was never waived. It is report-only (no rule template, because the remedy is this gate), so the nightly run measures whether the gate holds and the pane's "Mark fixed" starts the verification clock. Extractor version 9.

## Alternatives considered

- **Put the skill list in the prompt and ask harder.** The measurement above is what prose achieves.
- **Hard-code the skills that matter.** Golden Rule 6. Another project names different skills, and the list changes weekly.
- **Block with no waiver.** A skill that does not apply to the change (a UI skill on a one-line config edit) would stall the tab; the model would learn the brake, as it did with ADR-0135's cap. A stated reason is cheap, is logged, and is measurable.
- **Count a skill run only from the transcript at close time.** Correct, and it needs a transcript scan per close; the session meta already persists, and the extractor does the transcript read for measurement.
- **Treat a waiver as always valid and stop measuring it.** The extractor deliberately does not count a waived skill as a miss, but `skills.close.waived` is logged, so abuse of the waiver is visible as a rate.

## Consequences

- A tab that names skills now spends one continuation at the close when it skipped one. Its cost is bounded: two blocks, then through.
- A failed `Skill` call (for example an unknown skill) is still recorded at the PreToolUse boundary, the same as the review skills have always been. The extractor ignores failed calls, so the two can disagree; the gate errs towards letting a close through.
- The recording point does not tell a subagent's `Skill` call from the main session's (it never did, for the review skills either), so a scout that runs a skill counts for the session. The extractor reads own calls only, so it can report a miss the gate let through.
- A shared checkout keys the in-memory record by tree, so two sessions on one tree share it for the path rules; the close check reads the session's own persisted list and does not.
- The Practice pane lists rules created through the route and edits tier, status and message, but has no form to create one yet; creation is the route only.
- A skill named in a brief that the SDK's catalog lacks (not installed, not enabled) is reported unavailable and does not block; whether the brief should then have named it is a question for the person.

## Scope of Done

- [x] Every `Skill` call is recorded under its normalised name per checkout, the review skills keep their freshness rule, and a restart does not forget what ran: tests `records a skill that is not a review skill…`, `keeps the ADR-0104 freshness rule…`, `hydrates the record…`, and the persistence cases in `skill-brief.test.ts`.
- [x] A rule with `paths` and `requireSkillThisSession` denies a matching commit, allows it after the skill ran, brakes at two, and clamps a hostile rules file: tests `a rule with paths and a skill denies…`, `keeps the ADR-0104 brake…`, `clamps a rule file's own lists…`, `a rule whose lists hold nothing valid never fires…`.
- [x] The `Skills:` parser reads the three shapes and a real brief line, and seeds once from the first message only: `skill-brief.test.ts`.
- [x] The close hook blocks naming the missing skills, accepts the waiver line, treats an unavailable skill as unavailable, brakes after two blocks across a restart, and ignores machine turns, non-scope-met turns and read failures: `skills-close.test.ts`.
- [x] The watch row carries `skills`; the extractor `skill.named.unused` counts a named, un-run, un-waived skill at the first scope-met close: `session-watch.test.ts`, `skill-named-unused.test.ts`.
- Not built: a form in the Practice pane to create a skill-on-paths rule (route only), and a reminder line in the turn prompt naming the seeded skills (the block message is the only text the model sees).

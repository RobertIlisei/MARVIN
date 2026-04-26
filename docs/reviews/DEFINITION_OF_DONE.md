# Definition of Done — audit, plan, tasks

**Purpose.** Three concentric checklists. The audit is the macro
artifact (a snapshot of MARVIN's state on a given date), the PLAN
changelog is what we write when a slice ships, the task list is the
unit of execution. "Done" means something different at each layer; if
we leave the criteria implicit, work piles up that's been "mostly
done" for weeks.

This document is forward-looking. Apply it to the 2026-04-26 audit
and any future audit MARVIN runs against itself.

---

## Audit · Definition of Done

An audit is "shipped" when **every** of the following is true:

1. **All 🔴 findings have a resolution.** Each Important finding ends
   in one of three terminal states:
   - **Landed** — code merged, with a PLAN.md entry citing the
     finding number.
   - **Deferred with rationale** — a PLAN.md entry explaining *why*
     it's deferred and *what would unblock it*. "We'll get to it"
     is not a rationale.
   - **Reclassified** — moved to 🟠 / 🟡 with a one-line note in the
     audit doc itself explaining the downgrade (e.g. discovered the
     issue is mitigated by another mechanism). The downgrade requires
     the same severity rigour as the original classification.

2. **The Golden-Rule prerequisites work.** Specifically:
   - The knowledge graph (`graphify-out/graph.json`) is rooted in
     this repo (smoke check: at least one node's `source_file` starts
     with `apps/` or `packages/`).
   - `pnpm -r typecheck` clean.
   - `pnpm test` clean — including any new tests added for findings
     in this audit.

3. **The audit doc itself reflects current state.** When a finding's
   resolution lands, edit the audit's status column to mark it done
   and link the PLAN entry. The audit becomes a historical record
   that's still trustworthy six months later.

4. **Mockups are matched or retired.** If a mockup represents
   approved work, it is either visually consistent with the shipped
   UI or replaced with screenshots of the actual result. A mockup that
   no longer matches the product is misleading reference material.

5. **Follow-up work is enumerated.** Anything spawned by the audit
   that doesn't ship in the audit's lifecycle gets an explicit task
   (the to-do list this DoD also covers). The audit doc lists each
   spin-off with its task ID.

6. **A `[done YYYY-MM-DD]` line exists in PLAN.md** at the bottom of
   the changelog block referencing the audit, plus a one-line
   summary: "Audit X shipped — N important findings resolved, K
   deferred (see PLAN entry / task IDs)."

The 2026-04-26 audit is currently in progress. Tracking against this
DoD means: 4 of 7 🔴 findings landed by 2026-04-26 (#3, #5, #7, #21).
3 outstanding (#1 graph re-root, #4 Honeycomb race, #6 FileViewer
save). 1 split (#2 — regex tightened, audit log + banner deferred).

---

## PLAN.md changelog entry · Definition of Done

A changelog line in PLAN.md is "complete" when:

1. **Date stamped** in `YYYY-MM-DD` form (or with a parenthetical
   like `(afternoon)` for the same-day second slice). Convert
   relative dates from chat ("last Thursday") to absolute before
   committing.

2. **Cites the finding(s)** the change addresses. Audit-driven work
   should cite by number ("audit finding #3"); product work should
   cite the PLAN section it advances.

3. **Includes a verification claim** — what the author actually ran
   to know it worked. "`pnpm -r typecheck` clean" or "Vitest pin in
   `packages/tools/tests/policy.test.ts` passes 26/26". Vague
   "should work" lines don't count.

4. **Names the touched files** when the change is structural or
   cross-cutting. Pure copy / styling edits don't need it; a new
   gate, a new MCP server, or a refactor that moves an export does.

5. **Links to an ADR** when the change satisfies a deterministic ADR
   trigger from CLAUDE.md (new tool gated, new MCP server, new
   subagent type, etc.).

The current 2026-04-26 changelog entry meets all five.

---

## Task · Definition of Done

A single line in the to-do list (TaskList) is "done" when:

1. **Code matches the audit-finding "Fix" section** (or, when the
   task is product-driven, the original spec). Deviations are
   documented inline in the diff or in PLAN.md — not left for the
   reviewer to discover.

2. **Touched files are exactly the ones the finding cited** — or
   the deviation has a one-line note. Drift here is the most common
   way audit work goes unfollowable.

3. **Local typecheck clean** for every workspace the change touched.
   Use `apps/web/node_modules/.bin/tsc --noEmit` per package; we
   can't reach `pnpm -r typecheck` from inside Cowork's sandbox.

4. **For security / policy / gate changes:** a Vitest unit test pins
   the new behaviour. Rule of thumb — if the change touches
   `packages/tools/`, `packages/runtime/src/sdk-runner.ts`,
   `packages/runtime/src/fs-sandbox.ts`, or any `/api/*/route.ts`,
   tests are part of the task. The scope is "the new branch", not
   "every line in the file".

5. **For UI changes:** rendered visually at three viewport widths
   (1024 px, 1440 px, 1920 px) and in both light and dark themes.
   Leave the screenshots in `docs/reviews/screenshots/` for high-
   visibility changes (TopBar, hero, chat layout); for low-visibility
   ones (a button colour) a single before/after pair is fine.

6. **PLAN.md changelog updated.** A new line, or an extension to the
   active "round" entry, with the four DoD items above.

7. **TaskUpdate marks the task `completed`.** No silent done-ness;
   the to-do list is the single source of truth for "what's next."

8. **For 🔴 findings only:** the change has been deployed (or, in
   MARVIN's single-user case, demonstrably running in
   `bin/marvin doctor` / a fresh session). Important findings sit
   on `main` until the user verifies the fix end-to-end.

Tasks that are split, deferred, or reclassified follow the same rule
as audit findings — explicit rationale via TaskUpdate, not silent
status drift.

---

## Anti-patterns these rules are written against

- **"Mostly done"** — a 🔴 finding sitting in `pending` with code
  half-merged. Either land it or document the block. No third state.
- **Silent reclassification** — a finding's severity quietly drifts
  from 🔴 to 🟠 because someone "didn't think it was that bad." If
  the original triage was wrong, write down what changed.
- **Mockups outliving the design they depicted** — a mockup that
  shows a control the codebase no longer has misleads future readers.
- **PLAN.md entries that don't say what the author ran** — "shipped
  the X feature" without a verification line means the next person
  can't tell whether the claim has teeth.
- **Tasks marked done because TypeScript compiled** — typecheck is a
  precondition, not a sufficient condition. Especially for security
  / gate changes, the Vitest pin is non-negotiable.

---

## Cross-link

Add the following line to `CLAUDE.md` under the "Adding a new
feature" section so future sessions pick up these rules without
having to re-derive them:

> **Definition of Done.** Audit, PLAN, and task DoD live at
> [`docs/reviews/DEFINITION_OF_DONE.md`](./docs/reviews/DEFINITION_OF_DONE.md).
> Apply it before marking anything `[done]`.

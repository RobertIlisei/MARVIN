---
name: pr-review
description: Pre-landing PR review. Analyses the current branch diff against the base branch for structural issues — SQL safety, LLM trust boundary, race conditions, shell injection, enum completeness, scope drift. Domain-agnostic. Adapted from Garry Tan's gstack /review (garrytan/gstack); role-catalog framing stripped; MARVIN's REVIEW.md honoured.
---

# Pre-landing pull-request review

Use before shipping a feature branch: staged or committed changes
vs the base branch. Not for post-merge review (that's out of scope;
see the managed code-review service). Not for speculative review of
in-progress work (too early; most findings will be stale by the time
you ship).

Activates on: `"review this PR"`, `"code review"`, `"check my diff"`,
`"pre-landing review"`, and proactive suggestion when the user
describes an imminent merge.

## Before anything else — read REVIEW.md

If the repository has a `REVIEW.md` at the root, read it and **honour
it as highest priority**. It's how the project scopes reviews to its
own concerns. Your findings should respect its severity calibration,
nit cap, skip-rules, and always-check list.

MARVIN's own `REVIEW.md` lives at the repo root. Any MARVIN session
reviewing MARVIN code reads it automatically.

## Scope gate — don't review the wrong thing

1. **Check the base branch.** `git rev-parse --abbrev-ref HEAD` and
   `git remote show origin | grep 'HEAD branch'`. If the current
   branch IS the base branch, there's no diff to review — exit
   politely.
2. **Check for a diff.** `git diff origin/<base>...HEAD --stat`. If
   zero lines changed, exit — nothing to review.
3. **Scope drift check.** Compare the stated intent (commit
   messages, PR description if present, TODOs the user mentioned)
   against the actual diff. Flag scope creep ("branch was supposed
   to add feature X but also touches Y, Z") before detailed review.

## The critical pass — run on every diff

Apply these checks to every diff, regardless of size. Each is a
structural class where bugs are both frequent and expensive.

### SQL & data safety

- Any new SQL string built with concatenation or template literals
  where the interpolated value came from user input → **CRITICAL**.
  Use parameterised queries.
- New `DELETE` or `UPDATE` without a `WHERE` clause → **CRITICAL**
  unless intentional. Ask.
- Migrations that aren't backward compatible (drop a column, rename
  without alias, change a type without a nullable intermediate) →
  **CRITICAL** unless the rollout plan explicitly covers it.

### Trust boundaries — LLM and user input

- LLM output used as structural code (eval, dynamic import, path
  construction) without validation → **CRITICAL**. LLM output is
  user input.
- LLM output interpolated into SQL, shell, HTML → **CRITICAL**.
- Tool-call arguments from an Agent SDK session used directly as
  filesystem paths without the project's cwd-sandbox check →
  **CRITICAL**.

### Race conditions and concurrency

- New shared mutable state accessed from multiple async contexts
  without a lock or atomic operation → inspect carefully. Flag if
  unsynchronised.
- Promise chains where `await` appears inside a loop that's supposed
  to fan-out in parallel → likely performance bug but also can be a
  correctness issue if the awaited values share state.

### Shell and command injection

- New `spawn`, `exec`, `execSync` calls with interpolated strings —
  check every interpolation source. If any came from outside the
  process's control, **CRITICAL** without explicit escaping.
- Shell commands built with template literals and passed to
  `shell: true` — examined individually; most are wrong.

### Enum and value completeness

- New enum member introduced in this diff → grep across the repo for
  `switch`/`if` statements over the enum. Any that don't handle the
  new case → **CRITICAL** (silent fallthrough) or 🟡 Nit if the
  fallback is safe.
- Similarly, new status values, error codes, event types — grep
  consumers.

This check **must read code outside the diff** to be valid. A
`switch` in `file-A.ts` today that silently ignores the new enum
member added in `file-B.ts` today is a bug you can only catch by
widening the scope.

## Specialist passes — dispatch on large diffs

For diffs of ≥ 50 lines, add specialist passes in addition to the
critical pass. Run them as separate reasoning passes (not subagents
— single-assistant rule) on the same diff:

- **Testing** — did this change introduce behaviour that wasn't
  tested? Is there a regression test for the bug this claims to fix?
- **Maintainability** — duplication, dead code, functions > 60 lines,
  overly-clever abstractions where a straight-line version would
  read better.
- **Security** — OWASP-adjacent concerns not already caught above.
  Auth boundary changes, credential handling, TLS verification,
  serialisation of untrusted data.
- **Performance** — N+1 queries, synchronous file reads inside a
  request handler, new unbounded loops over user-controlled input.
- **API contract** — public API shape changes (new route, new field,
  removed field, status code change). If the project has an API doc
  (MARVIN has `docs/reference/api.md`), flag that it needs updating.
- **Design** — UI changes. Does the change honour the project's
  design system? Does it introduce new tokens or patterns that
  belong in the shared layer?

## Severity and output format

Format each finding as:

```
[SEVERITY] (confidence: N/10) path:line — one-line description
  → suggested fix in one line
```

Severities (aligned with REVIEW.md and Claude Code's managed code
review):

- 🔴 **Important** — a bug that should be fixed before merging.
- 🟡 **Nit** — minor, worth fixing but not blocking. Cap at what
  REVIEW.md says (MARVIN: 5).
- 🟣 **Pre-existing** — a bug in the codebase that this PR didn't
  introduce but is adjacent. Lower priority but worth noting.

Confidence scale:

- **9-10**: verified by reading specific code. Could write a PoC.
- **7-8**: high-confidence pattern match.
- **5-6**: moderate — flag with the caveat "worth verifying".
- **3-4**: low — appendix only.
- **1-2**: speculation — include only if P0.

## Fix-first, not read-only

If a finding is **AUTO-FIX** eligible (stylistic, mechanical, clear
single right answer — missing `as const`, obvious typo, incorrect
import path), apply the fix as part of the review. Don't just flag
it. Reviews that only flag waste a round trip.

Findings that require **ASK** (judgement call, scope decision, larger
refactor): batch them, present the list, wait for user direction.

Test stubs (a test file that exists but has no meaningful
assertions) always → ASK. Don't silently fill them in.

## Cross-reference project state

- If the project has a TODOs or backlog file (MARVIN: `PLAN.md`),
  cross-reference findings. Flag items the PR should have closed
  but didn't, and new items that should be added.
- If the project has an ADR directory (MARVIN: `docs/decisions/`),
  check whether any finding would be easier to resolve as a new ADR
  rather than an inline fix. Surface the suggestion; don't write
  the ADR as part of the review.
- If the project has a recent review log (gstack has one; MARVIN
  doesn't yet), check for duplicate findings from earlier reviews
  on the same branch. Suppress repeats where the code hasn't
  changed.

## Summary format

Open the review body with a one-line tally, then lead with a
headline:

```
2 important, 3 nit, 1 pre-existing

No blocking security issues. Two SQL-safety concerns in
migrations/0042-*.sql; see findings below.
```

Keep the body terse. One line per finding with its fix. Expand on
request.

## Attribution

Adapted from the `/review` skill in
[github.com/garrytan/gstack](https://github.com/garrytan/gstack),
by Garry Tan, under its MIT licence. The CRITICAL-class categories
(SQL safety, race conditions, LLM trust, shell injection, enum
completeness), the AUTO-FIX/ASK distinction, the confidence scale,
and the "read outside the diff" rule for enum completeness are
direct ports. Role-catalog framing ("you are the staff engineer")
and the subagent dispatch mechanics were stripped to honour MARVIN's
single-assistant rule ([ADR-0001](../../../docs/decisions/0001-single-assistant.md)).
The REVIEW.md integration is MARVIN-specific and follows the
convention from Claude Code's managed code-review service.

---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behaviour, BEFORE proposing fixes. Four-phase root-cause workflow with an Iron Law — no fixes without root cause investigation first. Merges patterns from Jesse Vincent's Superpowers (obra/superpowers) and Garry Tan's gstack (garrytan/gstack).
---

# Systematic debugging

Use when facing: test failures, production bugs, unexpected behaviour,
performance problems, build failures, integration issues. Especially
critical under time pressure, when a "quick fix" seems obvious, after
multiple failed attempts, or when understanding is incomplete.

## The Iron Law

**No fixes without root cause investigation first.**

A symptom fix creates a whack-a-mole loop. The symptom disappears;
the actual cause moves somewhere else; the next bug is harder to
find because the original mechanism is now partially masked.

Investigation is not optional. Even under deadline.

## Phase 1 — Root cause investigation

Before proposing any fix, complete these steps in order:

### Read the error message carefully

Stack traces, line numbers, file paths. The message is usually
telling the truth about what happened, even when it's misleading
about why. Read every line. Don't pattern-match the top line and skip
the rest.

### Reproduce reliably

Can you trigger the bug on demand? What are the exact steps? If you
can't reproduce, you're debugging the wrong thing — or the bug is
timing-dependent and needs a different investigation approach.

### Track what changed

`git log`. `git diff` against the last known-good point. Check
dependencies (`pnpm-lock.yaml`, `package.json`), configuration
(`.env`, `turbo.json`, `tsconfig.*`), environmental differences
(Node version, OS). Recent changes are the first-order suspects.

### Log at component boundaries

For bugs that span multiple components (API → SDK → client), log
what data enters and exits each boundary. The bug is usually at a
boundary where two components disagree about a value's shape,
meaning, or timing.

### Trace data flow backward

When you find a bad value at the point it's used, **don't fix it
there**. Walk the call stack backward: where did this value come
from? Where was it originally produced? Where did it first deviate
from what was expected? The fix goes at the origin, not the
consumption site.

## Phase 2 — Pattern analysis

Compare the broken code against working code. Identify differences
systematically. Common failure signatures:

- **Race conditions** — "works in isolation, fails under load." Two
  paths reading/writing shared state without synchronisation.
- **Null/undefined propagation** — a missing value silently
  propagating through optional chains until something dereferences
  it far from the origin.
- **State corruption** — mutable state updated in one path but read
  in another where the invariant assumed initial state.
- **Integration failures** — two systems agree on shape but
  disagree on timing, units, encoding, or trust boundary.
- **Config drift** — code path is correct but configuration points
  it at wrong data.
- **Stale caches** — everything works after a clean run; fails when
  a cache from a prior run persists incorrectly.

Match the failure against these signatures. If it fits, the fix
pattern is usually well-known.

## Phase 3 — Hypothesis and testing

Form **one** hypothesis at a time. State it explicitly:

> "The bug is caused by X, because Y. I can verify by Z."

Test that hypothesis before moving to the next. Don't bundle fixes
— if you change three things and the bug disappears, you don't know
which change fixed it, and the other two might be masking a new
problem.

### The 3-strike rule

After three failed hypotheses on the same bug, **stop and question
the architecture**. The bug is probably a symptom of a deeper
structural issue that a fourth hypothesis won't uncover. Escalate —
ask the user. Redraw the system diagram. Consider that the right
fix is not at this layer.

## Phase 4 — Implementation

Once the root cause is confirmed:

### Write a failing regression test

Before the fix. The test reproduces the bug, confirms your hypothesis,
and guards against regression. If you can't write a test, you probably
haven't actually identified the root cause.

### Fix the root cause, not the symptom

Minimal diff. Change as little as possible around the fix — a large
blast radius while debugging is how new bugs get smuggled in.

### Verify

Run the regression test. It should now pass. Run the full suite.
Nothing else should have broken. Reproduce the original bug's
scenario end-to-end and confirm it no longer occurs.

### Large-blast-radius checkpoint

If the fix touches > 5 files, surface this to the user **before
landing**. Ask whether the scope is appropriate or whether the bug
should be broken into smaller fixes.

## Phase 5 — Verification and report

Output a structured report:

```
BUG REPORT
  Symptom:         <one-line description>
  Root cause:      <actual mechanism, not "there was a bug in X">
  Fix:             <file:line>
  Evidence:        <how we verified — test output, log diff>
  Regression test: <file:line of the new test>
  Related:         <any sibling bugs this might have caused>
  Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
```

`DONE_WITH_CONCERNS` if the fix works but the underlying architecture
is the real problem and should be revisited. `BLOCKED` if the 3-strike
rule triggered and you need guidance.

## Applying to MARVIN

MARVIN's surfaces where systematic debugging pays off most:

- **SDK-in-the-loop bugs** — turn hangs, tool calls that don't
  resolve. Logs live in `~/.marvin/sessions/<projectId>/*.jsonl`.
  Read the JSONL chronologically; bugs are usually at the
  `cli.event` → `turn.completed` boundary.
- **Confirm-gate timing** — race between the client's `/api/confirm`
  POST and the SDK's `canUseTool` promise. See
  [`sidecar/packages/runtime/src/confirm-registry.ts`](../../../sidecar/packages/runtime/src/confirm-registry.ts).
- **Session resume** — `turn-registry` vs `hydrateFromSession`
  disagreement when reconnecting mid-turn. See
  [docs/operations/sessions.md](../../../docs/operations/sessions.md).
- **Graphify query mismatches** — graph says X, code says Y. One of
  them is stale; figure out which before editing either.

## Attribution

Merges the 4-phase structure and "investigate before fix" philosophy
from the `systematic-debugging` skill in
[github.com/obra/superpowers](https://github.com/obra/superpowers)
(Jesse Vincent / obra), with the Iron Law, 3-strike rule, and
structured report from the `investigate` skill in
[github.com/garrytan/gstack](https://github.com/garrytan/gstack)
(Garry Tan / gstack). Rewritten in MARVIN's voice; stripped
role-catalog framing; kept the substantive method from both.

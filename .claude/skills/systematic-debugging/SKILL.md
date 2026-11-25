---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behaviour, BEFORE proposing fixes. Four-phase root-cause workflow with an Iron Law — no fixes without root cause investigation first — plus supporting techniques for tracing, waiting on conditions and layered validation. Merges patterns from Jesse Vincent's Superpowers (obra/superpowers, MIT) and Garry Tan's gstack (garrytan/gstack).
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

**Measure before theorising, above all for UI, layout and timing bugs.**
Reading source and reasoning about it produced four wrong diagnoses in a row
on one real layout bug; each was settled in one attempt once something was
measured (a frame origin, `ps` / `sample` for a spinning process, a transcript
line, a screenshot). After ONE failed fix for a layout or timing bug, stop
reasoning about the code and instrument it: a probe costs one run, a wrong
guess costs a whole fix-and-verify cycle.

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
consumption site. When the chain is long, read
[root-cause-tracing.md](root-cause-tracing.md).

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

Several failing tests: group them by cause before touching anything. Ten red
tests are often one broken thing; fix that one, re-run, and only then look at
what is left. A failure that depends on timing or on what ran before it
points at shared state or a guessed delay: see
[condition-based-waiting.md](condition-based-waiting.md).

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

### Make the bug structurally impossible, where it is cheap

If the bad value could reach the failure by other routes, validate where it
enters and where it is used. See [defense-in-depth.md](defense-in-depth.md).

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

## Red flags: stop and return to Phase 1

- "Quick fix for now, investigate later."
- "Just try changing X and see."
- Several changes at once, then a test run.
- "It's probably X, let me fix that." (a guess, not a hypothesis with a check)
- Proposing a fix before you have traced where the value came from.
- "One more attempt" after two failures.
- Each fix exposes a new problem in a different place: that is the 3-strike
  rule's architecture signal, not bad luck.

## Rationalisations

| Excuse | Reality |
|---|---|
| "The issue is simple, no process needed" | Simple issues have root causes too, and the process is quick for them. |
| "Emergency, no time" | Guess-and-check thrashing is slower than the process. |
| "Try this first, then investigate" | The first fix sets the pattern. Start the right way. |
| "I'll write the test after I confirm the fix" | An untested fix does not stick. |
| "Several fixes at once saves time" | You cannot tell which one worked, and one of them is hiding a new bug. |
| "I see the problem, let me fix it" | Seeing a symptom is not understanding the cause. |

## When the investigation finds no code root cause

If you have completed the phases and the cause really is environmental,
timing-dependent or external: say what you investigated and what you ruled
out, add the right handling (a retry, a timeout, a clear error message), and
add logging that will capture it next time. Most "no root cause" verdicts are
an investigation stopped early, so check that yours was not.

## Supporting techniques

Read the one that matches the symptom; none is needed for every bug.

- [root-cause-tracing.md](root-cause-tracing.md): follow a bad value back up
  the call chain to where it was first wrong.
- [condition-based-waiting.md](condition-based-waiting.md): flaky tests,
  guessed sleeps, and how waiting meets this environment's own rules for
  background work and check-backs.
- [defense-in-depth.md](defense-in-depth.md): after the fix, make the same
  bug impossible by validating at every layer the data crosses.

## In MARVIN's own repository

This skill is installed user-level and serves any project: use that project's
own logs, runner and tools. When the working tree is MARVIN's source, the
places bugs hide:

- A turn that hangs or a tool call that never resolves: read the session
  transcript (`~/.marvin/sessions/<projectId>/<sessionId>.jsonl`) in order.
  The fault is usually where one component's event meets the next.
- Confirm-gate timing: the client's `/api/confirm` post against the SDK's
  `canUseTool` callback, in `sidecar/packages/runtime/src/confirm-registry.ts`.
- Session resume after a reconnect mid-turn: `turn-registry.ts` and
  [docs/operations/sessions.md](../../../docs/operations/sessions.md).
- Graph says X, code says Y: one of them is stale. Find which before editing
  either.
- A hang or a frozen app: `ps` for `STAT R` at 100 % CPU, then `sample <pid>`,
  before any theory.

## Attribution

Merges the 4-phase structure and "investigate before fix" philosophy from the
`systematic-debugging` skill, and the three supporting techniques
(`root-cause-tracing.md`, `condition-based-waiting.md`, `defense-in-depth.md`),
from [github.com/obra/superpowers](https://github.com/obra/superpowers)
(MIT, Copyright (c) 2025 Jesse Vincent), refreshed 2026-11-25 against upstream
v7.0.2 (first ported 2026-04-19), with the Iron Law, 3-strike rule and
structured report from the `investigate` skill in
[github.com/garrytan/gstack](https://github.com/garrytan/gstack) (Garry Tan).
MARVIN's changes: rewritten in a short form; supporting techniques adapted
(examples made generic, the project-specific session story, the graphviz
diagrams and the `find-polluter.sh` script dropped; condition-based waiting
reconciled with MARVIN's background-job and wakeup rules); rationalisation and
red-flag lists cut to the rows that answer a real excuse; "measure before
theorising" and the "no code root cause" paragraph added; the false
project-specific section replaced by a short one that names only what exists.

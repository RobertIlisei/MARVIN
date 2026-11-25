---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code. Enforces RED-GREEN-REFACTOR with an Iron Law — no production code without a failing test first — and a full-suite run, with every failure named, before any claim of done. Adapted from Jesse Vincent's Superpowers (obra/superpowers, MIT) for MARVIN's single-assistant loop.
---

# Test-driven development

Use before implementation for any new feature, bug fix, refactor, or
behaviour change. Exceptions require the user's explicit approval:
throwaway prototypes, generated code, configuration files.

## The Iron Law

**No production code without a failing test first.**

If you find yourself writing implementation before a test, stop. Delete
what you wrote. Start over with the test.

## The mandatory cycle

### 1. RED — write one minimal failing test

Pick the smallest behaviour change that moves the feature forward.
Write a test for it. One test, not five. The test asserts the
behaviour you want; the minimum assertion that would be wrong if the
behaviour were wrong.

### 2. Verify RED — actually run the test and see it fail

Run the suite. Read the failure message. Confirm the test fails **for
the right reason** — the assertion, not a syntax error, not a missing
import, not a typo.

A test that fails for the wrong reason isn't RED. It's a broken test
dressed up as RED and will pass once you accidentally fix the typo.

### 3. GREEN — write the simplest code that passes

The goal here is not elegance. The goal is to make the test pass with
the minimum change. Hardcoded return values, stubs, and "obviously
wrong but passes this test" implementations are allowed. The next
test will drive out the generalisation.

### 4. Verify GREEN — the whole suite, no warnings

Run every test, not just the one you wrote. All pass. No new warnings.
No skipped tests. If anything is off, that's a signal you changed
something you didn't intend.

**The project's full suite defines green, not your test file.** Before you
call the change done, run the project's own test command (whatever it uses,
unfiltered) even when the task named a single file. A scope statement bounds
the deliverable, not your verification. A test that passes alone and fails in
the full run is a real failure: shared state between files (a module-level
cache, a temp dir, a port, a container, a test runner that does not isolate
files) is the usual cause, and the full run is the only thing that shows it.

**Name every failure the run shows, including ones you did not cause.** A red
test you watched scroll past and left out of your report is a report
falsified by omission. Say "N failed: <names>, pre-existing / mine / unknown",
and read the result line itself, not the tail of a truncated pipe.

### 5. REFACTOR — clean while tests stay green

Now you have a safety net. Rename for clarity, extract helpers, remove
duplication. Run the suite after each refactor step. If a refactor
breaks tests, revert — the refactor was wrong, not the tests.

### 6. Repeat

Next behaviour change. Next failing test. Back to step 1.

## Non-negotiables

- **Watch each test fail before implementing.** No "I'm sure this
  would fail" shortcuts.
- **Delete any code written before its test exists.** Yes, even if
  you've already written it. Start over. This is the hardest rule and
  the one most worth following.
- **Never keep unverified code "as reference".** Commented-out or
  never-executed code is a time bomb. Delete it.
- **Confirm test failures happen for expected reasons.** Not typos,
  not missing imports, not module-resolution quirks. The assertion.

## Red flags — restart from scratch

If any of these happen, you've violated TDD and need to start the
feature over:

- Code written before its test exists.
- A test passes the first time you run it (means the behaviour was
  already there or the test is wrong).
- "Tests-after" patterns — writing all the code, then asking "what
  tests should I add?"
- Rationalising a skip: "this is too simple to test," "I'll add
  tests later," "this is just plumbing."

None of these are judgement calls. They're the failure mode the Iron
Law exists to prevent.

## When writing or changing any test

Read [writing-good-tests.md](writing-good-tests.md) first. Its rules in one
line each: name the production change that would make the test fail before
you write it; derive expected values without the code under test; assert real
behaviour, never a mock; keep test-only code out of production classes.

## Rationalisations

| Excuse | Reality |
|---|---|
| "Too simple to test" | Simple code breaks. The test takes thirty seconds. |
| "I'll add tests after" | A test written after passes at once, which proves nothing: you never watched it fail, so you never showed it can catch the bug. Tests-first ask "what should this do?"; tests-after ask "what does this do?" and check the cases you remembered. |
| "I already tested it by hand" | Manual testing leaves no record, cannot be re-run when the code changes, and skips the cases you forget under pressure. |
| "Deleting this much code is wasteful" | The time is spent either way. The choice is rewriting with confidence or keeping code you cannot trust. |
| "I need to explore first" | Fine. Throw the exploration away and start the cycle. |
| "The test is hard to write" | Hard to test means hard to use. Simplify the interface; do not skip the test. |

## Running tests

Use the project's own test command and its own conventions; this skill names
no runner. In a user's project, read its `package.json`, `pom.xml`,
`Makefile`, CI file or `CLAUDE.md` / `AGENTS.md` and run what they use.

In MARVIN's own repository (this skill is installed user-level, so this
applies only when the working tree is MARVIN's source): the sidecar suites
run with `npx vitest run` from the repo root (`vitest.config.ts`, which sets
`isolate: false`, so a test that leaks module state shows up only in the full
run), a single file with `npx vitest run <path>`, and the macOS logic with
`cd macos && swift run MARVINTests`. The first test of a new behaviour goes
next to the code it covers (`sidecar/packages/<pkg>/tests/`). See
`docs/development/testing.md`.

## Attribution

Adapted from the `test-driven-development` skill and its
`writing-good-tests.md` in [github.com/obra/superpowers](https://github.com/obra/superpowers)
(MIT, Copyright (c) 2025 Jesse Vincent), refreshed 2026-11-25 against
upstream v7.0.2 (first ported 2026-04-19). MARVIN's changes: rewritten in a
short form; the full-suite-and-name-every-failure rule added (upstream v6.4.1)
with MARVIN's own `isolate: false` lesson; six rationalisation rows kept of
eleven; no graphviz diagram, long examples or checklist; no "human partner"
asides; no pointers to other Superpowers skills; the project-specific section
replaced by a generic "Running tests" section. Single assistant: no
subagent-driven steps.

---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code. Enforces RED-GREEN-REFACTOR with an Iron Law — no production code without a failing test first. Ported from Jesse Vincent's Superpowers plugin (obra/superpowers) under its open-source terms; adapted for MARVIN's single-assistant constraints.
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

Run every test. All pass. No new warnings. No skipped tests. If
anything is off, that's a signal you changed something you didn't
intend.

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

## Applying to MARVIN

MARVIN currently has no automated test harness — see
[docs/development/testing.md](../../../docs/development/testing.md) for
the status. That doesn't exempt this skill. It escalates it: the
first place TDD should land is wherever tests are going to live.

For MARVIN-scoped TDD:

- **Pure functions** in `sidecar/packages/tools/src/policy.ts`,
  `sidecar/packages/runtime/src/cost-tracker.ts`,
  `sidecar/packages/runtime/src/projects.ts`,
  `sidecar/packages/graphify-bridge/src/read-graph.ts` — low friction. Pick
  vitest or bun test. Each test is seconds.
- **API route integration** — boot a Next.js test server, fire HTTP
  requests, assert responses. Higher friction but higher coverage.
- **SDK-in-the-loop** — record fixture event streams, replay them in
  tests. Deferred per the testing doc; also appropriate for TDD once
  the fixture harness exists.

When applying to new MARVIN code: pick a small pure function, write
the failing test, watch it fail, implement. The harness gets built
one feature at a time by following the Iron Law, not by writing "set
up testing infrastructure" as a separate ticket.

## Attribution

Adapted from the `test-driven-development` skill in
[github.com/obra/superpowers](https://github.com/obra/superpowers), by
Jesse Vincent (obra). Used under the Superpowers plugin's
open-source licence. Rewritten in MARVIN's voice; stripped multi-agent
framing; Iron Law and phase structure preserved.

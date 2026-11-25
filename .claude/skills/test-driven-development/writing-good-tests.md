# Writing good tests

Read this when you write or change a test, add a mock, or add a cleanup or
helper method that only tests use.

A test exists to catch a specific break. Two rules cover almost everything:

1. Every test names the break it catches.
2. Every test exercises the real thing.

Strict TDD gives you both: a test you watched fail against real code has
already shown it can fail, and earns a mock only when the real dependency is
slow or external.

## 1. Name the break

Before writing the body, answer: **what change to the production code should
make this test fail, and is that change a bug or a decision?** A test earns its
place by catching a wrong branch, a missing side effect, a wrong argument, a
boundary case or a broken contract.

**Derive expectations independently.** Use literals and hand-checked fixtures;
a table of cases with literal expected values is the best shape. An
expectation computed by the code under test, or by its helpers, passes whatever
that code does.

```ts
// Bad: the same builder produces both sides, so this is always true
const expected = buildSearchQuery({ tag: "urgent" });
expect(buildSearchQuery({ tag: "urgent" })).toBe(expected);

// Good: a literal worked out by hand
expect(buildSearchQuery({ tag: "urgent" })).toBe('tag:"urgent"');
```

**No change detectors.** If only an intentional decision can fail the test (a
constant's value, the exact wording of a message, a private structure), it
fires on redesign and sleeps through bugs. Test the behaviour that depends on
the decision: not `expect(MAX_RETRIES).toBe(5)`, but "a failing call is retried
five times and a sixth attempt never happens".

**Behaviour, not text.** Asserting that a script or a config file contains a
given line proves only that the file is the file. Run the script on controlled
input and assert its output, its side effects or its exit code.

**Your code, not the framework.** Test the contract your code makes at its
boundary: the route you register, the query you emit, the payload you produce.
How a library works is its maintainers' test to write. If the library surprised
you, add one narrow characterisation test that names the assumption. The same
applies inside your code: a constructor, getter, constant or plain forwarder
earns a test only when it validates, normalises, defaults, derives, enforces or
causes a side effect.

Before the body, ask yourself:

- Can I name the production change that fails this test? If not, redesign it
  around something observable.
- "The source text changed" is not a failure worth catching; run the artifact.
- Is the expected value derived without the code under test? If it reuses that
  code's logic, replace it with a literal.

## 2. Exercise the real thing

**A mock earns no assertions.** An assertion on a mock passes when the mock is
there and fails when it is not; it says nothing about the component. Assert the
real component's behaviour. If the mock is what you are checking, unmock it or
delete the assertion.

```ts
// Good: real behaviour
expect(screen.getByRole("navigation")).toBeInTheDocument();
// Bad: the existence of a mock
expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();
```

**Mock at the right level.** Learn every side effect of the real method before
replacing it. Mock the slow or external operation, and keep real whatever the
test depends on. When unsure, run the test against the real implementation first
and see what actually has to happen.

```ts
// Bad: the mock also swallows the config write that duplicate detection reads
vi.mock("tool-catalog", () => ({ discoverAndCacheTools: vi.fn().mockResolvedValue(undefined) }));
// Good: mock only the slow server start; the config write stays real
vi.mock("server-manager");
```

**Make doubles specific.** When arguments, call counts or ordering are part of
the contract, assert them; a fake that accepts anything verifies nothing. Give
each branch (success, error, malformed) its own fixture, so the wrong branch
cannot satisfy the expectation.

**Mirror real data completely.** A mock response carries every field the real
one does, not just the fields the test reads. A partial mock passes while the
integration breaks on the field it left out.

**Production classes carry production methods only.** A `destroy()` or
`reset()` that only tests call belongs in a test utility. Ask: is it called only
from tests? Does this class own that resource's lifecycle? If not, move it.

**Prefer real components to elaborate mocks.** When the mock setup outgrows the
test, when the mock misses methods the real thing has, or when the test breaks
whenever the mock changes, write an integration test with real components. A
database, a message broker or a browser that can be started locally (a
disposable container, an in-memory server) is usually cheaper than the mock.

## The mutation check

Before you finish, mutate the production code in your head. At least one test
should fail for each realistic mutation:

- a wrong constant or argument
- the wrong branch taken
- a missing state change or side effect
- an empty or default return
- missing validation for zero, empty, null, unauthorised or malformed input

A mutation nothing catches means the behaviour is unprotected or the test is a
tautology. When it is cheap, do it for real: change the line, watch the test go
red, restore it.

## Tests ship with the implementation

The cycle (failing test, minimal code, refactor) is what "complete" means. Ship
the tests the behaviour needs and only those. Trivial code earns none, and a
test written to satisfy process costs maintenance for ever.

## Warning signs

- Setup and assertion share one object, so equality is guaranteed.
- The test can fail only through a crash or a missing selector.
- It fails on every intentional change and never on an accidental break.
- Expected values are hidden behind loops, builders or helpers.
- It greps source text, or asserts that a removed symbol stays removed.
- It would still matter if only the framework remained.
- It exists for coverage and checks no outcome.
- An assertion targets a `*-mock` test id, or fails when the mock is removed.
- A method is called only from test files.
- Mock setup is more than half the test, or you cannot say why the mock is needed.
- You are mocking "just to be safe".

## Attribution

Adapted from `writing-good-tests.md` in
[github.com/obra/superpowers](https://github.com/obra/superpowers) (MIT,
Copyright (c) 2025 Jesse Vincent), v7.0.2. Changes: trimmed, examples
shortened and made generic, the quick-reference table and the skill-writing
asides removed.

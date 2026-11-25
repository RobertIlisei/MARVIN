# Condition-based waiting

Flaky tests often guess at timing with a fixed delay. They pass on a fast
machine and fail under load, in CI, or when other suites share the machine.

**Wait for the condition you care about, not for a guess about how long it
takes.**

## Replace the guess

```ts
// Before: guessing
await new Promise((r) => setTimeout(r, 50));
expect(getResult()).toBeDefined();

// After: wait for the thing itself
await waitFor(() => getResult() !== undefined, "result to be set");
expect(getResult()).toBeDefined();
```

| Waiting for | Condition |
|---|---|
| An event | `events.find((e) => e.type === "DONE")` |
| A state | `machine.state === "ready"` |
| A count | `items.length >= 5` |
| A file | `fs.existsSync(path)` |
| A service | a health probe that returns success |

A generic helper (every wait has a timeout and a message that says what it was
waiting for):

```ts
async function waitFor<T>(cond: () => T | undefined | null | false, what: string, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const r = cond();           // call the getter inside the loop: fresh data each poll
    if (r) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${what} after ${timeoutMs}ms`);
    await new Promise((r2) => setTimeout(r2, 10));
  }
}
```

Mistakes: polling every millisecond (wastes CPU; ten is plenty), no timeout
(hangs for ever), reading the state once before the loop (stale).

In the stacks the projects use, prefer the framework's own wait over the helper:
Playwright's auto-waiting locators and `expect(...).toBeVisible()`, Testing
Library's `waitFor` / `findBy*`, Awaitility (`await().atMost(...).until(...)`)
in JVM tests, and a container's own readiness strategy (wait for the log line or
the health check) rather than a sleep after starting it.

## When a fixed delay is right

When the thing under test is itself timing (a debounce, a throttle, a tick):
first wait for the triggering condition, then wait the known interval, and
comment why the number is what it is.

```ts
await waitForEvent(manager, "TOOL_STARTED"); // condition first
await new Promise((r) => setTimeout(r, 200)); // two ticks at 100 ms, then partial output exists
```

## Tests that pass alone and fail together

A guessed delay is one cause. The other common one is shared state: a port, a
temp directory, a module-level cache, a database or container that two test
files or two sessions use at once. Waiting longer does not fix that. Run the
full suite to see it, and give each test its own resource.

## Waiting on something outside the process (CI, a deploy, a long job)

The helper above is for waiting inside one command or test. For something that
takes minutes and is not yours to block on, this environment has its own rules,
and they win over any loop you would write:

- Do not start a detached waiter (`&`, `nohup`, `setsid`, `disown`); it cannot
  wake the session and the result dies with the turn. A background-run flag on
  a shell command is denied in MARVIN tabs.
- If the wait fits in one foreground command, block on it with a timeout and
  report the result now: an until-loop that checks the condition every few
  seconds and exits non-zero at the deadline.
- If it does not fit, use the tracked mechanisms: `run_background_job` (its exit
  starts a real turn with the output) or `schedule_wakeup` (a clock-bound
  check-back), or hand back with the current state and say what is still open.
  Never say "I'll check when it finishes" without one of these armed
  (ADR-0031, ADR-0055).
- Whichever you use, the wait is a condition with a timeout and an owner, never
  a bare sleep.

Adapted from `condition-based-waiting.md` in
[obra/superpowers](https://github.com/obra/superpowers) v7.0.2 (MIT, Jesse
Vincent): the example file and the session statistics dropped; framework-native
waits, the shared-state note and the section on waiting outside the process
added.

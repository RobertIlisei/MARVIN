# Root-cause tracing

A bug shows up deep in the call stack: a file created in the wrong directory, a
database opened at the wrong path, a command run in the wrong place. The
instinct is to fix where the error appears. That treats a symptom. Trace
backward until you find the first place the value was wrong, and fix there.

Use it when the error is far from the entry point, the stack is long, or you
cannot tell where the bad value came from.

## The process

1. **Observe the symptom.** `git init` ran inside the source tree.
2. **Find the immediate cause.** The call that did it:
   `execFile("git", ["init"], { cwd: projectDir })`.
3. **Ask what called it, and with what.** Walk up: `createWorktree(projectDir)`
   called by `Session.start()` called by `Project.create(name, dir)`.
4. **Keep going up, checking the value at each step.** `projectDir` was `""`,
   and an empty `cwd` falls back to the process's own working directory, which
   is the source tree.
5. **Find the original trigger.** Where did the empty string come from? A test
   read `context.tempDir` before the setup hook that fills it had run.

The fix goes at step 5 (make that value fail loudly when read too early), not
at step 2. Then consider [defense-in-depth.md](defense-in-depth.md) for the
layers in between.

## When you cannot trace by reading

Add instrumentation just before the dangerous operation, not after it fails:

```ts
async function gitInit(directory: string) {
  console.error("DEBUG git init", { directory, cwd: process.cwd(), stack: new Error().stack });
  await execFileAsync("git", ["init"], { cwd: directory });
}
```

- In tests write to stderr directly; a logger may be silenced.
- Include the directory, the cwd, the relevant environment, a timestamp and the
  stack. Never print a secret to check whether it is set: print whether it is
  empty or its length.
- Run once and keep the full output in a file, then search the file:
  `npx vitest run > /tmp/run.log 2>&1; grep -n "DEBUG git init" /tmp/run.log`.
- Read the stack for the test file name, the line that triggered the call, and
  the pattern (always the same test? always the same argument?).

## Finding which test pollutes the others

Something appears during the run (a stray file, a leftover row, a held port)
but you do not know which test caused it. Bisect by hand: run the test files
in halves, with the same full command the project uses, and watch whether the
symptom appears. Keep going until one file remains, then trace that file with
the steps above. Do this with the project's own runner and any isolation or
cleanup it offers; do not write a loop that runs every test file separately
unless you know each file is safe to run alone, because some leave side effects
behind.

## Rules

- Never fix only where the error appears.
- If you cannot trace one level up, say so and gather evidence (instrument)
  instead of guessing.
- After the source fix, add validation at the layers the value crossed.

Adapted from `root-cause-tracing.md` in
[obra/superpowers](https://github.com/obra/superpowers) v7.0.2 (MIT, Jesse
Vincent): graphviz diagrams, the project-specific session story and the
`find-polluter.sh` script removed; the by-hand bisection and the secret-safety
note added.

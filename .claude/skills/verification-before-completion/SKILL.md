---
name: verification-before-completion
description: Use before saying that work is done, fixed, passing, merged or ready, and before a commit, a pull request or the scope-met handoff. No completion claim without fresh evidence from this turn — name the claim, run the command that proves it, read the result line, then state it. Adapted from Jesse Vincent's Superpowers (obra/superpowers, MIT) for MARVIN's single-assistant loop.
---

# Verification before completion

**No completion claim without fresh evidence from this turn.** A claim is any
sentence that says something is done, fixed, passing, clean, merged, deployed
or ready, and any sentence that expresses satisfaction about the work.
"Should work" is not evidence. "Probably", "seems to" and "looks right" are the
same sentence with a hedge.

## The gate

Before you write the claim:

1. **Name the claim** in one line ("the regression test fails without the fix
   and passes with it").
2. **Run the command that proves it**, whole and fresh: not a run from earlier,
   not a subset standing in for the full run.
3. **Read the result line itself.** Exit code, number of failures, number of
   tests that ran. If you piped the output through `head` or `tail`, make sure
   the line that carries the result is in what you read; otherwise write the
   output to a file and read the file.
4. **Does it say what you claimed?** If not, state the actual status with the
   evidence. If yes, state the claim with the evidence next to it.

This is a gate on the sentence, not on the work. It is the step that lets you
carry on: while plan steps remain and the last one passed its check, run the
next one in the same turn. Never turn it into a reason to stop mid-plan or to
ask permission the plan already gave. Verify, then continue or close.

## What counts as evidence

| Claim | Evidence | Not evidence |
|---|---|---|
| Tests pass | The full suite's result line this turn: 0 failures, and the count that ran | An earlier run, a single file, "should pass" |
| Build succeeds | The build command, exit 0 | The linter or the type checker passing |
| Bug fixed | The original symptom, reproduced before and gone after | The code changed, so it must be fixed |
| Regression test is real | Revert the fix and it fails; restore the fix and it passes | The test passed once |
| A subagent's or advisor's result is correct | The diff or file it names, read by you | The report saying "success" |
| A count (commits, files, failures) | A command that counts (`wc -l`, a rev-list count) | Eyeballing a list |
| Merged | The branch list or merge log shows it contained | "I ran the merge" |
| Requirements met | Each item checked against the code or output, line by line | The tests passing |

## Partial runs are named as partial

If you could run only part of it (one package, one file, a build without the
integration tests, a check that needs a machine you do not have), say exactly
that: "ran X: 41 passed; did not run Y". A partial run supports a partial claim.
When something is unverified the sentence is "unverified: ...", never a softer
word for done. Failures the run shows that you did not cause still go in the
report by name.

## Before the scope-met handoff

Check the Definition of Done you stated, bullet by bullet, against evidence from
this turn. Each bullet is met (with the line that shows it), waived (with the
reason), or reported not met. Then write the handoff. A scope-met line with a
bullet you never checked is a claim without evidence.

## Red flags: stop and run the check

- You are about to write "should", "probably", "seems to" or "I'm confident".
- You are about to say "Done" or "Perfect" and the last command was an edit.
- You are about to commit or open a pull request on a run that predates the last
  edit.
- You are repeating what a subagent, a tab or a tool told you.
- You are reporting a number you did not count.
- "Just this once", or you are tired of this task. Neither changes what the
  command prints.

## Attribution

Adapted from the `verification-before-completion` skill in
[github.com/obra/superpowers](https://github.com/obra/superpowers) (MIT,
Copyright (c) 2025 Jesse Vincent), v7.0.2, ported 2026-11-25. MARVIN's changes:
about half the length; the gate reframed as a check on the sentence that must
not stop a plan in progress (ADR-0067); evidence table extended with counts,
merged, and subagent or advisor reports; the partial-run and Definition-of-Done
handoff sections added; the "agent" framing replaced for a single-assistant
loop.

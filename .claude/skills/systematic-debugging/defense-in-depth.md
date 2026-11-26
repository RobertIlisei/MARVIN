# Defense in depth

You fixed a bug caused by invalid data and added one check. That check can be
bypassed by another code path, a refactor or a mock. After the root cause is
fixed, validate at every layer the data crosses, so the same bug becomes
structurally impossible instead of merely fixed.

## The four layers

1. **Entry point.** Reject obviously bad input at the boundary: empty, wrong
   type, path that does not exist or is not a directory.
2. **Business logic.** The operation checks that the data makes sense for
   itself, even if the caller already did.
3. **Environment guard.** Refuse dangerous operations in a context where they
   must never happen (in a test run, refuse to write or `git init` outside a
   temporary directory).
4. **Debug instrumentation.** Log the context (arguments, working directory,
   stack) before the dangerous operation, so the next occurrence explains
   itself.

## Applying it

1. Trace the data flow: where does the bad value originate, and where is it used?
2. List every checkpoint it passes through.
3. Add validation at each layer, in the style of the code around it.
4. Test each layer: try to get past layer 1 and confirm layer 2 catches it.

Do not stop at one check. In the case this comes from, each layer caught what
the others missed: other code paths skipped the entry check, mocks skipped the
business check, and an edge case on another platform needed the environment
guard.

## Keep it proportionate

This is for a bug that was costly or dangerous, not a licence to add
validation everywhere. A layer that cannot be reached, or that handles a state
the system never produces, is clutter: say which realistic route each layer
covers, and add only those.

## Project-controlled input

Any value read from a file inside the user's repository (a config, a manifest,
an env map) is written by whoever wrote that repository. A reader whose values
reach a subprocess environment, an argument vector, an executed path or an
interpreter option validates at the point it reads, refuses names that select
code to run (`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`,
`GIT_SSH_COMMAND`), and is applied so the tool's own values still win. This is
layer 1 for that class of bug, and it is not optional.

Adapted from `defense-in-depth.md` in
[obra/superpowers](https://github.com/obra/superpowers) v7.0.2 (MIT, Jesse
Vincent): shortened to a summary with the code examples dropped; the
proportion note and the project-controlled-input section added.

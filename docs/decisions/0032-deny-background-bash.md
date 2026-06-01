# ADR-0032 — Hard-deny Bash `run_in_background` at the tool gate

**Status:** Accepted — 2026-06-01
**Extends:** [ADR-0031](./0031-self-scheduled-wakeups.md) (self-scheduled wakeups)
**Touches:** [tool policy](../../sidecar/packages/tools/src/policy.ts), `personality.ts`

## Context

ADR-0031 made time-based "I'll check back in N minutes" real via
`schedule_wakeup`. But the same false-promise failure re-surfaced through a
**different** surface the moment 0.1.14 shipped: MARVIN ran a `git commit`
(with a 709-test pre-commit band) via **Bash `run_in_background: true`** and
told the user *"I'll be notified the moment it completes — waiting rather
than polling."* The turn then completed in 8 s. Nothing re-invoked it; the
commit finished in the background and was never reported.

The SDK Bash tool's own field doc is explicit about the contract:

> `run_in_background?: boolean` — *"Set to true to run this command in the
> background. **Use Read to read the output later.**"*

i.e. the model is expected to poll the output **within the same turn**, not
be notified asynchronously. MARVIN's runtime has no mechanism to re-invoke a
turn on background-process completion (the whole reason ADR-0031 exists). So
`run_in_background` on Bash is a capability the model *thinks* it has —
leaked from Claude Code harness training — that does not work here once the
turn ends.

ADR-0031's `personality.ts` rule already forbade the *narration* ("no 'I'll
wait for the notification' framing"), but that is a soft prompt nudge. Under
auto-mode (no human in the loop) a prompt-only MUST-NOT is theatre — the same
argument ADR-0030 made for enforcing the subagent read-only invariant at the
gate rather than in the prompt.

## Decision

**Hard-deny `Bash` calls that set `run_in_background: true`** in
`toolPolicy`. The deny reason steers the model to the two honest paths:
run foreground (raise `timeout`), or `schedule_wakeup` for a genuinely long
job. `personality.ts` notes the capability is gate-denied so the model
doesn't reach for it in the first place.

Scope: **Bash only.** The `Task`/Agent tool also has a `run_in_background`
field ("You will be notified when it completes") — that is a different tool
and a different question (does the SDK deliver agent-completion notifications
in MARVIN's context?); it is out of scope here and untouched.

### Why deny rather than "make it real"

We could instead wire Bash-background completion to re-invoke a turn (the
"make it real" path we took for time-based wakeups). Rejected for v1:
- A background Bash that the model *polls within the turn* already works and
  is not the problem; the problem is **ending the turn** with an outstanding
  background job. The gate can't distinguish "will poll" from "will abandon"
  at call time, so the safe mechanical line is no-background.
- `schedule_wakeup` already covers the legitimate "long job, come back
  later" case with a real mechanism. Background Bash is redundant with it.
- Cost: loses within-turn background multiplexing (rare in a single-assistant
  block model — you can run the slow thing foreground). Acceptable.

## Consequences

- A backgrounded build/commit can no longer be silently dropped — the gate
  refuses it and the model adapts within the turn.
- One legitimate-but-rare pattern (start a server in the background, run
  tests against it in the same turn) is no longer available via Bash; do it
  foreground or in separate turns.
- Enforcement is mechanical (gate), not prompt-dependent — consistent with
  ADR-0030's "make the invariant structural" principle.

## Scope of Done

- [ ] `toolPolicy("Bash", { run_in_background: true })` → `deny` with a
      steering message; unit-tested.
- [ ] `run_in_background` absent/false leaves Bash classification unchanged.
- [ ] `personality.ts` notes background Bash is gate-denied.
- [ ] Task/Agent backgrounding untouched.

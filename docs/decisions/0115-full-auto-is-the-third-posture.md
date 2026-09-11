# ADR-0115 — Full auto is the third posture, and it is not the absence of rules

- **Status:** Accepted — implemented 2026-09-11
- **Date:** 2026-09-11
- **Related:** [ADR-0015](./0015-permission-strategies.md) (auto and gated), [ADR-0030](./0030-subagent-read-only-invariant.md) (a subagent may never write), [ADR-0036](./0036-ask-agent-plan-modes.md) (mode is orthogonal to strategy), [ADR-0038](./0038-background-jobs-event-wakeups.md) (background execution denied), [ADR-0040](./0040-clickable-decisions.md) (AskUserQuestion reaches the user in every mode), [ADR-0102](./0102-two-sessions-one-worktree.md) / [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (the containment confirms), [ADR-0109](./0109-batch-integration-and-metered-ci.md) (metered CI)

## Context

The user, with a screenshot of a confirm dialog while the posture pill read **auto**: *"can we add another option, like we have for Auto / Gated which is run with skip permissions, the full auto from claude."*

They were right that something had drifted. ADR-0015 gave `auto` a docstring promising it behaved *"like Claude Code with `--dangerously-skip-permissions`, plus an audit trail"*, and that sentence is still in the source. It stopped being true some time ago. Four confirm-raising rules have been added to the auto path since:

| Added by | Confirms on |
|---|---|
| ADR-0107 | a tab in its own worktree touching the main checkout |
| ADR-0107 | a shared tab writing outside its declared lane |
| ADR-0102 | HEAD-moving git while another session shares the checkout |
| ADR-0109 | anything that spends CI minutes |

Each is defensible on its own, and each was added because something went wrong without it. Together they mean a user who chose "don't ask me" still meets a dialog on exactly the shapes they meet most — which is how the screenshot came to exist.

## Decision

**A third strategy, `full`, which waives the three containment confirms and nothing else.**

`PermissionStrategy` becomes `"auto" | "gated" | "full"`. In `full`, `makeAutoModeLogger` skips `maybeLaneConfirm`, `maybeSharedTreeConfirm` and `maybeSessionWorktreeGate`, and records each allowed call in the same auto-audit ledger under `full-auto-mode bypass` so the trail still distinguishes what ran unasked from what was classified safe.

### What it deliberately does not waive

Decided with the user rather than assumed, because both are the kind of thing a mode named "full auto" would be expected to remove:

**Metered CI still asks.** It is the only confirm that spends money. ADR-0109 measured roughly 10 pipeline-minutes to open a merge request and 48 compute-minutes to merge one, per branch, against an allowance already exceeded — and it fires rarely, so keeping it costs an interruption almost never. A mode that opened merge requests unattended would be the one setting able to spend real money while nobody is watching.

**The hard-deny floor stays.** A subagent may never write (ADR-0030), background execution is refused (ADR-0038), and a handful of destructive command shapes are blocked outright. These are not preferences a user is choosing between; they are invariants the rest of the system is built on. The whitepaper's first bet — parallel *reading* scales, parallel *implementation* is the documented failure mode, and MARVIN forbids it at the gate rather than in prose — is only true while that floor holds. A mode that suspended it would make MARVIN's own published guarantees untrue while it was switched on, which is worse than not offering the mode.

**Two more reach the user in `full`, because neither is a permission.** `AskUserQuestion` is the *model* asking the *user*; suppressing it leaves the turn waiting for an answer that never comes. Plan approval is what Plan mode *is* — mode and strategy are orthogonal by ADR-0036, and a Plan turn that executed without approval would simply be an Agent turn.

So `full` is not "the absence of rules". It is: **nothing asks about containment; the things that cost money or break invariants are untouched.**

### How it is presented

The posture pill cycles gated → auto → full auto → gated, so moving forward always means *more* autonomy and the dangerous posture is never one stray click from the safest. `full` is rendered red, the only red in that bar, and reads **"full auto"** in two words so it cannot be skimmed as "auto". Settings names what it will do in plain words rather than softening it: *an isolated tab will edit your shared checkout, switch branches and rebase without a confirm.*

Parsing is deliberately asymmetric: an unknown, stale or hand-edited value resolves to **gated**, the safest posture, never to the most permissive. A widened permission must be something a person chose.

### Considered and not taken

- **Making `auto` itself skip everything**, restoring its old docstring. Rejected: the four rules were each added after a real incident, and `auto` is the default. Removing safety from the default to fix a naming drift is the wrong direction.
- **A per-confirm set of toggles.** Rejected as a settings pane pretending to be a decision. Three postures a person can hold in their head beats seven checkboxes nobody audits.
- **Suppressing the hard denies for true parity with Claude Code.** Offered to the user and declined. Claude Code has no equivalent floor because it has no implementer subagents with a read-only invariant to protect.

## Consequences

- The posture that says "don't ask me" now means it, for the confirms a person actually meets.
- The audit ledger distinguishes `full-auto-mode bypass` from `auto-mode bypass`, so "what ran without being asked about" stays answerable after the fact.
- `auto` keeps its containment confirms, which means the default is unchanged and nobody is opted into anything.
- ADR-0015's docstring claim is corrected in the source: `auto` is described as what it is, and `full` carries the comparison to `--dangerously-skip-permissions`.

## Scope of Done

- [x] `PermissionStrategy` gains `full`; the union widened at all seven declaration sites
- [x] `makeAutoModeLogger` waives the three containment confirms, keeps metered CI and the deny floor, and audits the bypass distinctly
- [x] `PermissionStrategyChoice` in `MARVINLogic` — parse, label, cycle, help — so the decisions are asserted (ADR-0114's rule)
- [x] Pill cycles three ways, red for full, "full auto" in two words; Settings carries the plain-words warning; prefs accept the third value and reject anything else
- [x] 6 sidecar tests on the gate (what it waives, what it still denies, what still asks) and 12 Swift assertions on the choice

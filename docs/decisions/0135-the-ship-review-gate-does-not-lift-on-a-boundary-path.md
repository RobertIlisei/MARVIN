# ADR-0135 — The ship-review gate does not lift by repetition on a security-boundary path

- **Status:** Accepted (2026-11-24)
- **Amends:** [ADR-0104](./0104-ship-review-gate.md) (the two-denies-per-skill-per-turn brake)
- **Related:** [ADR-0105](./0105-practice-loop.md) (where the evidence came from)

## Context

ADR-0104 refuses a `git commit` whose diff needs `pr-review` or `security-audit` until the skill has run, and brakes itself: two refusals per skill per turn, then the commit is allowed and the bypass logged. The brake exists so that a skill call failing for an unrelated reason cannot stall a turn forever.

The practice loop's ledger for one real project (1,288 sessions since the gate shipped) records `ship.unreviewed` in 95 sessions and 134 commits: the diff touched a boundary path (auth, credentials, CI, `.env`, migrations, shell scripts) and no review ran in the session. The model had learned the brake. It took the two refusals and committed on the third call. In the same week two tabs building payment code were stopped by a person, not by the gate, for skipping `security-audit`.

A brake that the model can wait out is not a brake on the model; it is a delay.

## Decision

**On a diff that touches a security-boundary path the per-turn cap does not apply. The commit is refused every time until the required review has run.**

1. `classifyShipDiff` marks the two needs a boundary diff produces (`security-audit`, `pr-review`) as `boundary`. `checkShipReview` keeps refusing a `boundary` need past `SHIP_REVIEW_MAX_DENIES`.
2. Past the cap the message changes from "run the review" to **"stop and tell the user"**, and names what the user can do: run the review, commit themselves, or lower the gate. That is the discharge path ADR-0104 requires of every deny: it now lies with the person, not with repetition.
3. Nothing changes for a non-boundary diff (more than 3 files or 50 lines): two refusals, then allowed and logged, as before.
4. The user's controls are unchanged and still win: the gate's tier and on/off in the Practice pane (`builtin:ship-review`), and `MARVIN_DESIGN_HOOKS=measure`.

## Alternatives considered

- **Raise the cap** (5, 10). The model waits longer. Same hole.
- **Remove the cap for every reviewable diff.** A large refactor in a project without the review skills installed would have no way to commit. The boundary list is short and is exactly where an unreviewed commit costs most.
- **Interrupt the turn at the cap.** Ends work that may have other steps left; the refusal with a "tell the user" message lets the turn finish everything else.

## Consequences

- A project that has not installed `pr-review` / `security-audit` cannot have MARVIN commit a boundary-path change at `deny` tier. That is intended; the message says what to do, and the Practice pane lowers the tier in one click.
- `ship.review.bypass` events and the `bypass` counter on `builtin:ship-review` now count non-boundary bypasses only. A boundary commit that still shows as unreviewed in the practice loop after this means the gate was lowered or measured, not waited out.

## Scope of Done

- A boundary-path commit is refused on the third and every later attempt in one turn, and allowed as soon as both skills have run: test `never lets a boundary-path commit through on the cap`.
- A non-boundary reviewable commit still passes after two refusals: the existing cap test, unchanged.
- The past-cap message tells the model to stop and tell the user and no longer promises that the commit will be allowed.
- The whole `design-hooks` test file passes (106 tests) and the sidecar type-checks.

# ADR-0136 — Practice is opt-in, and a fix keeps the rate it was measured against

- **Status:** Accepted (2026-11-24)
- **Amends:** [ADR-0105](./0105-practice-loop.md) (the nightly runner's default; how a fix or rule is verified)

## Context

Asked on 2026-11-24 whether Practice works, the honest answer from one project's ledger (60 nightly runs, 1,288 sessions in the window) was: the mining works, the loop has never completed. No proposed rule was ever approved; the eight rules on the pane are MARVIN's built-in gates. And the pane could not answer "did the fix help":

- Three fixes marked on 2 September read **regressed** in November. Regression is a rate ("half the rate before, or more", 2026-09-09), but the rate before was computed from the sessions before the fix that were still in the 45-day window. After 45 days there were none: the rate before was 0, and any two recurring sessions were a regression. One of the three was recurring in 1 % of sessions.
- The row printed "71 of 1288 since fix". Without the figure it replaced, that number cannot be read.

Separately: the loop reads every transcript of a project every night. On a project with five sessions it is noise, and a user who has not asked for it should not get it.

## Decision

1. **A fix or rule stores its baseline when it is accepted**: the finding's hits and the sessions in the window at that moment, and their ratio (`LedgerFinding.baseline`). Verification compares against it for as long as the fix lives. A finding accepted before this ADR gets a baseline from the pre-acceptance sessions still in the window, on the next run, if any are left.
2. **With no baseline left, the test is absolute**: a fix has regressed when the behaviour would be *proposed today* (the same three thresholds a proposal needs). Otherwise five sessions confirm it.
3. **The pane prints both rates**: "was 31 % of sessions, now 5 % (71 of 1288 since fix)", or, with no baseline, the current rate and that the earlier one was not kept. `rateAfter` is stored for it.
4. **The loop is opt-in.** `enabled` defaults to off. An install that never chose keeps what it had: on where a ledger exists, off on a new one. The pane says it is off, what it is, and offers one button. The user's stored choice always wins.
5. **The built-in gates are not part of the switch.** Graphify-first, ship-review, the plan spine and the rest are enforced with Practice off; they are only listed on its pane.

## Alternatives considered

- **Never age sessions out of a fixed finding.** The window exists so a June session does not weigh on a September finding; a snapshot keeps the one number needed without keeping the sessions.
- **Call it regressed only by count.** That is what the 2026-09-09 change removed, for good reason.
- **Per-project switch.** The runner is per install and a project with too few sessions already shows a calibration counter; one switch is enough until someone needs two.

## Scope of Done

- A fix whose pre-fix sessions have aged out, recurring at 9 % against a baseline above 50 %, is `confirmed`, not `regressed`: test `a fix keeps the rate it was measured against…`.
- `readPracticeConfig().enabled` is false on a data dir with no ledger, true with one, and equals the stored value when one exists: tests under `Practice is opt-in`.
- The pane's meta line carries the rate before and after; with Practice off it shows the notice and the button.
- The Practice, practice-phases, memory-practice and design-hooks test files pass and the sidecar type-checks.

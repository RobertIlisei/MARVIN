# ADR-0123 — Parallel tabs share a machine and a numbering: guard what one tab can break for the others

- Status: Accepted (2026-10-02)
- Builds on: ADR-0107 (one worktree per tab), ADR-0110 (a worktree isolates the filesystem, not the machine), ADR-0104 (ship-review gate brakes)

## Context

One night of five to seven parallel MARVIN tabs on one project (2026-10-01/02) produced four repeatable failures that no single tab could see and that cost hours of supervision. None is specific to that project.

1. **Numbered files collided across worktrees eight times.** Every tab picks "the next free number" for an ADR or a migration from its own checkout, so tabs running at once picked the same one: two ADR-0489s, two ADR-0492s, two ADR-0495s, two ADR-0498s, two ADR-0500s, a migration version reused by two branches, and migrations numbered below what had already landed. Each was found only at merge — a duplicate Flyway version would have stopped the database from starting.
2. **A tab killed other sessions' processes.** `pkill -f spring-boot` in one tab stopped the user's dev API and other tabs' Maven runs: a name pattern matches every session's processes, not the tab's own.
3. **Every finished tab looked blocked.** The prompt makes a finished turn close with "Anything else, or should I stop?" plus `<!-- marvin:scope-met -->`. `PlanDecision.isAsking` treats "?" plus "should i" as a pending decision, so every completed tab showed "MARVIN needs your decision", and the user asked why done tabs were waiting.
4. **`marvin knowledge-graph .` rebuilt MARVIN's own graph from a project terminal.** `bin/marvin` changes into its own checkout before reading path arguments, so `.` meant MARVIN, not the caller's directory; and it ran the system `python3`, which does not have graphify.

## Decision

- **Numbered-file collision check at `git commit` (design hooks, Hook 3b).** A file is "numbered" when its name starts with an optional letter and 3+ digits followed by a separator (`0491-…`, `V202610021010__…`, `0042_…`); calendar-dated names are excluded. When a commit adds such a file and the same directory already holds the same number — in this checkout's HEAD, or added (committed or pending) in a sibling worktree of the same repository — the commit is refused with the clashing file, where it lives, and the next free number. Two refusals per turn, then allow and log (ADR-0104's brake). Fails open on any git error. No project convention is assumed.
- **Killing processes by name or pattern is refused** in the tool policy (`pkill`, `killall`, `kill $(pgrep|pidof|lsof …)`, `pgrep|lsof … | xargs kill`) in every permission mode. Discharge path: `kill <pid>` of a process the tab started (`run_background_job` reports it).
- **A scope-met turn is never a pending decision.** `PlanDecision` moves to `MARVINLogic`, returns false when the scope-met marker is present, and ignores the mandated closing sentence; a real question elsewhere in the text still counts.
- **`bin/marvin` resolves path arguments against the caller's directory** (`CALLER_PWD`, `from_caller`) for `knowledge-graph` and `graph-hooks`, and runs the knowledge-graph builder with graphify's own interpreter (the launcher's shebang, as the sidecar's `graphifyPython()` does).

## Consequences

- A tab that picks a taken number learns it at its own commit, with a suggested free number, instead of at merge. A number taken only on an unmerged branch whose worktree was removed is not seen — the check covers live worktrees and HEAD.
- A tab can no longer free a port held by someone else; it uses another port or tells the user.
- Finished tabs show the plain paused/complete state; only real questions raise the decision chip.

## Scope of Done

- [x] Collision check wired into the commit gate, unit + real-worktree tests (13).
- [x] Pattern-kill refusal with message and tests (deny 9 shapes, allow PID kills and read-only lookups).
- [x] `PlanDecision` scope-met rule with tests in MARVINTests.
- [x] `bin/marvin` path and interpreter fix, verified by building a scratch project's graph from its own directory.
- [ ] Observed over the next sessions: no collision reaches a merge; no false decision chip on a finished tab; no pattern kill breaks legitimate work.

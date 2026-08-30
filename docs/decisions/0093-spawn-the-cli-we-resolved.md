# ADR-0093 — Spawn the CLI we resolved, not the one PATH finds first

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0087](./0087-newest-claude-cli-and-reported-context-window.md) (fixed the reporting, not the spawn), [ADR-0082](./0082-claude-plan-usage-from-rate-limit-events.md) (the usage block this unblocks)

## Context

After ADR-0087, `/api/health` reported `claude 2.1.251` and the About panel
agreed. The Claude plan-usage bars stayed empty anyway.

Measured: a probe on this machine got `unifiedWindows` every time
(`five_hour 0.05`, `seven_day 0.50` — matching the Claude app's 6 % and 51 %),
while **0 of 10 MARVIN turns that same morning carried the field**.

The cause is a gap ADR-0087 did not close. **MARVIN never passes the binary to
the SDK.** There is no `pathToClaudeCodeExecutable`; the SDK resolves `claude`
from `PATH` on its own. And `enrichedToolPath()` prepended
`/opt/homebrew/bin`, so every turn spawned Homebrew's **2.1.92** — which
predates `unifiedWindows` — while `discoverClaudeBinary()` was busy telling the
UI about the user's **2.1.251**.

So ADR-0087 fixed *what MARVIN said* and left *what MARVIN ran* untouched. The
symptom survived the fix, and the honest verification (the About panel showing
2.1.251) actively confirmed the wrong thing. Same class as ADR-0079: checking
the surface that agrees with you rather than the one that decides.

## Decision

`enrichedToolPath()` puts the **directory of the resolved CLI first**, ahead of
the bundled node's directory and the Homebrew/local defaults. One line, and it
makes `discoverClaudeBinary()` authoritative for the spawn instead of
decorative.

Resolution failure is non-fatal: a machine with no CLI still gets an enriched
PATH rather than an exception, because throwing here would stop every turn
rather than one feature.

Pinned by a test asserting `enrichedToolPath()[0]` is the directory of
`discoverClaudeBinary()` — the invariant that was missing, and the reason a
version-skew bug could hide behind a correct-looking panel.

## Consequences

- Turns run the newest installed CLI, so `unifiedWindows` arrives and the
  plan-usage bars populate.
- MARVIN follows the user's CLI upgrades rather than whichever install sits
  earliest on a hardcoded list — which also matters for tool-name changes
  (ADR-0079) and flags.
- Per-model weekly windows (`seven_day_fable`, `seven_day_opus`) appear only
  once that model has been used against the plan; a missing row means the API
  did not report it, not that MARVIN dropped it. Noted in the UI code.

## Scope of Done

- [x] Resolved CLI's directory leads `enrichedToolPath()`
- [x] Non-fatal when no CLI is installed
- [x] Test pins `PATH[0] == dirname(discoverClaudeBinary())`
- [ ] Not in scope: passing `pathToClaudeCodeExecutable` explicitly (the SDK
      option exists; PATH ordering is the smaller change and covers the MCP
      subprocesses too)

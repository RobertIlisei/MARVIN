# ADR-0084 — Mechanical triggers for the two graph tools nobody uses

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0083](./0083-graph-drift-rail-rearms-and-escalates.md) (same hook machinery),
  [ADR-0066](./0066-graphify-directed-call-index-and-work-memory.md) (`graph_affected` / `graph_change_impact`), Golden Rule 7

## Context

Per-tool usage across **5,823 real `graph_*` calls**, all sessions:

| tool | calls | share |
|---|---|---|
| `graph_search` | 4,390 | 75 % |
| `graph_query` | 578 | 10 % |
| `graph_neighbors` | 517 | 9 % |
| `graph_summary` | 299 | 5 % |
| **`graph_affected`** | **22** | **0.4 %** |
| `graph_save_result` | 12 | 0.2 % |
| `graph_path` | 5 | 0.1 % |
| `graph_community`, **`graph_change_impact`**, `graph_reflect` | **0** | — |

Two findings drive this ADR:

1. **The blast-radius question is never asked.** `graph_affected` — who calls
   this symbol, with file and line, from the directed AST call cache — is at
   0.4 %, while the **undirected** `graph_neighbors` is 23× more common.
   `personality.ts` says in terms that neighbours cannot tell callers from
   callees and that `graph_affected` is the blast-radius tool; MARVIN still
   reaches for the one that cannot answer the question.
2. **`graph_change_impact` has never been called.** Not once. It reports the
   symbols a branch changes and every caller outside it — built for the moment
   before a commit or MR.

Both tools already have prose triggers (`graph_affected` appears 9× in
`personality.ts`). This is the failure mode the 2026-05-22 audit named: prose
triggers fire ~0×. The design hooks — the only mechanical enforcement — knew
about graphify-first and drift, and nothing else.

## Decision

Two advisory nudges in the existing PreToolUse hook, both gated on `hasGraph`
and both honouring `MARVIN_DESIGN_HOOKS=measure`.

**A. Blast radius before a mutation.** On `Edit`/`Write` to a source file
inside the project, when no `graph_affected` call has happened this turn:
one nudge naming `graph_affected` and correcting the `graph_neighbors` trap
explicitly. Capped at `BLAST_RADIUS_MAX_NUDGES = 2` per turn and never twice
for the same file — editing a file twice is one decision, not two.

**B. Impact before shipping.** On the first `Bash` matching
`git commit|git push|gh pr create|glab mr create`, when no
`graph_change_impact` call has happened this turn: one nudge, once per turn.

### Advisory, not deny — deliberately

ADR-0060 shipped a threshold tuned blind and had to be re-tuned in ADR-0083
after measurement showed its budget spent in five seconds. Repeating that with
a *deny* on the write path would block real work. Both nudges emit telemetry
(`blast.radius.nudge`, `ship.impact.nudge`) so the decision to escalate is
made on numbers from real sessions, not on a guess made today.

### Considered and not taken

- **Denying the Edit until `graph_affected` runs.** The false-positive cost is
  a blocked write on a leaf change (a new file, a test, a doc). Wrong trade for
  a first cut.
- **Reviving `graph_save_result` / `graph_reflect`** (12 calls / 0). The loop
  is effectively dead and either needs a real trigger or removal — a separate
  decision, not one to bundle here.
- **A `graph_summary`-at-turn-1 rule.** Supported by the same measurement
  (299 calls / 5 %), but a different rule with its own false-positive profile.

## Consequences

- The two highest-value graph questions now have a mechanical prompt at the
  moment they matter, instead of prose that measured 0.4 % and 0 %.
- Cost when ignored: one sentence of `additionalContext`, at most 3 per turn
  across both rules.
- Re-measure per-tool shares after a few sessions. If `graph_affected` does not
  move off 0.4 %, an advisory is the wrong instrument and A should escalate to
  a deny on the same narrow conditions.

## Scope of Done

- [x] `checkBlastRadius` fires before an un-analysed source mutation, capped,
      once per file, silent once `graph_affected` has run
- [x] `checkShipImpact` fires once on the first ship-shaped command
- [x] Both wired into the PreToolUse hook with telemetry, honouring `measure`
- [x] Test-pinned including no-graph projects and ordinary shell
- [ ] Not in scope: escalation to deny; the save_result/reflect loop; a
      `graph_summary`-at-turn-1 rule

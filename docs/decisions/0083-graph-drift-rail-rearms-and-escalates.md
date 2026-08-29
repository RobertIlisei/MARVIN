# ADR-0083 — The graph-drift rail re-arms on compliance, and escalates when ignored

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) (the nudge this fixes), Golden Rule 7

## Context

Measured on four real sessions of the user's project (2026-08-29), reads
(`Read`+`Grep`+`Glob`) against `graph_*` calls:

| session | tools | graph | reads | ratio | `graph_summary` |
|---|---|---|---|---|---|
| e78fd421 | 37 | 2 | 16 | 8.0:1 | 0 |
| 318d7c7b | 493 | 3 | 115 | **38.3:1** | 1 |
| 7248bf6a | 578 | 8 | 105 | **13.1:1** | 0 |
| 798c891a | 76 | 2 | 30 | **15.0:1** | 0 |

MARVIN's own `ToolUseCounter` bands call anything over 8:1 **critical**. Three
of four are critical; the fourth is on the line. The 2026-05-27 audit that
prompted this whole enforcement family measured ~7:1 — it has got **worse**.

The enforcement is not dead code (unlike [ADR-0079](./0079-subagent-tool-rename-and-rails.md)'s
rename). It fires exactly as designed, and the design is the problem. One
turn, from the sidecar log:

```
20:24:29  designhook.deny   Glob  graphCallCount:0        ← forced a graph call
20:26:48  graph.drift.nudge Grep  novelFiles:7  nudge 1/3
20:26:53  graph.drift.nudge Grep  novelFiles:8  nudge 2/3
                                                          ← then silence
```

`checkGraphifyFirst` is one-shot: a single graph call disarms it for the whole
turn. ADR-0060 added the drift nudge precisely to re-arm enforcement, and
capped it at 3 **per turn** — a budget spent in **five seconds**, after which
~100 further file operations ran unchallenged. ADR-0060's own comment predicted
the shape of this ("the gate was designed when turns were short; agentic turns
now run 30-80 tool calls"); its budget was simply an order of magnitude too
small.

Two secondary findings from the same measurement: `graph_summary` is
essentially never called, and only `graph_search` / `graph_query` are ever
used — `graph_affected`, `graph_change_impact`, `graph_community` and
`graph_save_result` are at zero. That is the "graph_search as a glorified
grep" pattern the 2026-05-27 audit named, still true.

## Decision

**1. Compliance re-arms the rail.** `graphifyNudgeCount` was monotonic per
turn; it now resets on any `mcp__marvin-graph__` call, alongside the existing
`novelFilesSinceGraph` reset. Answering a nudge with a graph query is the rail
working — it should restore the budget, not spend it. Coverage becomes
proportional to turn length instead of running out in the first minute.
`graphifyNudgeTotal` keeps the per-turn total for telemetry.

**2. Escalation to a deny when the advisory is ignored.** After
`GRAPH_DRIFT_DENY_THRESHOLD = 25` novel files with no graph query, the next
structural read is denied (`checkGraphDriftDeny`). Deliberately narrow so it
can never block implementation:

- **novel files only** — a file already in play this turn never counts, so an
  edit-read-edit loop is untouched;
- **structural tools only** — `Read`/`Grep`/`Glob`, never `Edit`/`Write`/`Bash`;
- **one deny per stretch**, cleared by any graph call, so complying unblocks
  immediately and the model can never be walled in;
- honours `MARVIN_DESIGN_HOOKS=measure`, which logs `graph.drift.deny.measured`
  instead of denying.

25 is chosen well above the nudge threshold of 7 so the deny can only be
reached by a model that was told three times and kept going.

### Considered and not taken

- **Lowering the deny threshold toward the nudge threshold.** A deny at 7-10
  novel files would fire during legitimate implementation bursts. The nudge is
  the right instrument there; the deny is a floor, not a policy.
- **A hard `graph_summary`-at-turn-1 requirement.** Real, and the measurement
  supports it, but it is a different rule with its own false-positive profile
  (trivial turns, follow-ups within a session). Deserves its own ADR rather
  than riding along here.

## Consequences

- Long turns keep enforcement instead of losing it after five seconds.
- The worst case — 25+ unguided novel files — now costs one denied read and a
  message naming the specific tool to use, rather than nothing.
- Risk: a genuinely exploratory turn that *cannot* use the graph (a project
  with no `graphify-out/`) is unaffected — `hasGraph` gates everything.
- Re-measure with the same query over `~/.marvin/sessions/<projectId>/*.jsonl`;
  the target is the healthy band (≤4:1), and anything still over 8:1 means the
  thresholds need another pass rather than the mechanism.

## Scope of Done

- [x] Nudge budget resets on any graph call; total kept for telemetry
- [x] `checkGraphDriftDeny` wired into `runDesignHooks`, honouring `measure`
- [x] Never blocks mutators or re-reads of files already in play
- [x] Test-pinned: re-arm, escalation, clear-on-compliance, no-graph projects
- [ ] Not in scope: a `graph_summary`-at-turn-1 rule; per-tool triggers for
      `graph_affected` / `graph_change_impact`

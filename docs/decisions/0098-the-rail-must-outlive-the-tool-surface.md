# ADR-0098 — The graphify-first rail must outlive the tool surface

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0097](./0097-verify-against-what-runs.md) (the CLI upgrade that exposed this), [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) + [ADR-0083](./0083-graph-drift-rail-rearms-and-escalates.md) (the rail being repaired), [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (the same class, first time), Golden Rule 7

## Context

ADR-0097 moved MARVIN from CLI **2.1.113** to **2.1.251**. That fixed the
plan-usage bars. It also, silently, removed two tools.

Probing both bundled CLIs directly — no MARVIN configuration involved:

```
CLI 2.1.113 → Grep: True   Glob: True
CLI 2.1.251 → Grep: False  Glob: False
```

`Grep` and `Glob` are **gone from the main agent's tool surface**, not
deferred: `ToolSearch` answered `select:Grep,Glob` with *"No matching
deferred tools found"*, twice in one session. MARVIN's own config is
innocent — `disallowedTools` carries only `ScheduleWakeup`.

The visible symptom was mild. MARVIN told the user:

> *"I couldn't load a grep tool in this session (only Read + graph tools
> available), so question 4 is answered methodologically rather than with a
> fresh sweep."*

Honest, and a downgraded answer.

**The invisible symptom is the reason for this ADR.** Golden Rule 7's
mechanical enforcement — `checkGraphifyFirst`, `checkGraphDrift`,
`checkGraphDriftDeny`, and the drift tally — keyed on `Read`, `Grep`, and
`Glob`. There was no `Bash` branch, deliberately: `Bash` is mostly
implementation, and the rails were written to never interrupt work. With
`Grep`/`Glob` gone, **searching moves to `Bash`, where the rail cannot see
it**. Measured across every session in the four hours after the upgrade:

| | |
|---|---|
| Bash calls | 18 |
| …search-shaped (`rg`/`grep`/`find`) | **15 (83 %)** |
| `graph_*` calls in the same window | **2** |

That is "grep and pray" — the exact failure Golden Rule 7 exists to
eliminate — routing around the mechanism built to stop it. The rule did not
change, the rule's enforcement quietly stopped applying, and nothing said so.

This is ADR-0079's lesson a second time. There, five guards matched the
literal `"Task"` and went dead when the tool was renamed `Agent`. Here, four
guards match the literal `"Grep"`/`"Glob"` and went dead when the tools were
removed. **A rail keyed on tool names is only as durable as the vendor's tool
names**, and the tool surface is not ours.

## Decision

**1. A search-shaped `Bash` call is a structural search.** `bashSearchTarget`
classifies it, and the tally, the head-of-turn deny, the drift nudge and the
drift deny all treat it exactly as they treated `Grep`.

**2. The classifier is conservative, because the false positive is worse than
the bug.** Denying a test run would be a far greater harm than a missed
search. Two rules do the work:

- **A search binary must lead its list segment's FIRST pipeline stage.**
  Splitting is on `&&`, `||`, `;` and newline — never on `|`. The pipe *is*
  the distinction: `rg "x" src | head` searches the tree, while
  `make smoke 2>&1 | grep FAIL` filters command output. A leading `cd` and
  env assignments are skipped, since that is the shape MARVIN actually writes.
- **The search root must resolve inside `cwd`**, matching what the `Grep`
  branch already required.

  The first version split on `|` as well, which made a filter
  indistinguishable from a search — `cat foo | rg x` classified as a search.
  A test written specifically for that case caught it before it shipped, and
  is kept.

**3. One predicate, not four copies.** `isStructuralSearch(ctx, toolName,
toolInput)` is the single place that answers "is this the act Golden Rule 7
governs", used by both drift rails. The next tool-surface change lands in one
function instead of four.

**4. Tell the model the truth.** `personality.ts` and the scout brief in
`sdk-runner.ts` said *"Grep and Glob are second-line tools"* — naming tools
that do not exist, which is how the session burned two `ToolSearch` calls
before giving up. They now say this CLI has no `Grep`/`Glob`, that
`ToolSearch` cannot recover them, that search is a `Bash` call, and that the
rail denies it exactly as it denied `Grep`.

`policy.ts` keeps its `Grep`/`Glob` entries. They are inert today and correct
again the moment upstream restores the tools.

## Consequences

- Golden Rule 7 is enforced again on the route searches actually take.
- The drift budget counts `Bash` searches, so the ADR-0083 escalation ladder
  measures reality rather than a tool nobody can call.
- **A test run can never be denied by this rail** — pinned by the negative
  cases, which are the assertions that matter most here.
- The standing lesson, third time (ADR-0079, ADR-0097, here): **verify against
  the surface that decides, and re-verify it after any upgrade.** A CLI bump
  is not a neutral act; it can add tools, rename them, or take them away, and
  every guard keyed on a literal name is a guard that can go quiet.

## Scope of Done

- [x] `bashSearchTarget` classifies search-shaped Bash, rooted in `cwd`
- [x] Wired into the tally, `checkGraphifyFirst`, `checkGraphDrift`,
      `checkGraphDriftDeny` via one `isStructuralSearch` predicate
- [x] Filters (`… | grep`), out-of-tree searches, and ordinary work Bash are
      NOT denied — pinned by assertion
- [x] Prompt text corrected in `personality.ts` + the scout brief
- [x] 9 new assertions; 1018 vitest, typecheck clean
- [ ] Not in scope: restoring a first-class search tool (e.g. registering an
      MCP `grep`). `Bash` + `rg` works and the rail now covers it; a new tool
      is a bigger change than this repair.

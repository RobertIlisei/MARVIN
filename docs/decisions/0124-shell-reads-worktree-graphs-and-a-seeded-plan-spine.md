# ADR-0124 — Shell reads go through the graph gate, each tab queries its own graph, and the sidecar seeds and holds the plan spine

- **Status:** Accepted — implemented 2026-09-30
- **Date:** 2026-09-30
- **Related:** [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) / [ADR-0083](./0083-graph-drift-rail-rearms-and-escalates.md) (the drift rail), [ADR-0098](./0098-the-rail-must-outlive-the-tool-surface.md) (`bashSearchTarget`), [ADR-0104](./0104-ship-review-gate.md) (the two-denies brake), [ADR-0105](./0105-practice-loop.md) (built-in gates as rows), [ADR-0041](./0041-project-graph-lifecycle-and-context-budget.md) (per-turn AST refresh), [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (worktree tabs, the watch feed), [ADR-0116](./0116-the-spine-has-two-writers.md) (the sidecar's spine writer), [ADR-0120](./0120-stalls-are-the-machine-asleep-and-a-turn-held-by-a-hung-search.md) (path-less search), Golden Rules 1, 6, 7 and 8 in `AGENTS.md`

## Context

Measured on 2026-09-30 across four agri-saas-platform tabs (tool_use blocks de-duplicated by id):

| Tab | graph_* | Read/Grep/Glob | shell cat/sed/head/tail | shell grep/rg |
|---|---|---|---|---|
| Plan B | ~300 | 286 | 504 | 390 |
| Plan A | ~150 | 90 | 242 | 188 |
| Plan C | ~100 | 59 | 155 | 92 |
| D1 | ~30 | 10 | 58 | 38 |

Four failures, each with the same root: the rule lived where the mechanism could not see it.

1. **The shell was a hole in the graph rail.** `bashSearchTarget` (ADR-0098) saw a search binary *leading* a Bash segment. `cat routes/_layout.tsx`, `sed -n 1,400p settings.tsx`, `head -200 x.ts` were invisible — to the gate, to the drift budget, and to the ratio. After one graph call a tab read files wholesale through the shell, ~3 per graph call, and Plan B's context was summarised mid-task.
2. **A worktree tab queried a graph that did not contain its own work.** Every graph tool read `<workDir>/graphify-out/`, built from the main checkout. A tab reported "graph is stale for platform.guidance; graph_affected found no callers" for code it had written.
3. **Nobody could see a tab's ratio while it ran.** The AppStatusBar showed the selected session only, and did not count shell reads.
4. **The plan spine went stale.** Plan B: ~5 TodoWrite updates across 57 commits; Plan A ~3 over ~10; chore tabs none. Steps read open hours after they were done, the Sessions view could not show progress, and the scope-met guard (ADR-0057/0116) read a stale spine. Every earlier fix was prompt prose, which this repo has measured at ~0× many times.

## Decision

### A. Bash source reads are structural reads

`classifyBashSourceAccess` (`bash-search.ts`) returns every source read or search a command performs: `cat`/`nl`/`less`/`bat`, `sed` (with `-n` line ranges measured), `head`/`tail` (counts measured), `awk` (NR ranges), `grep`/`rg`/`ag`/`ack`/`find`/`fd` — after `cd … &&`, through `for f in …; do cat $f`, through `xargs` fed by a tree listing, with quote-aware splitting (`grep -E "a|b"` is one stage) and heredoc bodies stripped. Never classified: filters downstream of a pipe, `sed -i`, heredoc writes, tests/builds/git/`wc`/`ls`, non-source files, logs, `/tmp`, build output, `node_modules`, `target/`, `.git/`, `graphify-out/`, test-report directories, anything outside the project. A path-less `rg` reads stdin in MARVIN's shell, so it is ADR-0120's shape, not a tree search. 23 tests pin real command shapes from the transcripts above.

It feeds the existing rail, not a parallel one: `checkGraphifyFirst` (first structural read of a turn, now including "Bash read"), the drift tallies (a file read charges per file and refunds on an Edit, like `Read`), and the practice extractor's `isSourceRead`.

New built-in gate **`builtin:graph-pointer`** (`checkGraphPointer`): once the graph has been asked this turn, refuse the two wide shapes and nothing else —

- a whole-file read of a source file over 200 lines;
- a search whose root is the repository, or a directory holding nothing a graph result pointed into this turn.

A PostToolUse hook lifts the source paths out of every `mcp__marvin-graph__*` result (`noteGraphResult`), repo-relative, so a pointer from either the project or a worktree graph matches a read in either tree. A line range ≤ 200 lines of any file, a search of named files, a search under a pointed directory, and a file this turn wrote always pass. The deny names the discharge: `sed -n 'X,Yp' <file>` at the location the graph returned, or ask the graph for what it has not shown yet.

**Ships measure-first** — native tier `nudge`: each violation is logged (`graph.pointer.nudge`) and the model told once per turn; the Practice pane promotes it to `deny`, which then carries ADR-0104's brake (two refusals per turn, then allow + `graph.pointer.bypass`). `MARVIN_DESIGN_HOOKS=measure` logs without either.

### B. Each worktree tab queries its own code graph

The cache lives **in the worktree**, `<worktree>/graphify-out/`, not under `<workDir>/.marvin/graph-cache/<slug>/`. Reasons: it is where `graphify update <worktree>` writes by default (no output redirection to maintain); its `source_file` paths are relative to the tree the tab sees; and it is deleted with the worktree, so there is no second lifecycle to sweep. ADR-0107's rule — `.marvin/`-scoped services key on `workDir` — is untouched: a code graph is a property of a tree, not of the project's bookkeeping. `graphify-out/` is added to the repository's `info/exclude` when the repo neither tracks nor ignores it, so it never shows in the tab's diff. The knowledge graph and graph work-memory stay project-scoped.

`resolveGraphRoot(workDir, cwd)` picks the worktree's graph when it exists, else the project graph with a note on every code-scope answer: *"(project graph; this worktree's changes are not indexed yet …)"* — so a missing caller reads as "not indexed", not "there are none". `createGraphMcpServer(workDir, { cwd })` resolves per call (the tab's graph can appear mid-session). `graph_change_impact` diffs the session's tree against its base and maps it with the worktree's graph.

Cost is ADR-0041's: `maybeRefreshWorktreeGraph` runs from the turn orchestrator at turn start and turn end, AST-only. The first build copies the project graph, manifest and extraction cache so the incremental update re-extracts only what the tab changed; per worktree it is debounced (60 s) and skipped when HEAD + `git status` are unchanged; per project one graphify process runs at a time and the rest queue.

### C. Every row shows its ratio

`graph-usage.ts` keeps three counters per session — graph calls, Read/Grep/Glob source reads, Bash source reads — folded into `<sessionsDir>/<sessionId>.graph-usage.json` at each turn's end and read live from the running turn's design context. `GET /api/sessions/watch` rows carry `graphUsage: { graphCalls, fileReads, bashReads, ratio }`; the Sessions pane shows `graph N · reads M (R×)` on every row. No transcript is parsed (ADR-0072).

### D. The sidecar seeds and holds the plan spine

Enforced in code, with no change to `personality.ts`:

- **Seed.** `seedTurnSpine` runs in `runAgent` before the SDK query — before the model's first tool call. A user message with a checklist (a Steps / Implementation heading, else a Definition of Done / Done when / Scope of Done / Acceptance criteria heading, else a top-level numbered list; ≥ 2 top-level items, checkboxes and bold ordinals stripped, nested bullets ignored — `PlanParser`'s rules where the two meet) becomes a `[1]…[N]` pending plan with `seeded: true`, active, and the session meta records `checklist`. A chore gets nothing; a wakeup never seeds; a plan with open steps is never replaced. The turn's reminder suffix lists the ordinals so the model's TodoWrite joins by tag (ADR-0049/0116).
- **Gate — commits.** Built-in **`builtin:plan-spine`**, native `deny`: in a tab with a seeded plan that still has open steps, a `git commit` is refused when the tab has committed before and no TodoWrite has run since. Discharge: TodoWrite with the `[N]` tags. ADR-0104 brake; measure mode logs.
- **Gate — scope-met.** The Stop hook refuses a scope-met close while a seeded step is pending (this turn's TodoWrite applied in memory first). Unlike the Stop hook's advisories it fires on machine turns too and inside the SDK's own continuation, and its brake is two blocks then allow + `plan.spine.close.bypass`.
- **No spine at all** in a checklist tab is open scope at the ADR-0057 reconcile, with the reason.
- **Auto-tick.** A background job that exits 0 whose command is a test run, the fast band or Playwright, or a merge of the tab's branch (`mergeWorktree`), closes the ONE open seeded step whose text names that kind. Zero or several candidates close nothing (ADR-0116: refuse to guess). An auto-tick does not move `lastTodoAt`.
- **Client saves** keep what only the server knows: `mergeClientPlanState` restores `seeded`, and keeps a seeded plan a client that never saw it would have erased.
- **Watch rows** carry `plan: { done, total, open, lastTodoAt, seeded }`; the Sessions pane shows `n/m steps · updated X ago`, flagged ⚠︎ when steps are open, the list last moved 30+ minutes ago and the tab has worked since.

## Consequences

- A tab now pays a graph call before its first shell read, as it already did before its first `Read`. The graph-pointer gate costs nothing until promoted; its telemetry says what promotion would refuse.
- The classifier is a shell-shaped heuristic. Known gaps: a read inside `python -c`/`node -e`, `git show HEAD:file`, and command substitution are not classified; a path held in a variable set outside a `for` list is not resolved. Each fails open.
- A worktree graph costs disk (a copy of the project's graph and cache per tab) and one AST update per changed turn, serialised per project.
- The commit gate's memory of "the previous commit" is process-local: a sidecar restart lets one commit through unchecked, never a false refusal.
- Auto-tick can close a step whose text names a kind loosely ("tests" matching "write tests for X" when a green run proves only that tests pass). It refuses when two steps qualify; a single loose match is ticked and the model sees the tick in the completion turn.

## Scope of Done

- [x] `classifyBashSourceAccess` + tests over ≥ 15 real command shapes; graphify-first, drift tallies and `isSourceRead` use it; `checkGraphPointer` + pointer capture; `builtin:graph-pointer` at native `nudge`; gate tests (deny tier, narrow reads pass, brake, measure, worktree paths)
- [x] `worktree-graph.ts`; `createGraphMcpServer(workDir, { cwd })` with the fallback note; turn-start/turn-end refresh; test with a temp repo + worktree (hand-built graphs, and a real `graphify update`)
- [x] `graph-usage.ts`; `graphUsage` on watch rows; Sessions pane shows it; test counting Bash reads
- [x] `plan-seed.ts` (parse, seed, reminder, auto-tick, client merge); `builtin:plan-spine` commit gate; Stop-hook scope-met block; no-spine gap; job and merge auto-tick; `plan.{open,lastTodoAt,seeded}` on watch rows and the pane; tests as listed in D
- [x] AGENTS.md firm surfaces, roadmap and CHANGELOG updated; sidecar suite and Swift build green; `graphify update .` run

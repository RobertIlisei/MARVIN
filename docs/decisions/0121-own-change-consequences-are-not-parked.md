# ADR-0121 — A break your own change caused is part of the change: cross-layer impact, a commit gate, and a scope-met check

- **Status:** Accepted — implemented 2026-09-28
- **Date:** 2026-09-28
- **Related:** [ADR-0057](./0057-workflow-completion-guard.md) (scope-met reconcile guard), [ADR-0084](./0084-blast-radius-and-pre-ship-impact-nudges.md) (`graph_change_impact`, the advisory pre-ship nudge), [ADR-0100](./0100-advisor-caveats-are-conditions-not-backlog.md) (conditions belong to the close), [ADR-0104](./0104-ship-review-gate.md) (the commit gate and its two-denies brake), [ADR-0044](./0044-project-backlog.md) (the backlog is a parking lot), Golden Rules 6 and 8 in `AGENTS.md`

## Context

On 2026-09-28 five parallel worktree tabs on a real project each finished with "scope met", `pr-review` run, and — in most of them — `graph_change_impact` run. Three of them had broken something outside their own files, **described the break precisely in a backlog item, and declared the scope met anyway**:

1. A backend enum gained `DOVADA_DEPUNERE_AUTORITATE`; the OpenAPI spec, the generated TypeScript types and the UI label table never learned it.
2. An API endpoint began checking the *acting* tenant under delegation; the web page that calls it by URL string still sent the home tenant, so it 403s.
3. `garage.toml` moved to `rpc_secret_file`; the disaster-recovery restore script, which mounts that file by name, can no longer start Garage.

Detection worked — MARVIN found each break itself. Two things let it ship regardless:

- **The impact report could not see these consumers.** `graph_change_impact` follows `calls` edges. An enum listed in a YAML spec, a route called from a template string and a config file mounted by a shell script have no call edge to the change. The report said "no external callers" and was correct about calls.
- **The rules said "park it".** Golden Rule 8 (match, don't improve) and the prompt's backlog guidance tell MARVIN to park anything outside the request. That is right for a pre-existing problem found in passing and wrong for a break its own commit just made — and nothing distinguished the two. The orchestrating session's write-set rule ("anything outside your set goes to the backlog") made it worse.

Separately, while reading the ADR-0057 guard: it only recognised ADR edits under `docs/decisions/`, so on a project that keeps ADRs in `docs/adr/` its "Scope of Done entirely unticked" check had never fired.

## Decision

1. **Cross-layer references in `graph_change_impact`** (`graphify-bridge/src/cross-layer-refs.ts`). Beside the call-graph callers, the report now lists files *outside* the branch that name something the branch changed, found by one `git grep`:
   - a changed config / script / infra file referenced **by file name** (`garage.toml` from a restore script);
   - a constant or config key the branch **removed and no longer has anywhere** (`UPPER_SNAKE` in any code; lowercase keys only from key position in config files, so prose never counts);
   - a **path segment** from a path literal on a changed line, or anywhere in a changed file that has at most three (`ppp-professional-user` from a small controller, found in the page that fetches it);
   - a **parity gap**: a value the branch adds in list-item position among sibling constants, **new to the repository**, where a file outside the branch lists the siblings but not the new value (the OpenAPI enum). Shell and config files, docs, tests and migration history are not parity sources or targets.
   The rules are about token shape, never a stack, framework or project (Golden Rule 6). Hits in prose are skipped, dotfiles and tests are listed after real consumers, too-common tokens are dropped and named, generated output and MARVIN's own state are ignored. It is labelled as text matching, not proof.
   Tuned against three live branches before landing: the first cut listed dozens of harmless hits per branch (existing enum values re-listed by a migration, shell variables, kebab words in comments); the landed rules report the DR-script break at its exact lines and nothing on the branches that broke nothing.
2. **The ship-review gate also requires the impact report** (`checkShipImpactRequired`, merged into the `builtin:ship-review` gate so its tier / on-off switch in the Practice pane covers both). A `git commit` that ADR-0104 would require a review for is refused until `graph_change_impact` has run this turn, and the refusal says to act on callers *and* cross-layer references — fix them here, or name them in the commit message as knowingly left. Same brakes: measure mode logs, two refusals per turn then allow and log `ship.impact.bypass`. The ADR-0084 advisory nudge stays for pushes and MRs.
3. **The scope-met guard sends own-change consequences back** (`ownChangeConsequences` in `workflow-guard.ts`, wired in `sdk-runner`). At a scope-met close, the provisional backlog items this session parked are matched against what the session's own changes touched — for a worktree tab its first-parent, non-merge commits plus uncommitted files (`sessionOwnChanges`), for a shared tree the files written this turn — by path, distinctive basename, class-like stem, ADR number, and branch. Any match fires a corrective turn: fix it now whatever the write set said and `done` it; or `keep` it with a line saying why the change did not cause it; or leave it and do not claim scope met. A false match costs one honest sentence; a miss ships a known break.
4. **The prompt stops contradicting the guard** (`personality.ts`): Phase 7 and the backlog paragraph now say a break your own change caused is part of the change, not an improvement to offer or an item to park.
5. **ADR recognition covers `docs/adr/` too** in the guard's edited-ADR tracking, matching `note-links.ts`'s `ADR_DIRS`.

Not done, deliberately: a separate built-in practice row for the impact gate (one gate, one switch), and any automatic fixing — the guard asks, the executor decides and says which.

## Consequences

- A reviewable commit costs one `graph_change_impact` call per turn, which most tabs already made. The report grows a section; on a change with no textual consumers it reads "(none found)".
- The textual pass is a heuristic. It will name some references that are harmless (a constant mentioned in a doc outside `docs/`, a route segment reused elsewhere); the executor reads the list and decides. It cannot see consumers that share no literal token with the change (a behaviour change with an unchanged signature) — the call graph and the review skills still carry that.
- An orchestrating session's narrow write sets no longer produce silent breaks: the gate and the guard both say, in so many words, that a consequence of your change is yours to fix whatever the set said.
- The ADR-0057 unticked-Scope-of-Done check now fires on projects with `docs/adr/` — expect it to catch closes it previously let through.

## Scope of Done

- [x] `cross-layer-refs.ts` wired into `graph_change_impact`; `changedFilesOnBranch` returns the merge base; 5 tests rebuilding the three real breaks (enum parity gap, config file named by a script, route called by URL string) plus own-file exclusion and segment extraction; run against three live agri-saas branches
- [x] `checkShipImpactRequired` merged into the ship-review gate; 2 tests (refuse until the impact call, then allow; small / docs-only / graphless exemptions and the two-denies brake)
- [x] `ownChangeConsequences` / `ownChangeTokens` in the reconcile gap and prompt; `sessionOwnChanges` in `worktrees.ts`; wired in `sdk-runner`; 5 guard tests using the real item texts plus 1 worktree test (own and dirty files, not merged-in ones)
- [x] `personality.ts` Phase 7 and backlog wording; the edited-ADR matcher covers `docs/adr/`
- [x] Runtime and graphify-bridge suites green, typecheck clean
- [x] App rebuilt and restarted with the change (`0.1.114+964ad3aa`)

## Addendum 2026-11-26 — a hand-over, and a brake

**What happened.** One tab (a terms rewrite on a real project) finished and committed. A provisional item it had parked named the redline it wrote, so decision 3 sent it back at every scope-met close, five times in four hours (23:08, 23:59, 00:46, 01:15, 01:39). The item waited on a branch the tab may not merge, and the supervisor had taken it over ("not part of this tab's scope any more"). None of (a) fix it, (b) keep it as pre-existing, (c) leave it and do not claim scope met is true of that item, and (c) *is* the loop: leaving it open and not closing, for ever. The tab never wrote the marker; its branch was queued by hand. The check had no brake (every other close gate here has ADR-0104's: two refusals, then through), and no answer for "this is someone else's".

**Decision.**

1. **`Handed over: <item-id> to <who> — <reason>`**, one line of the final message, the same shape as ADR-0138's `Skill not used:`. For an item in the gap it writes a dated `> note` on the item (`handed over to <who>: <reason>`, never more than 300 characters of reason), leaves it `provisional`, and ends the question. It is not `keep` and not `dismissed`: consent to keep or dismiss stays with the user (ADR-0047), and a model's own say-so never promotes it. A recipient and a reason are both required, a line naming an item that is not in the gap writes nothing, and a note the item cannot take (the notes cap) leaves the item asked about. Machine turns need no special case: the corrective turn is a wakeup and its final message is read the same way, so a supervised tab with no human present can answer.
2. **The brake.** One item refuses a session's close at most twice (`OWN_CONSEQUENCE_MAX_BLOCKS`, counted on the session meta as `ownConsequenceBlocks`, so a restart does not reset it). The third close is allowed; `own.consequence.bypass` is logged and a dated note says so on the item, which stays provisional for the user. `own.consequence.block` and `.handover` are logged too, beside the existing `workflow.reconcile` line.
3. **The refusal says what may be answered**: (a) fix, (b) keep as independent, (c) the `Handed over:` line, (d) leave it and do not claim scope met, and the brake sentence. The prompt and tool descriptions are unchanged (`personality.ts` only says the guard sends consequences back).

`own-consequence-close.ts` holds the I/O, `workflow-guard.ts` the pure parts. Not done: a Practice-pane row for this check (still one gate, as in the original decision), and any change to what the matcher flags.

### Scope of Done (addendum)

- [x] A hand-over line ends the asking and writes a dated note; the item stays `provisional`.
- [x] Two refusals per item per session, then the close is allowed and the bypass is logged and noted; the count survives a restart.
- [x] The refusal text names the line and the brake; items the tab can resolve are still asked about.
- [x] 11 tests in `tests/own-consequence-close.test.ts`; the existing guard tests unchanged.


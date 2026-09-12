# ADR-0116 — The plan spine has two writers, and a claim does not check itself

- **Status:** Accepted — implemented 2026-09-11
- **Date:** 2026-09-11
- **Related:** [ADR-0046](./0046-plan-as-durable-spine.md) (the plan is the spine), [ADR-0049](./0049-plan-step-join-key-and-rollup.md) (the `[N]` ordinal join), [ADR-0052](./0052-durable-plan-spine-and-plan-file-ownership.md) (the durable store, client-owned), [ADR-0057](./0057-workflow-completion-guard.md) (the scope-met reconciliation guard), [ADR-0031](./0031-self-scheduled-wakeups.md) / [ADR-0038](./0038-background-jobs-event-wakeups.md) (the turns nobody watches), [ADR-0106](./0106-plan-snapshot-semantics-superseded-subtasks.md) (snapshot semantics), [ADR-0112](./0112-one-place-for-each-thing.md) (one place for each thing)

## Context

The user, with two screenshots:

> *"why does marvin say that he finished implementation but the plan still has
> opened items unfinished. we tried to fix this issue, where the plan doesn't
> update or its not followed."*

The session is real and reconstructable: `7958eaf2`, project
`users-robertilisei-projects-agri-saas-platform`, 2026-09-11. MARVIN closed
with the scope-met sentinel and *"fully delivered across all 14 plan steps"*,
naming three commits. The plan strip read **8/14** with six steps open. Both
statements were sincere and one of them was wrong.

Fourteen `TodoWrite` calls ran in that session. The stored spine is
byte-for-byte the ninth of them.

| `TodoWrite` at | Turn kind | Rows completed | Reached the plan |
|---|---|---|---|
| 19:44:43 | human | 8 | yes |
| 19:57:22 | wakeup | 9 | no |
| 20:09:05 | wakeup | 10 | no |
| 20:29:30 | wakeup | 11 | no |
| 20:33:59 | wakeup | 12 | no |
| 20:46:37 | wakeup | 14 | no |

The boundary is exact: the last batch of the last turn the user typed into
landed, and every batch after it was lost. Each of those turns opened with
`[scheduled wakeup — background job done: …]`.

Three mechanisms failed, in order.

**1. The spine had one writer, and it was the wrong one.** ADR-0052 made the
spine durable and left the macOS client as its only author: it ingests each
`TodoWrite` off the live event stream, reconciles, and PUTs. `writePlanState`
has no caller in the sidecar; the runtime only ever read it back. That is a
client-derived record of a server-driven process. The sidecar runs turns
whether or not anything is attached, and re-attaching to a server-started turn
is gated on the announced session being the one on screen. So a turn that ran
while the user was in another tab advanced the work and could not advance the
plan. During the same window, the neighbouring tab's spine updated normally,
which is why the two sessions disagreed about whether MARVIN was working.

**2. Hydration then overwrote the fresher record with the staler one.** Replay
applies the last `TodoWrite` in the tail — the one path that would have healed
this. ADR-0052 deliberately assigns the stored spine straight after, *"so it
wins"*, and rewrites the plan file to match. That ranking is right about plan
**structure**, which the 200-event tail genuinely loses, and wrong about
**progress** the moment the spine is the older of the two. Every switch back
into the session re-imposed 8/14.

**3. The completion guard asked the claim to check itself.** ADR-0057 uses
this turn's `TodoWrite` when one ran and consults the spine only when none did,
reasoning that a debounced PUT *"can't be racily stale"*. That reasoning
assumes the client always ingests. The closing batch said all fourteen rows
`completed`, so `openTodos` returned empty, there was no gap, and no corrective
turn fired. The one mechanism built to catch a premature "done" was reading the
premature "done" as its evidence.

One aggravating factor sits underneath. An auto-compaction fired four minutes
before the close, 968k tokens down to 22k. The batch that followed came back
**untagged and reworded from the summary** — `Write ADR-0384` where the step
reads `[3] Write ADR-0384 (agri-adr-authoring skill, INDEX.md, memory note…)`.
The `[N]` ordinal is the join key (ADR-0049). Without it that batch closes
nothing, however confident it sounds — and had it been ingested it would have
been worse than useless, nesting fourteen completed rows as sub-tasks of step 9.

## Decision

### The sidecar is the spine's second writer

`plan-spine.ts` applies a `TodoWrite` batch to the stored spine at turn end,
for every turn that emitted one. Progress is recorded whether or not a client
is attached, which is the whole point.

It uses **only** the deterministic `[N]` / `[N-M]` tag join, and only on the
active plan, and only to move top-level step `status`. No fuzzy content
matching, no sub-task nesting, no upward roll-up, no ADR-0106 supersession —
those stay once, in `PlanModel.swift`. A second implementation of the fuzzy
half is two places for one thing (ADR-0112), and the failure mode of drift
there is two defensible answers to *"is this step done"*, which is the problem
this ADR exists to end.

The re-base guard is ported at its arithmetic signatures only (tags exactly
`1..K` for a K that disagrees with the step count). The Swift guard has a third
signature that needs the text matcher, so this side is **strictly more
conservative**: a batch the client would have trusted may be skipped here. That
costs one honest reconciliation turn. It never closes a step the client would
not have.

The consequence is chosen rather than tolerated: when a batch cannot be joined,
the server leaves the spine alone and the step stays open. An unmarked box
costs a turn; a falsely ticked one costs the user their ability to read the
plan at all.

### The guard reads both, and either one can say "open"

`mergeOpenItems` unions the spine's open steps with the batch's open todos.
They are not redundant — the spine carries steps the executor forgot it had,
the batch carries tier-1 items that were never plan steps. The spine is
projected immediately before the guard reads it, so it is this turn's truth,
which is what makes the union safe to act on.

When the closing batch carried no usable tag against a live plan, the
corrective prompt says so and says what to do: the ordinal is the join key,
re-read the plan, re-emit the full list tagged. Without that the executor reads
the open list as a disagreement about the work and re-states the same untagged
claim.

### The two sources are ordered, not ranked

The spine gains `lastTodoAt`, stamped with the turn's end whenever the server
joins a batch. On hydrate the client restores structure from the spine as
before, then layers the replayed batch back on top **only when its transcript
timestamp is later than that watermark**. A spine with no watermark is one no
server has projected; there is no evidence, nothing changes, and ADR-0052's
guarantee holds unchanged for every legacy session.

### The prompt is told what a compaction costs it

A compaction keeps a summary, not the last `TodoWrite`, so the step wording and
the tags are the first casualties. The plan-spine section now requires reading
the active plan back before the next `TodoWrite` after a compaction, and
re-emitting the full list with tags and the plan's own wording.

### Considered and not taken

- **Porting the whole Swift reconcile to TypeScript.** Rejected on ADR-0112:
  the deterministic join is small and stable, the fuzzy half is neither.
- **Applying an untagged batch positionally when the row count matches the
  step count.** It would have been exactly right for this session, which is
  what makes it tempting. Rejected: it is indistinguishable from the re-based
  list ADR-0052 exists to refuse, and the payoff for guessing right is a tick
  while the payoff for guessing wrong is a false one.
- **Auto-ticking on the model's claim.** Already rejected by ADR-0057 and
  rejected again here for the same reason.
- **Keeping the client the sole writer and making it attach to every session.**
  Rejected: that makes durability depend on a UI being open, which is the
  assumption that failed.

## Consequences

- A plan advances during turns nobody is watching, which is most of a long
  session's turns.
- "Scope met" can no longer be cleared by the claim that prompted the check.
- The spine and the transcript can disagree without one silently erasing the
  other.
- The server writes the same file the client PUTs. Both do read-modify-write on
  a small file and the last writer wins; when a client is attached it has
  already applied the same batch, so the two converge on the same statuses.
  Structure is only ever written by the client.
- A batch the sidecar refuses to join leaves steps open and costs one
  reconciliation turn. That is the intended direction of the trade.

## Scope of Done

- [x] `plan-spine.ts` — tag parse, `stepsClosedByBatch`, conservative
      `looksRebased`, `applyTodosToSpine` with copy-on-write and total
      defensiveness against the client's shape
- [x] `sdk-runner` projects the last batch of every turn into the spine and
      persists on `joined`, stamping `lastTodoAt`; failures never break a turn
- [x] The guard unions spine and batch via `mergeOpenItems`, and names an
      untagged close for what it is
- [x] `PlanSpineWatermark` orders the two sources; hydrate layers a newer
      replayed batch over the restored spine and leaves legacy spines alone
- [x] `personality.ts` requires re-reading the plan before the first
      `TodoWrite` after a compaction
- [x] 18 sidecar tests on the projection (including the 2026-09-11 untagged
      batch, reproduced), 6 on the guard's new behaviour, 9 Swift assertions on
      the watermark; full suite + typecheck + `swift build` green

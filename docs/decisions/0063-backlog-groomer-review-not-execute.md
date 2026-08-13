# ADR-0063 — Backlog groomer: the review half of the loop, without the execution half

**Status:** Accepted — 2026-08-12
**Touches:** new `backlog-groom.ts` (pure analysis + renderer), `backlog-mcp.ts`
(`backlog_groom`, read-only), `backlog.ts` (exports `extractPathRefs`),
`personality.ts` (firm surface). Builds on
[ADR-0044](./0044-project-backlog.md) + its overlap addendum and
[ADR-0047](./0047-backlog-capture-at-discovery.md). **Does not amend
ADR-0044 §5** — see "What this is not".

## Context

The user asked for a loop: *"each time I activate the loop, MARVIN will review
the backlog items, update them if necessary, mark as done, change priorities and
start to work on them, autonomously."*

That is two features with very different blast radii, and they were worth
separating before writing any code:

1. **Review** — find what's wrong with the backlog. Read-mostly, reversible,
   immediately useful.
2. **Execute** — pick items and do the work unattended. Requires amending the
   anti-Kanban invariant, and inherits every failure mode of unattended agents.

This ADR ships (1). (2) is deliberately unbuilt.

### The problem review solves

Capture is un-gated at discovery (ADR-0047), so the backlog accumulates by
design: near-duplicates exact-slug dedup can't see, provisional items nobody
reviewed, open items whose work quietly landed, references to files that moved.
`MAX_OPEN_ITEMS` went 50 → 200 because a real project hit 50 through ordinary
use — the rail was the symptom. A backlog that only grows stops being read, and
an unread backlog is the same as no backlog.

### What the external guidance says

Anthropic's [long-running agent harness
guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
documents the failure modes of exactly the loop that was requested: agents
declare work complete prematurely, mark features done without testing, and
attempt too much at once. Their remedy is a **structured, external stopping
condition** — a checked feature list — rather than the agent's own judgement of
"done".

The [agent-autonomy research](https://www.anthropic.com/research/measuring-agent-autonomy)
cuts the other way and is worth taking seriously: requiring humans to approve
every action *"will create friction without necessarily producing safety
benefits"*, and experienced users move toward outcome monitoring rather than
per-action approval. So the answer is not "gate everything".

The [trustworthy-agents
framework](https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents)
resolves the tension: humans retain control *"particularly before high-stakes
decisions are made"* — **before**, not during.

Reviewing is not a high-stakes decision. Resolving someone's parked work is.

## Decision

**`backlog_groom` reports; it never mutates.**

`groomBacklog(items, opts)` is pure — `now` and file existence are injected —
and emits findings of five kinds:

| Kind | Trigger | Suggested to the user |
|---|---|---|
| `duplicate` | similarity ≥ threshold (ADR-0044 addendum) | merge, or resolve the covered one |
| `unreviewed` | `provisional` ≥ 7 days | keep or dismiss |
| `dangling-reference` | names a path (with a directory) that no longer exists | did this land? did the path move? |
| `aging-high-severity` | `high` + `open` ≥ 14 days | do it, or downgrade |
| `stale` | live + untouched ≥ 30 days | still wanted? |

Design points that are load-bearing rather than incidental:

- **Duplicates are clustered and reported once.** Reported from both sides a
  two-item cluster reads as two problems.
- **Staleness is suppressed on an already-flagged item.** "And it's also old"
  appended to a concrete finding is noise.
- **The file check is skipped entirely when no `fileExists` is supplied**, and
  bare filenames (no directory component) are never checked. Without a workdir
  every path looks missing; `README.md` can't be resolved to one file. One
  fewer check beats a report full of phantoms.
- **A path outside the project is treated as present.** We can't verify it, and
  reporting an unverifiable path as gone would be a lie.
- **Findings are capped and the report SAYS it capped.** A silent truncation
  reads as a clean sweep.
- **The rendered report tells the model these are heuristics** and forbids
  acting on them — the instruction travels with the data, not only in the
  system prompt.

## What this is not

**Not autonomous execution.** ADR-0044 §5 stands unamended: the backlog *"never
triggers work autonomously — promotion to a plan/turn is always a user
action."* `personality.ts` states that grooming a surfaced item is not
permission to start it.

Worth recording precisely, because it is narrower than it first appears: a
single MARVIN session looping on its own backlog would **not** violate Golden
Rule 1. That rule targets multi-agent dispatch and error amplification in "bag
of agents" topologies; one session in a loop is still a single assistant. What
an executor loop *would* violate is ADR-0044 §5 and ADR-0047's consent model.
That is a real amendment, and it needs its own ADR.

**Phase 2, if it is ever built, needs at minimum:** a per-item
`approved-for-auto` state (consent granted **before** the work, per item — the
"humans in control before high-stakes decisions" principle, without per-action
friction); a definition of done on the item, so the stopping condition is
external rather than the agent's opinion; one item per cycle; verification that
actually runs before anything is marked done; work on a branch, never main; a
hard stop on first failure; and a digest the user reads. None of that exists.

## Consequences

- The groomer is one MCP tool and a pure function; nothing about it can lose
  work, so it needs no consent gate of its own.
- It reuses the similarity scoring from the ADR-0044 addendum, so duplicate
  detection has one definition, not two.
- Thresholds (30 / 7 / 14 days) are guesses calibrated on nothing. They are
  parameters, and `staleDays` is exposed on the tool; expect to tune them once
  there's a real backlog to run it against.
- It does not answer "which item should I do next?" — it answers "what's wrong
  with this list?". Prioritisation advice would be the natural next increment,
  and is still short of execution.

## Scope of Done

- [x] `groomBacklog` pure (injected `now` + `fileExists`), five finding kinds,
      clustered duplicates, capped with an explicit `truncated` flag.
- [x] `renderGroomReport` states the findings are heuristics and forbids acting
      on them.
- [x] `backlog_groom` MCP tool — read-only, path resolution sandboxed to the
      project workDir.
- [x] `personality.ts` firm surface: MUST run / MUST relay / MUST NOT act /
      MUST NOT start work.
- [x] 15 unit tests covering what it flags, what it deliberately leaves alone
      (resolved items, bare filenames, no-workdir, double-flagging, unparseable
      dates), ordering, and the cap.
- [x] ADR-0044 §5 left intact; Phase 2 preconditions recorded, unbuilt.

---

## Addendum (2026-08-12) — giving it a trigger

**Context.** The groomer shipped as an MCP tool and nothing else. The user
restarted, went looking for it, and asked: *"where is the backlog groomer?
where can I see it? where can I activate it?"*

That was a real gap, not a misunderstanding. `backlog_groom` could only be
invoked by describing it in a sentence, and its output existed only as chat
prose. A capability with no affordance is half a feature — and the Phase 1
write-up said "installed" without saying where to click.

Note also why it fell through the cracks: the slash-command catalog is
assembled from skills on disk plus whatever the SDK reports. An in-process MCP
tool appears in **neither**, so nothing surfaced it automatically.

**Decision — two surfaces, both read-only.**

1. **`GET /api/backlog/groom`** + a **"Review" button** in the macOS Backlog
   panel. Findings render as orange annotations *on the rows they concern*,
   with a summary bar stating the count and that nothing was changed. The row's
   existing buttons remain the only way to act. Design points worth keeping:
   - findings whose item the current filter hides are **counted separately and
     announced**, so the summary never implies rows the user can't see;
   - an empty result says so explicitly — a silent no-op is indistinguishable
     from a broken button;
   - "Clear findings" dismisses the annotation layer, and says nothing was
     changed.

2. **`/groom`**, a MARVIN-**native** slash command. `NATIVE_COMMANDS` in
   `slash-commands.ts` carries name + description + an `expansion`; the chat
   route swaps the expansion in on the way to the SDK while the persisted
   `turn.user` keeps what the user typed — the same split `planContext` uses.
   Native entries are merged last and unconditionally, so a same-named skill in
   some project can't shadow them. Expansion fires only when the command is the
   whole message: *"what does /groom do?"* is prose, not an invocation.

The expansion instructs the model to run the tool and relay findings, and
explicitly forbids resolving, merging, re-prioritising, editing, or starting
work — the same contract as the tool description and the rendered report, now
stated at the third and last place a caller could enter from.

**Consequences.** Three entry points (tool, panel button, slash command) share
one implementation in `groomBacklog`, so the panel and the model can never
disagree about what's wrong with the backlog. The read-only property is
structural at every layer: no write path exists in `backlog-groom.ts`, the
route is GET-only, and the panel treats findings as an annotation layer.

## Scope of Done — addendum

- [x] `GET /api/backlog/groom` — read-only, `validateProjectCwd`, path checks
      sandboxed to the project root (unverifiable paths reported as present).
- [x] `BacklogService.groom` + `BacklogFinding`; panel "Review" button, summary
      bar, per-row annotations, hidden-finding count, clear action.
- [x] `NATIVE_COMMANDS` + `expandNativeCommand`, merged unconditionally into the
      catalog; chat route expands for the SDK only.
- [x] 6 new slash-command tests (catalog presence, no shadowing, expansion
      content, args, non-invocation prose, case). 619 suite-wide; `tsc` clean
      for runtime + sidecar; `swift build` + 167 Swift assertions green.

---

## Addendum 2 (2026-08-13) — a count you can't navigate to

**Observed.** The user ran Review on a real backlog (406 items, 66 live), got
*"22 findings — these are suggestions, nothing was changed"*, and replied:
*"i can't see any suggestion."*

The findings were rendering correctly. They were on rows **7, 9, 30, 32 … 66**.

The cause is structural, not cosmetic: findings land on **stale** and
**duplicate** items, which are old by definition, and the panel's default sort
is **Newest**. So every flagged item is pushed below the fold *by construction*
— the more useful the finding, the further down it sits. The top four rows were
genuinely clean.

**Decision.**

- A review that finds something now sets **`onlyFlagged`**, narrowing the list
  to the flagged items. Pressing Review means "show me what's wrong"; leaving
  the user to hunt through 66 rows does not.
- The summary bar states which mode it's in and carries an **"Only flagged"**
  toggle, so the narrowing is visible and one click to undo. "Clear findings"
  resets it too.
- The summary now reports findings **and the item count** they sit on (22
  findings across N items), since those differ.
- `unmatchedFindingSummary` was rebased on the *reachable* set (severity /
  resolved filters) rather than the visible one — otherwise turning on
  `onlyFlagged` made it claim every other finding was "hidden".
- Annotations were extracted into `findingAnnotations(for:)` and added to
  `provisionalRow`. `unreviewed` targets provisional items specifically, so
  that kind was previously counted in the summary and rendered **nowhere**.

**The lesson.** Both Phase 1 misses were the same shape: a capability delivered
without a way to reach it — first no trigger, then no navigation. Building the
analysis is the easy half; the surface is where it becomes usable.

## Scope of Done — addendum 2

- [x] `onlyFlagged` filter, auto-enabled by a productive review, reversible from
      the summary toggle and cleared with the findings.
- [x] Summary reports findings + distinct items, and states the current mode.
- [x] `unmatchedFindingSummary` rebased on reachable items, not visible ones.
- [x] `findingAnnotations(for:)` shared by both row builders, closing the
      `unreviewed`-on-provisional rendering gap.
- [x] `swift build` clean; 619 vitest + 167 Swift assertions green.

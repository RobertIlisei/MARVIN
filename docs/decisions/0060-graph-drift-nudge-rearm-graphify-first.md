# ADR-0060 — Graph drift: re-arm graphify-first mid-turn as a nudge, not a wall

**Status:** Accepted — 2026-07-25
**Touches:** `design-hooks.ts` (`checkGraphDrift`, novel-file tracking on
`DesignTurnContext`, `additionalContext` emission in the PreToolUse adapter).
Fixes the one-shot limitation of the graphify-first hook introduced with the
design hooks; enforces Golden Rule 7 / cross-phase rule 6 in `personality.ts`.
Same "prose MUST → mechanical enforcement" pattern as
[ADR-0055](./0055-checkback-promise-auto-arm-guard.md) and
[ADR-0057](./0057-workflow-completion-guard.md).

## Context

Observed by the user: MARVIN queries the knowledge graph during the first
iterations of a plan, then stops and just reads files. Measured across four
real agri-saas sessions (2026-07-24 transcripts):

| session | tool ops | graph | file ops | ratio | last graph call |
|---|---|---|---|---|---|
| a8f6872c | 32 | 4 | 28 | 1:7 | 66 % through |
| 1a348686 | 31 | 5 | 26 | 1:5 | 58 % |
| 60011f41 | 81 | 7 | 74 | **1:11** | 53 % |
| 3521f2fb | 47 | 5 | 42 | 1:8 | 45 % |

Graph calls cluster in the first half and then flatline. In the 81-op session,
deciles 7-10 contained **zero** graph calls but 19 reads and 14 grep/globs.
This is the "grep and pray" failure mode Golden Rule 7 exists to eliminate, and
it is a regression against the 2026-05-27 audit that found ~7:1 drift and
responded by hardening the *prose* — it is now 1:5 to 1:11, the same or worse.

It also directly drives context exhaustion: those reads ARE the transcript. A
session showing 166K/200K had 121K of "transcript", against 42 file reads.

**Root cause is structural, not model laziness.** `checkGraphifyFirst` has four
short-circuits:

```ts
if (!ctx.hasGraph) return null;
if (ctx.graphifyHookFired) return null;   // fires once per turn
if (ctx.graphCallCount > 0) return null;  // ONE graph call disarms it for the turn
if (ctx.sourceFilesRead > 0) return null; // one prior read disarms it too
```

It is a **one-shot gate at the head of a turn**: first Read → deny → the model
queries the graph → `graphCallCount = 1` → hook permanently disarmed → the
remaining 70+ tool calls run unguarded. One graph call at the top of a turn buys
unlimited reads. The gate was written when turns were short; agentic turns now
run 30-80 tool calls.

## Decision

Re-arm graph enforcement **within** a turn, as an advisory nudge gated on
*novel-file* drift.

### 1. Drift is measured in NOVEL files, not reads

`DesignTurnContext` gains `seenSourceFiles: Set<string>` and
`novelFilesSinceGraph: number`. Only a source file **not already opened this
turn** increments the counter; any graph call resets it to 0.

This asymmetry is the load-bearing part. **Late-turn reads are frequently
legitimate** — when MARVIN is editing a file it already located, re-reading it
is correct work. The graph helps you FIND code; it does not help you WRITE it.
A naive "re-arm after N reads" would fire during exactly the phase where
reading is right, produce false denials, and train the user to disable the hook.
Charging only *previously unseen* files targets unguided exploration and leaves
implementation alone.

Project-tree `Grep`/`Glob` always charges the budget (keyed by pattern, so
repeating a search doesn't double-charge) — that IS the "grep and pray" the rule
targets.

### 2. Deny once, then nudge

The turn's first violation keeps its **hard deny** (`checkGraphifyFirst`
unchanged) — it demonstrably works; it is why the early graph calls in the data
exist at all. Every later firing is a **non-blocking nudge**: the SDK PreToolUse
hook returns `additionalContext`, and the tool call proceeds regardless.

The asymmetry in cost justifies the asymmetry in force: a false positive on a
nudge costs one sentence of context, while a false positive on a deny costs a
blocked tool call mid-implementation. Injecting the reminder **at the moment of
the action** is also far stronger than the same words sitting in a system prompt
20 K tokens away — which is precisely why the prose version decayed.

The nudge text explicitly tells the model to **ignore it if implementing**, and
to reach for the graph only if still *locating* things. It is advisory by
wording as well as by mechanism.

### 3. Bounded

`GRAPH_DRIFT_NOVEL_FILE_THRESHOLD = 7` novel files since the last graph call;
`GRAPH_DRIFT_MAX_NUDGES = 3` per turn. Measured drift ran 15-40 unguided reads,
while legitimate implementation bursts rarely open more than a handful of unseen
files without re-orienting. The nudge cap stops an 80-op turn from being nagged
every 7 files into noise the model learns to skip. Nudges never fire on
Edit/Write/Bash — never interrupt the act of implementing.

## Alternatives considered

- **Re-arm the hard deny mid-turn** — rejected. Blocks legitimate
  implementation reads; the failure mode (user disables design hooks entirely)
  is worse than the drift.
- **Nudge only, never deny** — considered, and viable. Rejected because the
  first-read deny is the one part measurably working today: every session's
  early graph calls trace to it. Losing it to gain politeness is a bad trade.
- **Leave it to prose (status quo)** — this is the status quo, and the data
  says it produced a 1:5-1:11 ratio and a regression against the last audit.
  Repo-wide lesson: a rule that matters cannot live only in the prompt.
- **Count all reads rather than novel ones** — simpler, but nags during
  implementation (see §1) and would be tuned into uselessness.

## Consequences

- **Positive.** Enforcement now spans the whole turn instead of its first tool
  call. The advisory shape means the worst case is a wasted sentence, so it can
  be tuned by threshold rather than switched off. Fewer blind reads should
  directly reduce transcript growth (the 121K/166K problem).
- **Negative / honest.** The nudge's effect is *not* guaranteed — it is context
  injected at the right moment, but the model may still ignore it. Unlike
  ADR-0055/0057, which close their loops mechanically, this one cannot: there
  is no deterministic way to know a read *should* have been a graph query.
  Verification is therefore empirical — re-measure the ratio on the next
  sessions.
- **Tuning.** Threshold and cap are exported constants; if the ratio doesn't
  improve, the next escalation is lowering the threshold, not restoring the
  wall.

## Addendum (2026-07-25) — observability, because the guard couldn't be measured

First post-ship measurement (session `8198787f`, 67 ops) showed the ratio at
1:4.7 — modestly better than the 1:5-1:11 baseline — but the drift shape intact:
**33 consecutive file ops after the last graph call, containing 23 novel
files/searches** against a threshold of 7. The nudge should have fired and hit
its per-turn cap.

**Whether it did was unknowable**, which made the ADR's own empirical
follow-up unanswerable. Two failure modes were indistinguishable:

- the nudge fired and the model ignored it → the advisory shape is too weak,
  escalate;
- the nudge never fired → a wiring bug, fix the code.

Opposite responses, no data to choose. Causes:

1. The nudge is injected as PreToolUse `additionalContext`, which leaves **no
   trace in the session transcript** (hook output is not a stream event).
2. `appendAutoAuditEntry` **early-returns for every tool outside
   Edit/Write/Bash** (`auto-audit.ts:206`). The design hooks fire on
   Read/Grep/Glob — so the existing deny-logging call has *always* been a
   silent no-op. The whole design-hooks feature has been unobservable since it
   shipped, and the in-code comment ("the filter drops non-Edit/Write/Bash
   entries silently — safe to call") mistook that for harmless.

**Fix.** Emit on the `[marvin.telemetry]` console channel — the same one
ADR-0055/0057 use, landing in `~/Library/Logs/MARVIN/sidecar.log`:

- `graph.drift.nudge` — per fire, with `novelFilesSinceGraph`, `nudgeCount`,
  `graphCallCount`, tool;
- `designhook.deny` — per deny (previously invisible);
- `graph.turn.summary` — once per turn from `runAgent`'s `finally`, carrying
  `graphCalls` / `fileOps` / `nudges` / `denied`, so the ratio reads straight
  off the log instead of being reconstructed from transcripts.

The `appendAutoAuditEntry` call is kept (harmless, and it does record if a
mutator ever trips a rule) but is no longer the load-bearing path.

**Lesson worth generalising:** a guard that cannot be measured cannot be tuned.
ADR-0055/0057 got away without telemetry because their effects are visible in
state (a wakeup record exists; a corrective turn appears). An advisory guard has
no such artifact, so observability is part of its definition of done — not a
follow-up.

## Addendum 2 (2026-07-25) — the signal was wrong, not the enforcement

With telemetry landing, the first real reading was unambiguous about the
*mechanism*:

```
graph.turn.summary  graphCalls:2  fileOps:36  nudges:3 (cap hit)  denied:true
```

The deny fired, all three nudges fired, and the model kept reading. Read
narrowly, that says "advisory is too weak — escalate to a mid-turn deny."
**That would have been the wrong fix.** Analysing the same session's transcript:

| | count |
|---|---|
| novel source reads | 49 |
| → later Edited/Written (**implementation**) | 20 |
| → never mutated (**exploration**) | 29 |
| graph calls | 14 |

Exploration-only, the ratio is **1 graph : 2.1 exploratory reads** — not bad at
all. The alarming 1:17.5 headline was an artifact of counting (a) non-source
reads the graph never indexes (57 of 157 were `.md`/`.sql`/`.yaml`) and (b)
**reads of files the model was about to edit**. Reading a file you are about to
change is correct behaviour; 40 % of the drift charges were that.

So the defect was in the **signal**, not the enforcement strength — and a hard
mid-turn deny would have blocked real implementation work in exactly that
session. Two narrowings:

### N1. Implementation refund

`seenSourceFiles` only ever exempted *re*-reads; a first read-before-edit looks
identical to drift at hook time, because the Edit hasn't happened yet. So the
charge is now **refunded retroactively**: novel reads are tracked in
`chargedFiles`, and an `Edit`/`Write`/`NotebookEdit` on a charged path refunds
it (once, never below zero). The budget then reflects only reads that never
became edits — actual orientation, which is the graph's job. A graph call clears
`chargedFiles` alongside the budget so a later edit can't refund a stale charge.

`Grep`/`Glob` charges are deliberately **not** refundable — a search has no file
to edit, and searching the tree is precisely the exploration the rule targets.

### N2. Telemetry that reports the exploration ratio directly

`graph.turn.summary` now emits `driftCharges`, `implRefunds`, `exploreOps`
(= charges − refunds) and a precomputed `exploreRatio`, alongside `driftOps`
(renamed from the misleading `fileOps`; it was already source-only). The
exploration-only ratio is now readable straight off the log line instead of
being reconstructed — which is what made the first reading misleading.

**Lesson:** before escalating an enforcement mechanism, verify the signal it
fires on. The telemetry answered "did it fire?" correctly and I nearly drew the
wrong conclusion from it, because the *denominator* was measuring the wrong
thing.

## Scope of Done

- [x] `DesignTurnContext` tracks `seenSourceFiles` / `novelFilesSinceGraph` /
      `graphifyNudgeCount`; a graph call resets the drift budget.
- [x] Re-reading an already-seen file never charges drift or nudges; a
      project-tree Grep/Glob does (pattern-keyed, no double-charge).
- [x] `checkGraphDrift` fires only on Read/Grep/Glob past the threshold, is
      capped per turn, and returns advisory text that tells the model to ignore
      it while implementing — unit tested.
- [x] The PreToolUse adapter emits it as non-blocking `additionalContext`; the
      first-read hard deny is unchanged.
- [x] Full suite + typecheck green; app rebuilt.
- [x] **Addendum:** nudge fires, denies, and a per-turn graph:file summary emit
      on the `[marvin.telemetry]` channel (sidecar log) — the guard is now
      measurable, and "fired but ignored" is distinguishable from "never fired".
      Unit-tested, including that telemetry can never throw into a turn.
- [x] **Addendum 2:** novel read-before-edit is refunded retroactively so
      implementation no longer inflates drift (Grep/Glob non-refundable, refund
      once, graph call clears charges); `graph.turn.summary` reports
      `driftCharges` / `implRefunds` / `exploreOps` / `exploreRatio` so the
      exploration-only ratio is directly readable — unit tested, including that
      a 12-file read-then-edit burst never nudges.
- [ ] **Empirical follow-up (still open):** re-read `exploreRatio` from
      `graph.turn.summary` over the next real sessions. Pre-narrowing analysis
      put genuine exploration at ~1 graph : 2.1 exploratory reads, which may
      mean the rule is already working and no escalation is warranted — decide
      on the corrected number, not the raw ratio. Enforcement escalation
      remains explicitly NOT justified by current data.

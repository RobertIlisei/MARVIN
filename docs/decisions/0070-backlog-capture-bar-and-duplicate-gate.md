# ADR-0070 — A bar on backlog capture, and a gate on near-duplicates

- **Status:** Accepted
- **Date:** 2026-08-20
- **Related:** [ADR-0044](./0044-project-backlog.md) (the backlog),
  [ADR-0047](./0047-backlog-capture-at-discovery.md) (un-gated capture at discovery),
  [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (which regressed closure)

## Context

Reported: *"I start working on 1 item, and MARVIN opens another 2-3-4-5."*
Measured per session:

| session | added | resolved | ratio |
|---|---|---|---|
| `a5ee4b05` | 6 | 0 | **6.0×** |
| `701741dd` | 9 | 2 | **4.5×** |
| `5a1c0a0a` | 2 | 1 | 2.0× |

Aggregate is roughly break-even (386 done / 49 open), so the list is not
running away — but the *experience* of never closing anything is real, and the
high-add sessions are all **deep investigation** work (`systematic-debugging`,
infra). Investigate thoroughly and you genuinely notice 6–9 real things;
ADR-0047 then says capture every one of them immediately, un-gated.

Two hypotheses were tested and **disproved**, both mine:

- *"`backlog_add` never dedupes."* False — it calls `overlapNote(res.related, …)`.
  The real defect was narrower: overlap was reported **after** the item was
  written, so it annotated rather than prevented.
- *"The 12 design/animation skills enabled on this project are generating
  work."* False — skill-invocation logs show **not one of them has ever fired**.
  (They remain enabled and irrelevant, which is a separate context cost.)

Session `5a1c0a0a` parked the same question twice in two wordings.

## Decision

### 1. A conjunctive bar on capture

`personality.ts` now requires **all three** before parking: *actionable*, *out of
scope now*, and *you would be annoyed to rediscover it*. If any is missing, say
it in the turn instead — the user reads the reply; an unread backlog row is
worse than a sentence they saw. The conjunctive form is borrowed from the
`domain-modeling` ADR test in `mattpocock/skills`, which uses the same shape to
keep ADRs rare.

### 2. A gate, not a note, on near-duplicates

A capture scoring ≥ `NEAR_DUPLICATE_SCORE` (**0.75**) against a *live* item is
refused; the caller is handed the existing item. Calibrated on the two real
duplicate pairs (**0.88** and **0.75**) against a genuinely distinct pair from
the same session (**0.00**).

Non-destructive by construction: nothing is deleted or merged, updates to an
existing item are never blocked, and `force: true` re-admits an item that really
is distinct despite similar wording.

**`NEAR_DUPLICATE_MIN_TOKENS = 4`** guards the calibration. Without it the score
is computed from too little text to mean anything: `"Item one"` vs `"Item two"`
scores **1.00**, because the numerals are filtered as insignificant and both
collapse to `{item}` — so any two short titles sharing one word would have been
refused. This was caught by the existing suite, not by inspection.

## Scope of Done

- [x] Conjunctive capture bar in `personality.ts`.
- [x] Near-duplicate gate with a signal floor; `force` escape hatch.
- [x] 4 new tests; 742 total pass, 8/8 typecheck.

## Consequences

**This overrides a documented invariant.** `relatedBacklogItems` carried
*"Callers must not act on these"*, and a test enshrined "reported, never
applied". That was a deliberate prior decision, and it is now deliberately
reversed for the *near-identical* case only — advisory reporting is unchanged
below the gate. The test was updated rather than deleted, and states why.

**Risk.** A false refusal loses a capture the model judged worth keeping. The
mitigations are the signal floor, the high threshold, the returned original
(nothing is lost), and `force`. If the gate proves too eager, raise
`NEAR_DUPLICATE_SCORE` — a false refusal is visible in the turn text, unlike a
silent duplicate.

**Unverified.** The capture bar is prompt-level, so it cannot be unit-tested.
Re-measure the add/resolve ratio over the next few sessions; the target is that
deep-investigation sessions stop ending 6-added / 0-resolved.

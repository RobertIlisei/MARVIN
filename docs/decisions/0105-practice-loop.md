# ADR-0105 — The practice loop: repeat failures mined from every session, rules with enforcement tiers, a pane that manages the whole thing

- **Status:** Accepted — implemented 2026-09-03
- **Date:** 2026-09-03
- **Related:** [ADR-0042](./0042-memory-as-durable-facts.md) (memory holds facts — this holds behaviour), [ADR-0044](./0044-project-backlog.md) (backlog holds work — rejected as the sink here), [ADR-0059](./0059-session-auditor-runtime-dispatched-read-only.md) (the read-only, runtime-dispatched, reports-to-the-user shape this reuses), [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) / [ADR-0083](./0083-graph-drift-rail-rearms-and-escalates.md) / [ADR-0104](./0104-ship-review-gate.md) (the hand-written design hooks this generalises into a rule table), [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (the first cross-session measurement, done by hand), [ADR-0101](./0101-refine-proposes-practice-lessons.md) (`/refine`: one session proposes, writes nothing)

## Context

> "each session thinks it is the first time"

Every improvement to how MARVIN behaves has come from the same act: someone
reads many transcripts at once, notices the same failure repeating, and turns
it into a rule. ADR-0067 read a 49-hour session and found 65 turns ending
mid-plan. The 2026-05-22 audit found five skills with soft-nudge language
firing ~0×. The 2026-09-02 audit of session `8927baf0` found `pr-review` and
`security-audit` invoked zero times across eight pushes of CI, sudoers and
credential changes, and became ADR-0104 the same night. Each of those was a
human doing a nightly batch read by hand, weeks apart.

MARVIN has three cross-session layers and none of them can do this. Memory
(ADR-0042) holds facts. The backlog (ADR-0044) holds work. `/refine`
(ADR-0101) reads one session and proposes practice lessons, but one session
cannot see a repeat. `graph_reflect` aggregates outcomes MARVIN chose to
record. What is missing is a layer whose object is **behaviour** — a repeat
failure, with evidence, that becomes a rule, that is then measured.

### What the literature settles, so we do not re-derive it

- Anthropic's guidance for its own memory: save what "would be useful in a
  future conversation", skip what is derivable, expire what is not accessed;
  write a rule when "Claude makes the same mistake a second time"; and — the
  sentence this ADR's tiers rest on — memory files are "context, not enforced
  configuration. To block an action regardless of what Claude decides, use a
  PreToolUse hook."
- *Learning What to Remember* (2026): a linear value model over a handful of
  factors with weights **learned from downstream outcomes** retained 77 % of
  the evidence that later mattered; uniform weights 66 %; recency alone 37 %.
  Reliability of the signal dominated the learned weights.
- *MemGuard* (2026): keep the verifier's signals (reward, confidence, label,
  time) attached to a memory for its whole life; admit above a threshold,
  hold weaker candidates **provisional**, store failures as **constraints**,
  and run consolidation. Filtering once at admission beat baselines; keeping
  the signals for the lifecycle beat filtering in all 16 settings.

Three consequences for the design: score with a small linear model and tune
it from the ledger; the evidence must come from deterministic extractors,
not model impressions; and a rule's verification data travels with it.

## Decision

A **practice loop**: a scheduled, read-only pass over a project's session
transcripts that produces *findings* with stable identities, scores them,
proposes *rules* above a threshold, enforces accepted rules through the
existing gate at one of three tiers, and measures whether they worked. A pane
manages all of it. Nothing is written to a transcript, a project, or MARVIN's
behaviour without the user's approval.

### 1. Findings have identity, and identity comes from extractors

A finding is keyed by a **fingerprint** `kind[:qualifier]` computed by a
deterministic extractor over one transcript. Version 1 ships seven failure
kinds and four **paired success kinds** — the same act done right:

| fingerprint | what it detects | cost unit | paired success |
|---|---|---|---|
| `ship.unreviewed` | a `git commit` whose own command line names a boundary path, with no `pr-review` / `security-audit` `Skill` call earlier in the session | commits | `ship.reviewed` |
| `graph.first.skipped` | a turn with ≥ 5 source reads (Read or read-shaped Bash) of which ≥ 5 came before any `graph_*` call | reads | `graph.first.followed` |
| `turn.stalled` | a turn that ended "stopped" by the breakdown script's classifier (verbatim) AND whose next human message is a bare "continue / proceed / go on" | seconds waited | `turn.continued` (ended on scope-met, a question, or a named human action) |
| `scope.met.missing` | a turn with ≥ 1 Edit/Write and ≥ 10 tool calls that simply stopped, without the scope-met marker or a question | turns | `scope.met.present` |
| `cache.recreated` | a turn whose `turn.completed` `cache_creation_input_tokens` (the SDK's per-turn total) ≥ 300 000 — **report-only** | tokens | — |
| `hook.deny.repeated:<rule>` | the same design-hook deny reason ≥ 3 times in one session | denies | — |
| `error.repeated` | the same non-transient `turn.error` text in ≥ 2 turns of one session — **report-only** | turns | — |

Three rules apply to every extractor. **Subagent calls are excluded**: a
scout or an Explore legitimately opens twenty files with no graph call, and
its denies are its own (advisor review, risk 2). **A model never produces a
fingerprint** — the thing being counted is a fact about the file, which is
the literature's reliability factor made structural. **The extractor set is
versioned** (`EXTRACTOR_VERSION`); the ledger records it per finding, and a
bump resets un-actioned findings to `observed` and re-reads everything, so a
count from one definition is never compared with a count from another.

Why successes, and not only mistakes (user, 2026-09-03: *"wouldn't it be
good to also focus on things that were good?"*): a failure count alone cannot
tell five skipped turns out of two hundred from five out of six. The paired
success is the denominator — findings carry a **rate** — and it is the
verification signal for an accepted rule (a review that ran before a boundary
commit is the ship-review gate holding). Successes past the session threshold
surface in the pane as **practice**, the half of the loop that is not about
mistakes; they are the evidence, not a rule. `cache.recreated` and
`error.repeated` are about MARVIN's implementation or environment, not a
behaviour a rule can change, so they ship no template and stop at `report`.

### 2. The ledger is per project and day two is a diff

`~/.marvin/practice/<projectId>/ledger.json` holds findings, run records, and
a **watermark** per transcript `(path, mtime, size)`. A run reads only
transcripts whose watermark moved, skips the session that is live right now,
recomputes each fingerprint's occurrences, and then diffs:

| ledger state before | run observes | result |
|---|---|---|
| absent | occurrences | **new** finding, state `observed` |
| `observed` | more sessions | recurrence up; scored; crosses into `proposed` (template) or `report` (none) |
| `proposed` | anything | unchanged — waiting on the user |
| `active` (rule accepted) | an occurrence in a session after `acceptedAt` | **regressed**: the rule is not working; the pane offers *Escalate* — never automatic |
| `active` | no occurrence across `verifyWindow` sessions after `acceptedAt` | **confirmed** — whether the rule *fired and held* or the behaviour simply stopped; `fired` on the rule says which |
| `active` | its rule was retired | back to `observed`, re-judged in the same run |
| `dismissed` | occurrences | suppressed until distinct sessions reach twice the count at dismissal, then re-surfaced and re-judged in the same run |
| any un-actioned | extractor version bumped | reset to `observed`, sessions re-read |
| success kind | ≥ `minSessions` sessions | **practice** |

Occurrences are counted by **distinct session**, never by hits within one
session: one session hitting the same wall thirty times is one lesson.

### 3. Scoring is a linear model, thresholds are explicit, weights are tunable

```
value = w_recurrence · min(1, log2(1 + distinctSessions) / log2(9))
      + w_cost       · min(1, costPerSession / costScale[kind])
      + w_rate       · (failures / (failures + pairedSuccesses), by session; 1 when unpaired)
      + w_reliability· reliability[kind]
      + w_action     · actionability[kind]
      − w_decay      · (1 − 0.9 ^ sessionsSinceLastSeen)
```

Defaults: recurrence 0.30, cost 0.20, rate 0.15, reliability 0.20,
actionability 0.15, decay 0.15. Reliability is 1.0 for every v1 extractor;
actionability is 1.0 for a kind with a rule template and 0.2 for a
report-only kind. A finding is **proposed** when `distinctSessions ≥ 3` and
`value ≥ 0.6` — three, not Anthropic's "second time", because a machine
proposing rules needs more evidence than a person noticing one.

Worked examples (the advisor review asked for one, having computed that the
threshold was unreachable without the reliability and actionability terms):
`ship.unreviewed` in 3 sessions, one commit each, no paired success, seen
last session → 0.19 + 0.20 + 0.15 + 0.20 + 0.15 = **0.89**, proposed.
`graph.first.skipped` in 3 of 40 structural turns, 7 reads each → 0.19 +
0.093 + 0.011 + 0.20 + 0.15 = **0.64**, proposed. `cache.recreated` in 3
sessions → actionability 0.03 instead of 0.15, and stops at `report`
regardless. Both examples are pinned by tests.

Weights, thresholds, `costScale` and `verifyWindow` live in
`~/.marvin/practice/config.json`. Tuning is a **backtest** (the pane's
*Backtest* button: re-read every transcript, ignoring watermarks) — rank
fingerprints by measured cost over the ~350 transcripts on disk, which is
the training set the literature had to synthesise.

### 4. Rules have tiers, and tiers map onto machinery that exists

`~/.marvin/practice/rules.json` holds rules. A rule is a fingerprint, a
tier, a trigger, a message, a status, its provenance (finding id, sessions,
counts at acceptance) and its metrics (`fired`, `lastFiredAt`,
`sessionsAfter`, `recurrenceAfter`). Rules are scoped to a project by default
and can be promoted to global.

| tier | mechanism | what it is for |
|---|---|---|
| `prompt` | a `## Practice rules` block appended by `buildTurnSystemPrompt` | the cheapest lever; measured at ~0× on its own, so it is the tier a rule *starts* at only when no trigger can express it |
| `nudge` | `additionalContext` from the design-hook PreToolUse pass, once per turn | a reminder at the moment of the act |
| `deny` | a PreToolUse deny with the rule's message, capped like ADR-0104 | the tier the measured evidence says works |

The trigger is data: `{ tool: regex, field?: string, pattern?: regex,
boundaryPaths?: boolean, requireSkillThisSession?: string[], conditions?:
[{counter, op, value}] }`, where the counters are the design context's own
(`sourceFilesRead`, `graphCallCount`, `novelFilesSinceGraph`, `editedFiles`).
The design hooks gain one generic check, `checkPracticeRules`, that runs
**after** the hand-written hooks so a rule that duplicates one never
double-fires. Each fingerprint kind ships a **rule template** (trigger + tier
+ message) so approving a finding needs no authoring; the user can edit the
message, change the tier, promote to global, or retire the rule. A regressed
rule is offered for escalation, never escalated silently.

**The brakes on a `deny`** (advisor review, risk 1 — a user-authored gate is
a wall unless it has all four of ADR-0104's): a `deny` is enforced as a
`deny` only when its trigger carries a machine-checkable discharge
(`requireSkillThisSession`); otherwise `effectiveTier` enforces it as a
`nudge`. Denies honour `MARVIN_DESIGN_HOOKS=measure`, are capped at two per
rule per turn with a logged `practice.rule.bypass`, carry the rule's message
(which the template writes to name the remedy), and a rule whose regex does
not compile never fires. Metrics (`fired`, `bypasses`, `lastFiredAt`) travel
with the rule — MemGuard's lesson, applied.

### 5. The runner is scheduled, incremental, and never dispatches a model

`instrumentation.ts` arms a daily timer at the configured hour (default 03:00
local) for every registered project with `enabled: true`; the pane's *Run
now* hits the same function. A run reads transcripts, updates the ledger,
verifies active rules, writes one run record `{ at, sessionsRead,
findingsNew, recurring, proposed, confirmed, regressed, durationMs }`, and
stops. Version 1 writes no model-authored text: proposals use the templates.
A later phase may let the **user, from the pane,** ask the session-auditor
model (ADR-0059's dispatch shape: runtime-dispatched, read-only, reports to
the user) to draft a better message from the aggregates the pane shows —
never from raw transcripts, and never from the runner.

### 6. The pane

A **Practice** tab in `LeftPane` with three views and a header:

- **Findings** — failures: state chip, value, distinct sessions, rate against
  the paired success, cost, last seen, the latest detail; actions *Approve*
  (at the template tier or one you pick, for this project or all), *Dismiss*
  (with a reason), *Escalate* (for regressed). Confirmed and dismissed fold
  away.
- **Working** — the paired successes: what MARVIN keeps doing right in this
  project, with the same counts. The denominator, made visible.
- **Rules** — tier, status, fired and bypass counts, acceptance; actions
  change tier, promote to global, retire, reactivate.
- **Runs** — the log.
- Header: *Run now*, *Backtest*, the nightly toggle and hour, the last run.

### Considered and rejected (the advisor review's list, answered)

- **Extending `session-time-breakdown.py` instead of a TypeScript port.**
  The script stays as the ad-hoc CLI. The extractors are in the runtime
  because the gate, the prompt builder and the pane consume them in-process;
  the one shared piece, the ending classifier, is ported verbatim and the
  test pins it.
- **Capping user-authored rules at `nudge`.** Not needed once a `deny`
  requires a discharge path; `effectiveTier` is that cap, applied only where
  the wall would otherwise be.
- **Emitting `prompt`-tier rules through the backlog.** A prompt rule is
  still behaviour with a lifecycle (accepted, verified, regressed); the
  backlog has none of those states.
- **Ledger in the project's `.marvin/`.** Findings are about MARVIN, not the
  project; `.marvin/` is the user's data. Rules travel with the install.

### Rejected

- **The backlog as the sink.** Backlog items are work someone will do; a
  finding is a behaviour someone must stop. Different lifecycle, different
  consumer (the gate, not a person), different UI.
- **Memory as the sink.** ADR-0042's content-class check would rightly reject
  every entry: a repeat failure is not a durable fact about the project.
- **A model reading raw transcripts nightly.** A project's transcripts run to
  11 MB per session; and the evidence would be an impression. Deterministic
  extractors read everything, the model (later) sees aggregates.
- **Auto-applying rules.** "It proposes, you approve, nothing is overwritten"
  is the property that makes a self-modifying loop safe to run unattended.
- **A standing agent.** Rejected on 2026-07-24 for the same reason as the
  supervisor: no model commands another model. The runner is a function on a
  timer, and the only model in the loop (later) is dispatched by the runtime
  and reports to the user.

## Consequences

- MARVIN gains a fourth cross-session layer, for behaviour, with its own
  files under `~/.marvin/practice/`. Memory, backlog and ADRs are unchanged.
- Rules at the `deny` tier can block tool calls the user never hand-coded a
  gate for. The cap, the measure mode and the pane's retire action are the
  brakes; the user's approval is the entry.
- The design hooks now have two sources of truth: the hand-written checks and
  the rule table. Migrating the hand-written ones into the table is a
  possible later step and is not done here.
- The extractors encode what the project currently considers a failure. A
  new kind of failure needs a new extractor, a fixture, and a template — a
  small, testable addition, not a prompt edit.
- The nightly run costs no model tokens in v1. Reading a 350-transcript
  project end to end is I/O and JSON parsing, and the watermark makes every
  later run incremental.

## Review

Read-only advisor pass, 2026-09-03: **go-with-caveats**, eight edits. All
eight are in the text above: deny needs a discharge path plus the ADR-0104
brakes (§4); subagent calls excluded (§1); `cache.recreated` report-only with
its aggregation defined (§1); the ending classifier reused verbatim (§1); the
arithmetic corrected with worked examples (§3); `extractorVersion` and the
fired-and-held row (§2); *fired* distinguished from *held* (§2, §4); the
later model pass user-triggered from the pane on aggregates (§5).

## Scope of Done

- [x] Seven failure extractors and four paired success extractors produce the fingerprints above from fixture transcripts; subagent calls are ignored — tested.
- [x] Consecutive runs produce the day-two table: new, recurring, proposed, report-only, regressed, escalated, confirmed, retired-returns-to-pool, dismissed-then-resurfaced, and a grown session re-counted — tested.
- [x] Scoring matches the formula; both worked examples are pinned; report-only kinds cannot be approved — tested.
- [x] Rules enforce at all three tiers: the prompt block is built into the system prompt, nudge and deny fire from the design hooks through the rule table with the discharge, cap, measure-mode and broken-regex brakes, and metrics land on the rule — tested.
- [x] `GET/POST /api/practice`, `POST …/run`, `POST …/findings`, `POST …/rules`, all keyed on a registered project id and CSRF-guarded on mutation.
- [x] The nightly schedule arms at boot and fires once per project per day at the configured hour — tested; *Run now* and *Backtest* call the same runner.
- [x] The Practice pane: Findings, Working, Rules, Runs; approve at a chosen tier or globally, dismiss with reason, escalate, change tier, promote, retire, reactivate, schedule toggle and hour.
- [x] Typecheck, runtime tests and the Swift build pass; the app is reinstalled.

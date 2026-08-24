# ADR-0055 — Check-back promise guard: auto-arm the wakeup the model forgot

**Status:** Accepted — 2026-07-24
**Touches:** new `checkback-guard.ts` (pure detector + delay parser + prompt
synth), `sdk-runner.ts` (turn-end guard: track final text + armed-mechanism,
auto-arm on an unbacked promise; also fixes the wakeup-turn persona default
`marvin`→`ultron`), `personality.ts` (firm-surface note). Builds on the
self-wakeup scheduler ([ADR-0031](./0031-self-scheduled-wakeups.md)) and the
background-job wakeup ([ADR-0038](./0038-background-jobs-real-completion-turn.md)).

## Context

MARVIN's firm surface already forbids empty asynchronous promises: *"if you
tell the user you will check back, you MUST have blocked on it, started a
`run_background_job`, or armed a `schedule_wakeup`"* (personality.ts), and lists
"I'll continue when it reports" / "watching the build" as lies the moment the
turn ends.

It's a **prose MUST**, and prose MUSTs fire unreliably — the recurring lesson
behind every "firm surface" in this repo (skills firing ~0×, memory bloat,
backlog content-class — each moved from nudge to mechanical enforcement at the
boundary where prose failed).

Observed 2026-07-23 on a real project turn:

> "…New pipeline `#2701545119` is running — I'll check back in ~7 minutes."

Evidence: the project's `wakeups` file was `{"wakeups": []}` (a scheduled
wakeup persists immediately, removed only on fire); zero `schedule_wakeup` /
`run_background_job` / `marvin-control` activity in the sidecar log. The
`schedule_wakeup` tool WAS available (it needs only `marvinSessionId +
projectId`, both present). So the model simply narrated the promise and ended
the turn. Nothing re-invoked it; the user waited indefinitely, and the CI fix
the turn claimed went unverified.

## Decision

Add a **mechanical backstop at turn end**: if a successful turn's final
assistant message contains a check-back promise AND no follow-through mechanism
was armed during the turn, the runtime arms the wakeup itself.

### Mechanism (`sdk-runner.ts` turn loop)

- Track the **last assistant message's text** (`finalAssistantText`) and a flag
  `armedFollowThrough`, set when any assistant `tool_use` block names
  `schedule_wakeup` or `run_background_job`.
- After a successful turn, if `wakeupCtx` exists and `!armedFollowThrough`,
  run `detectUncoveredCheckBack(finalAssistantText)`. On a match, call
  `scheduleWakeup` with the parsed delay and a synthesised prompt.

### Detection (`checkback-guard.ts`, pure)

- **Promise patterns** each embed the first-person commitment (`i'll check
  back`, `check back in|once|when`, `i'll let you know`, `i'll be monitoring`,
  `i'll continue … when/once/after/in`, `i'll … in ~N min/hour`), so a bare
  mention ("you could check back later") doesn't trip it.
- **Delay parsing**: the first `~N <unit>` in the message ("~7 minutes" → 420s),
  clamped to the scheduler's [60, 86400]; **default 300s** when the promise
  names no time.
- **Prompt synthesis**: quotes the promise sentence and instructs the fired
  turn to check the ACTUAL status and act — "Do NOT simply re-promise."

### Why auto-arm (not flag-only or force-retry)

Flag-only leaves the follow-through on the user; force-retry costs a full model
turn every trigger. Auto-arm closes the loop for the cost of one scheduler
call, degrades safely (a false positive is one extra deferred turn ≥60s away,
which the user sees in the wakeups tray and can cancel), and matches the
"mechanical where prose failed" pattern. The scheduler's existing guards apply
unchanged (≤5 pending/session, chain-depth cap, ≥60s delay).

### The model MUST still arm its own

The firm surface keeps the MUST; a note adds that a runtime backstop exists but
a hand-written `schedule_wakeup` with a **precise** prompt beats the generic
auto-armed one — so the model should still do it. The guard is a net, not a
license to skip the tool.

## Consequences

- **Positive.** "I'll check back" becomes true even when the model forgets the
  tool call. The exact 2026-07-23 failure now auto-arms a 7-minute wakeup.
- **Negative.** Heuristic detection: a false positive schedules one harmless,
  cancellable, ≥60s-away turn; a false negative (an unusual phrasing) simply
  reverts to today's behaviour (nothing armed). Tuning lives in one pure module.
- **Bonus fix.** Wakeup turns defaulted to `personality: "marvin"`; corrected
  to `"ultron"` (the v0.1.57 default) so a fired turn keeps the session voice.

## Scope of Done

- [x] `detectUncoveredCheckBack` matches the observed promise + parses "~7
      minutes" → 420, and does NOT trip on non-promise text — unit tested.
- [x] Delay defaults to 300s when no time is named; clamps out-of-range.
- [x] `sdk-runner` arms a wakeup only when no `schedule_wakeup`/
      `run_background_job` ran and the turn succeeded (no-op otherwise).
- [x] Firm-surface note added; wakeup persona default fixed.
- [x] Full suite + typecheck green; app rebuilt.

---

## Addendum (2026-08-07) — a background job is not a clock

**Context.** The guard failed on a real turn, reported by the user with a
screenshot:

> "Steps [5]-[7] landed (…). Dev stack is starting in the background; I'll check
> readiness and run the Playwright verification in ~2.5 minutes."

The turn ended (8 m 31 s). Nothing followed. The user had to say *"you said you
will check and you did not"* — the exact failure this ADR exists to prevent,
one turn-shape removed from the original.

**Two independent defects.** Either alone would have swallowed the promise, so
both are fixed:

1. **The detector never matched.** `detectUncoveredCheckBack` returned `null`
   on that sentence, for two separate reasons:
   - the timed pattern capped the gap between `I'll` and `in` at **40
     characters**; the real clause ("check readiness and run the Playwright
     verification ") is 51. A promise failed to register **for being wordy**.
   - the duration was `\d+`, which cannot match `2.5` — even though
     `parseDelaySeconds` has handled decimals since day one. The two regexes
     disagreed, so the delay was parseable while the promise was invisible.

   Also widened: the open-ended pattern's verb list was
   `continue|resume|pick up|follow up`, which misses the vocabulary a coding
   session actually uses ("I'll re-run the suite once the stack is up").

2. **The coverage test was wrong in kind.** `armedFollowThrough` was a single
   boolean set by *any* `schedule_wakeup` **or** `run_background_job`. The turn
   started the dev stack with `run_background_job`, so the guard was disarmed
   before detection even ran.

   A dev server **never exits**, so ADR-0038's completion turn can never fire.
   The runtime treated "a job is running" as "the promise is handled" when the
   job could not, even in principle, discharge it.

**Decision.** Coverage is decided per-promise, not by a global flag:

- `CheckBackDetection` gains `hasExplicitDelay` — did the promise name a time?
- `isCheckBackCovered(detection, { scheduleWakeup, backgroundJob })`:
  - a `schedule_wakeup` covers **any** promise;
  - a `run_background_job` covers only an **open-ended** one;
  - a **timed** promise is covered by a wakeup and nothing else.
- `sdk-runner` tracks `armedWakeup` and `armedBackgroundJob` separately, and
  runs detection unconditionally (coverage is evaluated after, not before).

The cost of erring this way is one extra check-in turn when a job completes near
its wakeup. That is strictly better than silence — which is what the user got.

**The general lesson**, consistent with the rest of this ADR: the original guard
encoded *"was a mechanism armed?"* when the question is *"was THIS promise
discharged?"* A backstop that accepts any nearby activity as proof of
follow-through will keep finding turn shapes where the activity and the promise
are unrelated.

## Scope of Done — addendum

- [x] Detector matches the verbatim 2026-08-07 sentence; `~2.5 minutes` → 150 s.
- [x] Timed pattern: gap 40 → 90 chars, `\d+` → `\d+(\.\d+)?` shared with
      `parseDelaySeconds` via one constant, so they cannot drift apart again.
- [x] Open-ended pattern covers check/verify/confirm/re-run/run/test/retry/
      review/kick off/start/finish/report.
- [x] `hasExplicitDelay` + `isCheckBackCovered`; `sdk-runner` tracks the two
      mechanisms separately and detects unconditionally.
- [x] `personality.ts` states the mechanism-matching rule and names the
      long-running-server case.
- [x] 9 new unit tests incl. the real sentence and the background-job
      regression; 26 in the file, 597 across the suite; `tsc --noEmit` clean.
- [x] Bare mentions ("you could check back later", "takes about 7 minutes")
      still do not trip it.

## Addendum (2026-08-22) — the backstop missed a real promise, and why

MARVIN ran a pgBackRest backup, and closed the turn with:

> It's running as tracked background task `b8ey1tvp0`; **I'll act on its real
> completion output rather than guess.**

The job finished at **17:17**. The turn ended at **17:22**. Nothing fired until
the user chased it at **22:02** — **4.5 hours**.

### Two separate defects, and neither was the one first suspected

The initial hypothesis was that ADR-0032's `run_in_background` deny had failed.
It had not: the tool input was `{command, timeout: 300000}` with
`run_in_background` **unset**, so the gate correctly saw nothing to deny.

**What actually happened:** the command ran in the FOREGROUND, exceeded its
300 s timeout, and *the SDK harness auto-moved it to the background*, returning
`Command running in background with ID: b8ey1tvp0`. MARVIN read that as
ADR-0038 tracking. It is not — an auto-backgrounded task notifies the SDK
session, which dies with the turn.

So neither ADR-0032 (explicit flag) nor ADR-0038 (`run_background_job`) applied,
and the failure fell into the gap between them. **This backstop is the layer
that should have caught it**, and it did not, for two reasons found by testing
the literal sentence:

1. `"act"` was not in `FOLLOW_THROUGH_VERBS` — a list holding `check`, `verify`,
   `run`, `report` and 17 others, but not the verb actually used.
2. The sentence carries **no `when`/`once`/`after`/`in` cue**. The clause
   pattern requires one, so even with `act` added it would still have missed.

### Fixed

- `act`, `react`, `respond`, `handle` added to the verb list.
- A new pattern keys on the **event noun** instead of a temporal cue —
  `completion|completes|finishes|exits|terminates|returns` — because that is how
  a coding session says "when the process ends" without saying "when".
- `personality.ts` now states plainly that a timed-out foreground Bash call is
  auto-backgrounded by the harness and is **NOT** tracked, with the instruction
  to re-run under `run_background_job` or arm a `schedule_wakeup` before
  claiming any completion follow-up.

Negative cases are tested alongside the positive ones — a false positive arms a
spurious wakeup, so "The job completes in about an hour" and "I acted on the
completion output already" must stay silent.

## Addendum 2 (2026-08-23) — a foreign tool that silently armed nothing

One day after addendum 1, the same class of failure with a different mechanism.
MARVIN closed a turn with:

> Restarted the stale dev API in the background … and **scheduled a check in ~2
> minutes** before re-running the Playwright spec.

Nothing fired. The wakeup store held one unrelated 24-hour entry.

### The tool it called was not MARVIN's

The transcript records a call to **`ScheduleWakeup`** — bare, no `mcp__` prefix.
That is the **Claude Code harness's** tool, for `/loop` dynamic pacing. MARVIN's
own tool is the snake_case `schedule_wakeup` (`wakeup-tools.ts:57`). Inside
MARVIN's SDK session there is no loop for the harness tool to pace, so the call
schedules nothing — while reading, to the model, as the obvious choice.

Three layers failed in sequence:

1. **The tool was reachable at all.** A foreign tool that silently no-ops a
   safety-critical promise should never have been on the surface.
2. **The coverage check missed it.** `sdk-runner.ts` tests
   `b.name.includes("schedule_wakeup")` — **false** for `ScheduleWakeup`
   (case differs). Correct in isolation, but it meant the turn looked
   *uncovered*, leaving the backstop as the only net.
3. **The backstop missed it too.** Every pattern required a future-tense
   `"I'll …"`. This sentence is **past tense** — it asserts the watcher
   *already exists*. That is a stronger and more misleading claim than a
   promise, and it was invisible.

### Fixed

- **`ScheduleWakeup` is added to `disallowedTools`**, so the SDK never exposes
  it. Structural, not prose — the same move as ADR-0032's `run_in_background`
  deny.
- **A past-tense pattern** now matches `scheduled|armed|set up|queued` + a
  watcher noun + `in|for|after`. Negatives are tested: "I scheduled the backup
  to run nightly", "A check was already scheduled by the runtime" and
  "scheduled maintenance in production" must stay silent, since a false positive
  arms a spurious wakeup.

### The pattern behind the pattern

This is the **third** widening of these regexes (2026-08-07, 08-22, 08-23), and
each was driven by a real miss in vocabulary nobody predicted. Enumerating
phrasings is losing ground slowly. The structural alternative — arm on any
turn-ending commitment the runtime cannot see a watcher for, rather than
matching prose — is recorded here as the direction, not yet built.

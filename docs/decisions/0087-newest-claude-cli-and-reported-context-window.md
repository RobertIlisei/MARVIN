# ADR-0087 — Run the NEWEST Claude CLI, and trust the window the SDK reports

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0082](./0082-claude-plan-usage-from-rate-limit-events.md) (the usage block this unblocks), [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (what CLI skew costs)

## Context

The Claude plan-usage block (ADR-0082) stayed blank: bars with no
percentages, while the Claude app showed 33 % session / 49 % weekly.

Tracing it produced a much larger finding. **6,589 `rate_limit_event`s across
every MARVIN transcript ever recorded, and not one carried `unifiedWindows`** —
the field holding those percentages. Yet a standalone probe on the same
machine got it every time, and so did MARVIN's own `runAgent` when run from
source.

The difference was the binary:

```
/Users/robertilisei/.local/bin/claude  → 2.1.251   ← the user's shell
/opt/homebrew/bin/claude               → 2.1.92    ← what MARVIN ran
```

`discoverClaudeBinary` walked a fixed `COMMON_CLAUDE_PATHS` list and returned
the **first path that existed**, with `/opt/homebrew/bin` first. MARVIN had
been running a CLI **159 versions behind** the user's, silently, for as long
as both were installed. 2.1.92 predates `unifiedWindows`, so the usage block
had nothing to show and nothing said why.

The blank bars were the cheap symptom. CLI skew of that size also changes tool
names — ADR-0079 is the record of five guards going dead when `Task` became
`Agent` in 2.1.63 — and available flags. A silently stale CLI is a whole class
of bug, not one display defect.

## Decision

**1. Resolve the newest CLI, not the first.** `discoverClaudeBinary` now
probes `--version` on every candidate (the fixed list plus `command -v
claude`) and picks the highest. Comparison is per-component, because
`"2.1.251" < "2.1.92"` lexically — the same trap ADR-0086 fixed for release
versions. A binary whose `--version` is unreadable never displaces a
known-good one, and `MARVIN_CLAUDE_BIN` still wins outright: an explicit pin
is a decision.

**2. Trust the window the SDK reports.** Every `result` event carries
`modelUsage[<model>].contextWindow` — the authoritative figure from the model
that just ran. MARVIN inferred it from the model id instead: 1M when the id
contained `[1m]`, else a hardcoded 200K. That is *correct* for today's models
(verified across transcripts: Sonnet 5, Opus 5, Fable 5 and Haiku 4.5 all
report exactly 200000; `claude-opus-4-7[1m]` reports 1000000) but right by
coincidence. The reported value now wins, with the id-based estimate as the
fallback for turns that have not reported yet; where a turn used several
models the largest window is taken, since the gauge is about the main
conversation's headroom.

## Consequences

- The plan-usage bars fill in — `five_hour 0.33`, `seven_day 0.49`, matching
  the Claude app exactly.
- MARVIN follows the user's CLI upgrades instead of pinning to whichever
  install happened to sit earliest on a hardcoded list.
- Startup pays a `--version` exec per candidate path (≤4, 5 s timeout each,
  cached for the process).
- A machine with only the Homebrew CLI is unaffected — there is nothing newer
  to find.

## Scope of Done

- [x] `discoverClaudeBinary` picks the highest `--version`; override still wins
- [x] Version parsing test-pinned, including the lexical-compare trap
- [x] Verified live: the resolver now returns `.local/bin/claude` 2.1.251
- [x] `contextWindow` read from `modelUsage` and preferred over the estimate
- [ ] Not in scope: warning the user when their CLI is old; a 1M-window picker

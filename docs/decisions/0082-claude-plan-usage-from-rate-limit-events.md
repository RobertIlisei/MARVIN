# ADR-0082 — Claude plan usage from the SDK's `rate_limit_event`

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** v0.1.67 changelog (OpenRouter credits block — the shape this mirrors)

## Context

OpenRouter got an account block in the cost popover (`/api/v1/credits` →
total credits, total usage). The user asked for the same for Claude. Claude
on this machine runs on a subscription through host credentials: there is
no dollar balance to poll, and the per-turn `total_cost_usd` MARVIN already
records is a rate-card estimate, not a bill.

What a subscription *does* have is the 5-hour and weekly windows the Claude
app shows — and the SDK reports them on every turn as a `rate_limit_event`
(`status`, `rateLimitType`, `utilization` 0–1, `resetsAt`, overage flags).
MARVIN received the event on every turn and discarded it
(`ChatMessageModels.swift`: "rate_limit_event … no list-visible mutation").

## Decision

- `runAgent` records every `rate_limit_event` via `recordClaudeRateLimit`,
  newest snapshot per window type, next to the OpenRouter balance in
  `cost-tracker.json`. A bare status with no window type never overwrites a
  typed window.
- `GET /api/cost` returns `claudeRateLimits: []` until the first event —
  the popover shows nothing rather than a fabricated number; a window the
  API has not sized shows its status only.
- The popover gains a **claude plan usage** block: one row per window with
  a bar, percentage, refill time and an overage badge, tinted green /
  orange / red at 70 % / 90 % or on `allowed_warning` / `rejected`.
- The "completed in …" row now shows per-turn tokens (in / out / cached),
  for both providers. They were recorded since the tracker existed and
  never displayed.

## Consequences

- A Max-plan user sees the number that actually governs their session,
  where OpenRouter users see credits — the popover reads the same either
  way.
- Snapshots are per machine, not per project (the plan is per account).

## Scope of Done

- [x] Event captured, persisted, summarised; test-pinned
- [x] Popover block + per-turn tokens
- [ ] Not in scope: historical utilisation charts; per-project attribution

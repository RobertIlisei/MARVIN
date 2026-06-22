# ADR-0047 — Backlog capture at discovery (provisional items)

- Status: accepted
- Date: 2026-06-22

## Context

[ADR-0044](./0044-project-backlog.md) gave each project a parking lot for
"noticed in flight, not in scope" follow-ups, and deliberately made capture
**consent-gated at the scope-met handoff**: MARVIN *lists* out-of-scope items at
the end of a real-work turn and *proposes* parking them; the user confirms; only
then does `backlog_add` run. ADR-0044 explicitly rejected auto-capture as "the
Kanban/bloat trap."

Live use exposed the cost of that choice: items get silently lost. The failure
is structural, not a model-discipline lapse — capture is bound to a single
end-of-turn moment, so:

1. **Discovery and capture are separated in time.** An item noticed at tool-call
   #3 of a 40-call turn must survive in the model's working memory until the
   Phase-7 handoff. On a long turn (or across a context compaction) it falls out
   of attention and is never parked.
2. **Most turn-endings never reach the handoff.** A user redirect (the common
   case), a trivial fast-path close, an error / Stop / interrupt, or a
   non-real-work turn all end without the Phase-7 enumeration — so anything
   noticed that turn evaporates.
3. The consent gate stacks three failure points (remember → enumerate → user
   says yes), all at the end, all at once.

The anti-Kanban invariant (Golden Rule 1) that motivated the consent gate is
about **execution** — no subagent pulls from the backlog, it never auto-runs,
the user promotes. Auto-*capturing* a memo-to-self does not touch any of that;
ADR-0044 conflated capture with execution. The real concern auto-capture raised
— backlog bloat — is addressable with a review step rather than a capture gate.

## Decision

Decouple capture from the handoff: **auto-capture an out-of-scope discovery the
moment it is noticed, as a `provisional` item**, and move the user's consent
from *capture* to *keep*. Capture eagerly, review lazily.

- **New `provisional` status** in the backlog store (`backlog.ts`), ahead of
  `open` in the lifecycle: `provisional → open | dismissed`. Provisional items
  persist immediately, appear in the index (marker `[?]`), and resurface in next
  session's context like any parked item — so a discovery survives even if the
  turn never reaches a handoff.
- **`backlog_add` gains a `provisional` flag.** The per-discovery path sets it
  true and needs **no user go-ahead** (it's a memo, not a commitment). An
  explicit user-confirmed add (or a manual UI add) stays `open`. Re-adding a
  provisional item with `provisional:false` promotes it to `open`; a provisional
  re-add never downgrades an already-`open` item.
- **`personality.ts` per-discovery trigger.** Phase 7 no longer says "hold the
  item until the handoff." The moment MARVIN notices actionable work unrelated
  to the current task, it MUST `backlog_add … provisional:true` immediately. The
  scope-met handoff becomes a **batch review**: list what was auto-parked this
  turn and propose keep (→ `open`) / dismiss (→ `dismissed`). Unreviewed
  provisional items persist rather than vanishing.
- **Keep / dismiss verbs.** `backlog_resolve` gains `keep` (→ `open`) alongside
  `done` / `dismissed`. The macOS `BacklogPanel` shows a distinct "Auto-captured
  — review" section with per-row Keep / Dismiss; the tray count includes
  provisional items so the user is nudged to review them.
- **Bloat guard moves to review, not capture.** Provisional items are excluded
  from the `MAX_OPEN_ITEMS` hard cap (so auto-capture is never silently blocked
  → no loss); the handoff review + a visible, prunable provisional section are
  the bloat control. This is the deliberate reversal of ADR-0044's rejected
  alternative.

The anti-Kanban execution invariant is unchanged: provisional items are still
never pulled by a subagent, never auto-executed, and promotion to a turn remains
a user action.

## Consequences

- Positive: out-of-scope discoveries are captured at the instant of discovery,
  surviving redirects, fast-path closes, errors, and long turns. The user keeps
  full overwatch via the keep/dismiss review — but the default is "captured,"
  not "lost."
- Negative / trade-offs: the backlog can accumulate unreviewed provisional items
  if the user never reviews; mitigated by the visible review section, the tray
  count, and resurfacing in context. Auto-capture may occasionally park
  something the user would not have — a one-click Dismiss, not a silent miss.
- Follow-ups created: a "dismiss all provisional" bulk action if review fatigue
  shows up; optional aging (auto-dismiss provisional items untouched for N
  sessions). Both deferred.

## Alternatives considered

- **Keep consent-gated capture (ADR-0044 status quo).** Rejected — it is the
  direct cause of the reported loss.
- **A separate "scratch notes" store distinct from the backlog.** Rejected —
  more machinery; a `provisional` status on the existing store achieves the same
  with one enum value and reuses the index, API, and panel.
- **Mid-turn reminders to the model to flush noticed items.** Rejected — still
  relies on the model remembering; doesn't survive a redirect or a long turn.

## Scope of Done

- [ ] `backlog.ts` has a `provisional` status; `addBacklogItem` honours a
      `provisional` flag (new → provisional; confirm promotes; never downgrades
      open); provisional items appear in the index and are excluded from the
      open-count cap.
- [ ] `backlog_add` exposes `provisional`; `backlog_resolve` supports `keep`;
      `backlog_list` surfaces provisional items.
- [ ] `personality.ts` mandates auto-capture-at-discovery (provisional, no
      go-ahead) and reframes the handoff as a keep/dismiss batch review; the
      "Project backlog" firm surface documents the provisional class.
- [ ] macOS `BacklogPanel` shows a provisional review section (Keep / Dismiss);
      the tray count includes provisional items.
- [ ] runtime `tsc` clean; `swift build` clean.

## Related

- Files: `sidecar/packages/runtime/src/backlog.ts`,
  `sidecar/packages/runtime/src/backlog-mcp.ts`,
  `sidecar/packages/runtime/src/personality.ts`,
  `sidecar/src/app/api/backlog/route.ts`,
  `macos/MARVIN/BacklogPanel.swift`, `macos/MARVIN/BacklogService.swift`
- Supersedes / superseded by: revises ADR-0044 (consent-gated capture →
  capture-at-discovery + consent-to-keep)

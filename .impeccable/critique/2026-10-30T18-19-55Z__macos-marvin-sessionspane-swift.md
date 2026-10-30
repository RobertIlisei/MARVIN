---
target: Supervisor surface in the Sessions pane
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/Robert/Documents/MARVIN/.marvin/worktrees/tab-supervisor-m6-ui/macos/MARVIN/SessionsPane.swift"
target_fingerprint: "sha256:306d66181f9b7c07a092e2a28fbd84225ebad2c02cd3014aebd8fb9037ea8d36"
target_path: /Users/Robert/Documents/MARVIN/.marvin/worktrees/tab-supervisor-m6-ui/macos/MARVIN/SessionsPane.swift
timestamp: 2026-10-30T18-19-55Z
slug: macos-marvin-sessionspane-swift
---
Method: design review only (detector not applicable, native platform)

Target: the Supervisor surface in the Sessions pane (ADR-0127 M6) — renders in /tmp/marvin-surfaces-sup, sup-* (22 states), chat-supervisor-marking, chat-external-answer-note, topbar-models-dialog; light and dark, 260 and 420 pt.

## Design Health Score (first renders, before polish)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Strip state truncated to "⚠ …" at 260 pt (Paused — daily cap, Wake failed) |
| 2 | Match System / Real World | 3 | Server act verbs ("Allow push", "Merge") and "leaves this Mac" read as the act |
| 3 | User Control and Freedom | 3 | Pause/Kill one action away; failure notice ✕ did nothing |
| 4 | Consistency and Standards | 3 | ADR-0114 vocabulary throughout; notice strips with inline verbs broke the chips-on-their-own-line rule |
| 5 | Error Prevention | 4 | "Review act…" gate, no Return/default on any consent, no batch accept |
| 6 | Recognition Rather Than Recall | 3 | One mark (binoculars), glyph per level and decision |
| 7 | Flexibility and Efficiency | 3 | ⌃⌥⌘P / ⌃⌥⌘K / ⌥⌘J registered; strip and log are not walk stops |
| 8 | Aesthetic and Minimalist Design | 3 | Cards dense at 260 pt but ordered act → advice → grounds |
| 9 | Error Recovery | 2 | Escalations for a non-open tab counted but never drawn; crushed failure notice |
| 10 | Help and Documentation | 3 | Delegation consequences in the menu, help on every chip |
| **Total** | | **30/40** | Good |

## Design Specificity Verdict
Authored for this product: the act leads, the advice is visibly subordinate, the supervisor is a dashed outline and never the "you" bubble. No new hue; it reads as the Sessions pane grown, not a dashboard bolted on. Deterministic scan: not applicable (native platform).

## Priority Issues
- [P1] Escalations about a tab that is neither open nor live were counted in Needs you but never drawn (burst: the question and three .env escalations for "Fix the flaky cache test" vanished). Fix: an escalated tab always gets a row; its title falls back to the inbox's snapshot.
- [P1] Strip line 1 truncated the state to "⚠ …" at 260 pt beside Resume / ⋯ / chevron. Fix: the state gets its own line under "Supervisor".
- [P1] Guardrail and failed-wake notices put their verb beside the text and wrapped the detail one word per line at 260 pt. Fix: the verb chip on its own line (brief §5).
- [P2] The failed-wake notice's ✕ was a no-op. Fix: dismisses until a different failure arrives; still never auto-dismissed.
- [P2] "Supervisor recommends De…" truncated the verb at 260; ground label and citation squeezed side by side; new-tab posture segments ran together; disconnected cards greyed without saying why. Fix: two-line recommendation, citation under its label, " · " separators, "reconnecting…" on a disabled card.

## Persona Red Flags
- Sam (VoiceOver): covered — strip label/value, escalation card actions equal the visible chips, rotor "Escalations", coalesced arrival announcements, "not from you" labels in the transcript.
- Alex (power user): no single-key consent by design; registry shortcuts present; strip and log are not ↑↓ walk stops (recorded in brief §11).

## Minor Observations
- The blind-proposal line wraps "Supervisor proposed / an answer" at 260; now first-baseline aligned with "Reveal".
- Existing tab-row subtitles stay 9.5 pt tertiary (audit L14, out of scope).
- The pre-existing pane-sessions fixture never renders its idle/failed rows; not caused by this change.

## Questions to Consider
- Should the stale/failed states also surface a dock badge, or is the pane enough?

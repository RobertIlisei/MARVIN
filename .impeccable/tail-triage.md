# Tail triage — MARVIN native macOS app

Inputs: audit P2/P3 rows (`audit-macos-2026-10-30.md`, 81 rows) and critique P3s U23–U26 (4 rows). Status was checked against the code at `9dc7e89`, not assumed: four read-only scouts re-read every cited site and reported `file:line` evidence per row; rows I touch are re-read again before the edit.

Statuses: **already fixed** (an earlier pass resolved it) · **fix** (user-visible, or correctness / accessibility, and cheap) · **defer** (reason in the last column: `design` = needs a product or design call, `risk` = touches a layout-loop, window-management, text-editing or concurrency path, `budget` = real but beyond the 4-commit budget, `unverifiable` = cannot be judged without running the app).

Fix groups (one commit each, `pr-review` on every commit, re-render and compare after each):

- **G1 harden — names, traits, hit areas** (VoiceOver and pointer): the rows marked G1
- **G2 harden — correctness and destructive paths** (logic test-first): G2
- **G3 colorize / typeset — adaptive colour and legible info text**: G3
- **G4 optimize / clarify / distill — work out of `body`, plain copy, dead code**: G4

## Chat

| ID | Sev | Status | Group | Note |
|----|-----|--------|-------|------|
| C7 | P2 | defer | — | design: which composer controls collapse first at 280 pt; composer layout has a crash history |
| C8 | P2 | defer | — | design: should a keyboard Allow exist while the composer owns Return |
| C9 | P2 | defer | — | design: one-step Deny with an optional reason, or keep two steps and focus the field |
| C10 | P2 | fix | G2 | tray rows are index-keyed; a half-typed deny reason carries to the next confirm |
| C11 | P2 | fix | G1 | slash rows: button + selected traits |
| C12 | P2 | fix | G2 | Revise overwrites the unsent draft |
| C13 | P2 | fix | G2 | failed "Park to backlog" is still marked handled |
| C14 | P2 | defer | — | design: notice wording, and whether errors auto-dismiss |
| C15 | P2 | fix | G1 | labels, selected tab, ≥ 20 pt targets on tab close / chip remove / plan chevron / `+` / queue remove |
| C16 | P2 | fix | G1 | grips already fixed; image preview still tap-only |
| C17 | P2 | fix | G3 | literal red/green/black/white in confirm diff and orange capsule |
| C18 | P2 | defer | — | risk: streaming hot path; budget |
| C19 | P2 | defer | — | risk: streaming hot path; budget |
| C20 | P2 | defer | — | budget; the `GeometryReader` half carries a layout-crash history |
| C21 | P2 | fix | G2 | two uncancelled `/api/commands` requests per keystroke |
| C22 | P2 | defer | — | budget |
| C23 | P2 | defer | — | design: what feedback "Save session note" gives, and whether Start fresh confirms |
| C24 | P2 | defer | — | design: type-size floor touches DESIGN.md tokens (the Problems / Tasks rows are in K22) |
| C25 | P2 | fix | G4 | AskQuestion re-parses with fresh `UUID`s on every keystroke |
| C26 | P2 | defer | — | risk: observer lifecycle only verifiable in the running app; budget |
| C27 | P3 | fix | G1 | `.help` applied twice on `+` |

## Window chrome

| ID | Sev | Status | Group | Note |
|----|-----|--------|-------|------|
| W4 | P2 | fix | G1 | ModelsDialog pickers have an empty accessible name |
| W5 | P2 | defer | — | design: bind F-keys (private-use scalar trick unverified) or stop printing them |
| W6 | P2 | fix | G2 | Reset deletes the stored key with no confirm; Return does not save |
| W7 | P2 | fix | G1 | status-bar segments hit-test on their glyph; bell unread state is glyph + colour only |
| W8 | P2 | defer | — | design: how ctx pressure shows without colour |
| W9 | P2 | already fixed | — | `ViewThatFits` with full / compact / minimal tiers (`AppStatusBar.swift:66`) |
| W10 | P2 | fix | G1 | cost-history bars: accessibility elements |
| W11 | P2 | defer | — | budget: `ContentView.body` sits at the type-checker budget, needs a modifier |
| W12 | P2 | defer | — | budget |
| W13 | P2 | fix | G4 | Quick Open recomputes `filtered` and `Set(allFiles)` per access |
| W14 | P2 | defer | — | risk: moves decode off the main actor |
| W15 | P2 | fix | G4 | palette rebuilds `CommandRegistry.all` per row |
| W16 | P2 | fix | G4 | delete dead `SetupPopoverContent` / `ProjectPickerToolbarItem` and their two harness entries (the live pill was fixed earlier) |
| W17 | P2 | fix | G1 | bottom tab strip: selected trait; hide chevron label and hit area |
| W18 | P2 | fix | G1 | palette `contentShape` before padding |
| W19 | P2 | fix | G3 | Welcome and Onboarding still on system greys (the sheets were converted earlier) |
| W20 | P2 | fix | G3 | tooltip panel resolves dynamic colours once and ignores appearance |
| W21 | P2 | defer | — | design: Help-menu placement and ⌘/ vs ⌘' |
| W22 | P2 | defer | — | risk: window minimum, split-view loop history; design: the new minimum |
| W23 | P2 | defer | — | risk: window management |
| W24 | P2 | fix | G1 | menu-bar status item has no accessibility label or value |
| W25 | P2 | defer | — | budget; design: confirm on Stop |
| W26 | P3 | defer | — | design: replacement copy for the About lines; hide or detect UTF-8 / LF |

## Left panes and rail

| ID | Sev | Status | Group | Note |
|----|-----|--------|-------|------|
| L9 | P2 | defer | — | unverifiable: whether SwiftUI evaluates the app list per body pass |
| L10 | P2 | defer | — | risk: section-header layout |
| L11 | P2 | fix | G2 | branch picker Return can act on an off-screen row |
| L12 | P2 | fix | G2 | "Discard branch" has no confirm |
| L13 | P2 | fix | G1 | leftover small / help-only icon buttons |
| L14 | P2 | fix | G3 | failure detail and hints are `.tertiary`; colour to `textMuted`, sizes unchanged |
| L15 | P2 | defer | — | design: raise the shared `elevated` token or give the chip a stronger stroke |
| L16 | P2 | defer | — | risk: clamp to pane height (layout-pass history); budget |
| L17 | P2 | defer | — | risk: ADR-0114 width history |
| L18 | P2 | fix | G2 | the inert status-fetch `×` only; the error copy is a design call |
| L19 | P2 | defer | — | budget: needs `flash` / `fail` read first |
| L20 | P2 | defer | — | unverifiable |
| L21 | P2 | fix | G2 | guard the private KVC divider key |
| L22 | P2 | defer | — | budget |
| L23 | P2 | defer | — | design: the probe's doc says it exists for field diagnosis |
| L24 | P2 | fix | G1 | Sessions selection uses `rowSelected`; row is a button |
| L25 | P2 | fix | G1 | pane and section titles get the header trait |

## File viewer, review, backlog, terminal, problems, preview, Brain

| ID | Sev | Status | Group | Note |
|----|-----|--------|-------|------|
| K5 | P1 | defer | — | design: Brain idle rate (assessed and left unchanged in `86c8e2e`) |
| K6 | P1 | defer | — | design: split diff has +/− signs; the 3 pt editor gutter cannot hold a glyph |
| K7 | P2 | fix | G4 | image decoded on main inside the `content` builder |
| K8 | P2 | already fixed | — | `DiffSheet` is a `LazyVStack` and parses once (`3819440`) |
| K9 | P2 | fix | G1 | terminal `×` / `+` hit areas; confirm-on-close is a design call |
| K10 | P2 | fix | G1 | split/inline segments, zoom buttons, severity chips, collapse chevrons unlabelled |
| K11 | P2 | fix | G1 | the duplicate `.help` on Close only; shortcuts and URL-reload stay deferred (design / risk) |
| K12 | P2 | defer | — | unverifiable without a render |
| K13 | P2 | defer | — | budget |
| K14 | P2 | defer | — | risk: text-view editing path |
| K15 | P2 | fix | G4 | Problems recomputes filtered / grouped lists ~6× per body |
| K16 | P2 | fix | G4 | Backlog sorts and filters on every body evaluation |
| K17 | P2 | defer | — | budget |
| K18 | P2 | fix | G2 | `cd` escapes only spaces, so a path with a quote or `$` runs as shell; click-runs-immediately is a design call |
| K19 | P2 | defer | — | budget: needs cancel + actor cache |
| K20 | P2 | defer | — | design: freeze or slow the Brain under Reduce Motion |
| K21 | P2 | defer | — | design: where font zoom lives; risk in the editor |
| K22 | P2 | fix | G3 | Problems / Tasks / Terminal info text at 8–9 pt `.tertiary` |
| K23 | P2 | defer | — | design: overlay scrollers are a documented choice |
| K24 | P3 | defer | — | risk: replacing the probe depends on the graph route's contract |
| K25 | P3 | fix | G2 | "Filed: url" shown through the red error text; `savedFlash` never resets |
| K26 | P3 | fix | G1 | header path not selectable; ANSI palette is unverifiable and stays open |

## Critique P3s

| ID | Sev | Status | Group | Note |
|----|-----|--------|-------|------|
| U23 | P3 | defer | — | design: the row is `Equatable`; hiding a repeated label needs the previous message passed in, and what a tool-only continuation shows |
| U24 | P3 | fix | G4 | Graph pane spinner with no text |
| U25 | P3 | fix | G4 | Settings: "Sidecar", "Re-probe now", "Effective" |
| U26 | P3 | fix | G4 | the disabled Quick Open button says why; the missing sidebar toggle is a design call |

## Counts

87 rows: the 85 inputs plus K5 and K6, listed because the brief names them as design calls.

| Status | Rows |
|---|---|
| already fixed | 2 (W9, K8) |
| fix | 43 (G1 17 · G2 11 · G3 5 · G4 10) |
| defer | 42 |

Three `fix` rows are partial by design: K11 (the duplicate `.help` only), L18 (the inert `×` only) and K26 (path selection only). Their remainder is deferred for the reason in the note.

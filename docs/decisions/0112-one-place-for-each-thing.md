# ADR-0112 — One place for each thing: the multi-session chrome

- **Status:** Accepted — implemented 2026-09-10
- **Date:** 2026-09-10
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (tabs, chip, Sessions pane), [ADR-0108](./0108-per-session-posture.md) (posture per session), [ADR-0111](./0111-nothing-survives-a-tab-without-a-commit.md) (close and integration), [ADR-0040](./0040-interactive-ask-user-question.md) (the question sheet), [ADR-0062](./0062-layout-constraint-loop.md) (layout rules every new view obeys)

## Context

The user, with four screenshots of the chat header:

> *"i get lost in all these, it's not clean or fluid or easy to use and
> interact with, UI/UX is a mess."*

Counted from those screenshots and the code behind them:

| Job | Controls that do it | Where |
|---|---|---|
| switch session | 4 | tab strip · the "1" menu beside the tabs · the clock menu with Previous / Next · the Sessions pane |
| start a session | 2 | the `+` beside the tabs · **New** in the header — both split buttons with the same menu |
| choose own branch vs shared | 3 | the New menu · a segmented control in the chip popover · a Settings default the menu explains in grey |
| show state | 3 places, 2 vocabularies | "idle" at the top edge · the tab dot · the tray at the bottom edge |
| say where you are | 3 fragments | project name · a session hash `a80ac1db` · the branch in a chip |
| report something | 4 stacked bars | error banner · backlog count · plan strip · changed files — plus a gate nudge in the transcript styled as a failure |
| set posture | 5 chips, 3 styles | executor · advisor · personality · gate, monospaced lowercase |

Two names for every concept: "own branch" (New menu) is "isolated" (chip) is
"Isolated worktree" (popover). The chip popover is a settings form — a
segmented control, a text area, a Save button, two paragraphs — living in a
popover. The New menu's last line, *"Default (⌘⇧N): isolated — change in
Settings"*, is a control that needs a sentence to explain where it is
configured.

None of this was designed. It is five features from five days — Cursor-style
tabs, the open-sessions menu, the history menu, the chip, the Sessions pane —
each with its own entry point, none retired when the next arrived. Apple's
*Principles of Great Design* name the two rules broken: **things that do the
same job live in the same place** (familiarity), and **if a label is needed to
explain a control, the mapping is weak** (grouping and mapping). Their
material guidance adds a third: **a parallel task gets a non-blocking panel,
not a modal with a scrim** — and a tool confirm is a parallel task.

## Decision

**The tab strip is the only switcher. The Sessions pane is the only place to
manage many. Everything about one tab lives in one context bar under its tab.
One vocabulary. One edge for feedback. Confirms do not block.**

### 1. Switching and starting (M1)

- The tab strip switches. The "N" open-sessions menu is removed; Previous and
  Next stay as keyboard commands (⇧⌘[ / ⇧⌘]).
- One New control: the split `+` beside the tabs. The header's **New** button
  is removed. The menu keeps its two shapes and loses the grey explainer; the
  default is whatever the plus does, and Settings still sets it.
- The clock menu becomes **History**: closed sessions only, newest first,
  since open ones are already tabs. Its last item opens the Sessions pane.
- The header says where you are: project name, then the branch chip. The
  session hash goes to the tooltip.
- One vocabulary everywhere: **own branch** and **shared**. The chip reads
  `own branch · fix-the-thing` (the humanised branch, full name on hover) or
  `shared`.
- A tab carries a glyph beside its dot, so colour is never the only signal: a
  spinner while working, the orange count while waiting on you, a rotating
  arrow when interrupted, a cross when failed.

### 2. The chip popover is facts plus two actions (M2)

Branch, cut from, commits, ahead and behind, changes; then **Switch to
shared** / **Switch to own branch** and **Open in Sessions**. The lane editor
moves to a sheet (reached from the popover's *Edit lane…* and from the
Sessions row's context menu), where a text area and a Save button belong. The
two explanatory paragraphs become one *Learn more* link into the worktrees
guide.

### 3. Posture is one pill (M3)

The four identity chips collapse into one pill, `sonnet-5 · fable-5-1 ·
ultron · auto`, that opens one popover holding the existing controls.
ADR-0108 made posture per session; this is the control that decision implies.

### 4. Feedback on one edge (M4)

The bottom tray is the one status surface. A stream error that has nothing to
retry dismisses itself after a few seconds; one with a Retry stays until the
next turn starts. A gate nudge in the transcript renders as a neutral system
note, not in the red that means failure. Status, completion, warning and
error each get their own colour and glyph.

### 5. Confirms do not block (M5)

A tool confirm renders as a card in the tray above the input — tool, the
command or path, the reason, Allow and Deny, a deny message behind a
disclosure — never as a modal sheet over the transcript. The question sheet
(ADR-0040) stays a sheet: it is a form. The same card renders inline in the
Sessions pane's **Needs you** row, so a waiting tab is answered without
switching to it. The watch row gains the pending confirm's excerpt and reason
for that purpose; the answer goes through the existing confirm route.

### 6. The Sessions pane, five sections (M6)

Needs you (with inline answers; Interrupted and Failed fold in with their own
glyphs, since both need a human) · Working · Ready to integrate (ADR-0111) ·
Idle · History. Rows are two lines — title, then branch and a state phrase —
with one primary action on the right and the rest in the context menu. Arrow
keys and Return switch, ⌘W closes.

### Considered and not taken

- **Retiring the tab strip in favour of the pane.** Tabs are the familiar
  macOS pattern for "several documents of one kind"; the pane is for many.
- **A single "session switcher" popover replacing both.** Would recreate the
  "1" menu under a new name.
- **Moving the brain's caption into the tray.** The caption belongs to the
  brain view, which is its own feature (ADR-0021); it is left where it is and
  the tray no longer duplicates it.

## Consequences

- Controls shipped by other sessions this week are removed: the open-sessions
  menu, the header New button, the popover's segmented control and lane form.
  The behaviours they exposed remain reachable by exactly one path each.
- A confirm can be answered from the Sessions pane, which is the change that
  makes several tabs fluid: three waiting tabs are cleared without leaving the
  one on screen.
- Client-only, except one watch-row field (the pending confirm's excerpt and
  reason). Every new view obeys ADR-0062: ScrollView-rooted, no measurement
  views, no state writes in layout.

## Scope of Done

- [x] M1 — switching and starting consolidated; History; header; vocabulary; tab glyphs (4998c0e6)
- [x] M2 — chip popover facts + two actions; `LaneSheet`; Learn more link
- [x] M3 — posture pill with one popover holding the four controls
- [x] M4 — an error with nothing to retry dismisses itself after 8 s. **Not done:** re-colouring a gate denial in the transcript — it arrives as the tool's error result, and to the model it *is* an error; a different colour would need the sidecar to mark its own denials, deferred.
- [x] M5 — `ConfirmCard` in the tray for tool confirms, the sheet kept for the question form; inline Allow / Deny in the Needs-you row; `excerpt` + `reason` on the pending summary
- [x] M6 — Needs you absorbs Interrupted and Failed with their own glyphs; Working · Ready to integrate · Idle · History; ↑ ↓ ⏎ on the list
- [x] Docs: ADR-0107 amendment, worktrees guide vocabulary, roadmap

Not in scope and noted for later: the brain caption at the top edge (ADR-0021's surface); ⌘W in the pane, which belongs to the tab-close command; a per-state glyph in the History menu.

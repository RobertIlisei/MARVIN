# ADR-0114 — One vocabulary for the left pane

- **Status:** Accepted — implemented 2026-09-11
- **Date:** 2026-09-11
- **Related:** [ADR-0025](./0025-skills-pane-ui.md) (the Skills pane), [ADR-0062](./0062-update-constraints-loop-identified-mitigated.md) (the layout-pass loop this must not re-enter), [ADR-0105](./0105-practice-loop.md) (the Practice pane), [ADR-0112](./0112-one-place-for-each-thing.md) (one place for each thing, and its affordance amendments)

## Context

The user asked for an Apple-design pass over all seven left panes, with one instruction attached: *"do not remove any functionalities instead add more functionalities if possible."*

Three surveys measured what is actually there. The finding is not that the panes are ugly — several are dense and well-organised. It is that **there is no shared control vocabulary**, so the same concept is drawn a different way in each pane:

| Concept | Implementations |
|---|---|
| Button style | 5 — `.borderless`, `.bordered`, `.borderedProminent`, `.plain`, `.link` |
| Section header + count | 5 private implementations |
| Empty state | 3 registers |
| Corner radius | 4 — 3, 4, 5, 6 |
| Pane title | 4 shapes; 2 of 7 use `paneHeaderHeight` |

This is Apple's **Familiarity** principle failing at the level of the whole sidebar: things that look the same do not behave the same, and things that behave the same do not look alike. Four consequences are visible today.

**Practice's header squeezes its own labels.** Five buttons, three text-labelled, plus a title and a bare `Spacer()` in one `HStack`, inside panes that compress to nothing. SwiftUI resolves it by truncating: `Run now` becomes `Run no…`. The same shape is latent in Skills, Plugins and Files, and it is the same class of bug just fixed in the branch-chip popover ([ADR-0112](./0112-one-place-for-each-thing.md), second amendment).

**A failure looks exactly like a success.** Skills, Plugins and Practice each route every outcome through one tinted strip with one icon, auto-dismissed after three or four seconds. *"Installed marvin-graph"* and *"Install failed: HTTP 500"* are the same pixels, and the message that mattered is the one guaranteed to vanish before it is read. `PaneNotice` — kinds, glyph, headline split from machine detail — already existed and exactly one pane used it.

**The central control in Skills and Plugins is not a control.** Enable/disable is a `.buttonStyle(.plain)` SF Symbol: no hover, no press, no focus ring, no accessibility trait. Enabling a plugin loads MCP servers and agents into the model's tool surface.

**Practice styles destructive verbs as hyperlinks.** *Reset findings…*, *Dismiss*, *Retire* are `.buttonStyle(.link)` — blue text that mutates state, with no hit target and no press feedback.

## Decision

**One vocabulary, admitted by measurement, applied one pane at a time.**

### What is shared, and the rule that decides

A thing joins the vocabulary when **three or more panes need it AND its signature carries no pane-specific parameter.** Everything else stays local. Seven call sites do not justify a framework, and the failure mode of over-abstracting a sidebar is a component with nine booleans, which is worse than five copies.

By that rule:

- **`MARVINLogic/PaneChrome.swift`** — the decisions, as values: `PaneEmptyState` with factories (`noProject(_:)`, `notARepo()`, `noResults(query:)`, `nothingYet(_:)`), `PaneBadge.text(_:)` (clamped at `999+`), `PaneHeaderOverflow.plan(actionCount:)`. Plus `PaneNotice.Dismissal` on the existing type.
- **`MARVIN/Pane*.swift`** — the drawing, holding no rules: `PaneHeader`, `PaneSectionHeader`, `PaneEmptyView`, `PaneLoadingView`, `PaneNoticeStrip`, `paneIconButton()`, `PaneEnableToggle`, `paneRow(selected:hovering:)`.
- **`MarvinTheme.Radius`** — `badge 3 / chip 5 / card 6`, replacing four radii with no rule behind them.

`InlineActionChip` (ADR-0112's chip roles), `MarvinDivider`, `GitDecorationColor` and `MarvinTheme`'s colours are unchanged and become the base layer.

**Row *content* fails the admission rule and stays per-pane.** A skill row carries a toggle, a version and a contribution list; a git file row carries a status letter and a path; a finding row carries a score and eight states. They share a rectangle, a hover, a selection fill and their padding — so row shape ships as a **modifier** over a caller-built `HStack`, never as a container with a title and a subtitle.

### Where the decisions live, and why

`MARVINTests` links `MARVINLogic` and nothing else. A rule that lives inside a SwiftUI view therefore cannot be asserted, so every rule is a value or a function over values, and the views hold none. That is what makes "the copy is in one register" and "a failure never dismisses itself" testable claims rather than intentions.

**`PaneNotice.dismissal` is decided by kind**, not by the call site: success and info may leave on their own, warning and error wait to be dismissed. No caller can get it wrong, which is the point — the bug was not that someone chose badly, it was that the choice existed.

**`PaneHeaderOverflow` decides by action count, not by measurement.** More than two actions lose their labels; more than four move behind a `…`. A `GeometryReader` or `ViewThatFits` would re-enter layout in order to decide layout, which is the oscillation [ADR-0062](./0062-update-constraints-loop-identified-mitigated.md) crashes on. A rule a person can predict is also worth more than one that is pixel-perfect and changes under them as they drag the splitter.

### Three constraints every shared component obeys

1. **No intrinsic `minWidth`, and `Spacer(minLength: 0)` never a bare `Spacer()`.** All seven panes stay mounted in a `ZStack` (`LeftPane`), so the container's minimum width is the widest of the seven. The last component that declared one pushed the 44pt activity rail off the left edge. The default spacer contributes intrinsic width of its own, which is the other half of why header rows squeezed.
2. **No component may be applied to a pane root, and none makes a container `.focusable()`.** That draws macOS's focus ring around the entire pane — reported in 2026-08-31 (*"the blue lines of the pane, this is not very professional"*) and again on 2026-09-11 (*"clicking anything in Sessions just selects the whole pane"*). Focus belongs on the controls.
3. **Animate `hovering`, `pressed` and `notice` — never layout.** `PaneNoticeStrip` transitions on opacity only: a height transition inside a mounted, zero-framed pane slot re-lays out the whole pane. And no `.textSelection(.enabled)` anywhere inside a ScrollView-rooted pane view.

### Applied one pane at a time

Every component is an additive leaf, so a pane adopts one element per commit — notice, then empty and loading, then section headers, then buttons, then row shape, then the header last, because the header is the riskiest layout change. Nothing is deleted during migration and the app ships at every commit.

Milestone order settles the new components on the small panes before the large ones, and takes the worst-looking first as the user asked: Practice, Plugins, Skills, Files, Search, then Source Control and Sessions together.

### Considered and not taken

- **A full component library with a row container.** Rejected by the admission rule above: the seven rows have almost nothing in common below the rectangle.
- **Measuring the header to decide overflow.** Rejected for ADR-0062; a count rule is predictable and cannot oscillate.
- **Converting all seven panes in one pass.** Rejected with the user: a wrong call would cost seven panes before anyone saw it.
- **Snapshot tests.** No infrastructure exists and adding it is out of scope. The loss mode that matters — a dropped action, help string or keyboard shortcut — is caught instead by an action-surface diff over each pane before and after.

## Consequences

- The same action reads the same way in every pane, and a control looks like a control.
- A failure stays on screen until dismissed, everywhere, because its kind decides rather than its call site.
- New panes get the vocabulary for free, and the admission rule tells a future author when to add to it rather than inventing a sixth variant.
- Seven panes must each be touched; until they are, the sidebar is briefly *more* inconsistent, not less. The milestone order is what keeps that window short and visible.

## Scope of Done

- [x] M0 — `PaneChrome` decisions with assertions, the six view components, the radius scale, this ADR
- [x] M1 — Practice
- [x] M2 — Plugins
- [x] M3 — Skills
- [x] M4 — Files
- [x] M5 — Search
- [x] M6 — Source Control + Sessions
- [x] M7 — roadmap and changelog

## What it found on the way through

Restyling seven panes turned up things the surveys had not, because a control
only reveals what it does when you try to move it.

**Search opened the file but not the line.** `match.line` was decoded, rendered
in the gutter two lines below the call, and thrown away; `openFileFromChat`
already scrolled and had since chat links needed it. One line, and the highest
single return of the whole pass.

**Replace All was the most destructive control in the sidebar** and had no
confirm, no preview, no undo, and a tooltip on a 10pt icon for its only error
report — while writing file by file, so a throw halfway left a part-replaced
repository with nothing said about it. It asks now, and a partial run names the
file it stopped on.

**Two panes shipped a toggle that was not a toggle**, and one of them loads MCP
servers and read-only agents into the model's tool surface when switched on.

**A refused plugin toggle did nothing at all** — a non-2xx that did not throw
had no `else` branch, so being refused and being a no-op were the same
experience.

**Dismissing a Practice finding was a one-way door**, so undo was built
(`undismissFinding`) as the same transition recurrence already made on its own.

**Uninstall was in the plan and was not built.** MARVIN clones a plugin but
records it in `~/.claude/plugins/installed_plugins.json`, which Claude Code
owns and both tools read; removing one is a cross-tool destructive edit that
belongs in Claude Code's own `/plugin` UI. The row's menu says so rather than
leaving the user to guess, and the plan's item is closed as *declined*, not
done.

**The action-surface diff earned its place.** Moving Practice's header actions
into an overflow menu dropped two `.help()` strings, which the diff caught
immediately; they were restored on the menu items. Every milestone's commit
message carries its own diff.

## Verification as built

`swift build` and `swift run MARVINTests` green at every commit: **894
assertions**, 39 of them new — the empty-state copy, the badge clamp, the
overflow plan, the notice dismissal, and the outcome-kind reader. Sidecar 1382
tests green for the one runtime change (`undismissFinding`, 2 new tests).

Still owed, and honestly: the narrow-width pass and the Tab-through-the-pane
pass are manual, and have not been done — they need the rebuilt app in front of
a person.
# The pane standard

*One standard for every side pane and panel. Written 2026-11-25; enforced by the
kit (`macos/MARVIN/Pane*.swift`), by the rules in `macos/MARVINLogic/`, and by
two source scans in `MARVINTests`. Builds on
[ADR-0114](../decisions/0114-one-vocabulary-for-the-left-pane.md).*

The owner's review (2026-11-24): *"we are not using a standard, each thing has
its own design, which is confusing."* A person who has learned one pane has to
have learned them all. This document is what they learn, the inventory that
shows how far the panes drifted, and the kit that makes the right thing the
short thing to write.

## 1. What was measured

Every pane and panel, 2026-11-25, before this work. "Private" means a header,
row or section-header view the pane defines itself instead of the kit's.
"Below 11 pt" counts `.font(.system(size: <11))` on text and the 10 pt text
styles (`.caption`, `.caption2`, `.footnote` are all 10 pt on macOS).

| Surface | File | Kit used | Private chrome | Below 11 pt | Sizes in use (pt) |
|---|---|---|---|---|---|
| Files | `FileTreeView` | header, empty, loading, icon button, notice | `FileTreeRow` | 7 | 10, 10.5, 11 |
| Search | `FindInFilesView` | empty | `matchRow` | 15 | 8, 9, 10, 11, 12 |
| Source control | `SourceControlView` | header, group header, empty, loading, icon button | 8 (`worktreeRow`, `repoHeaderRow`, `panelHeader`, `SourceControlRow`, …) | 34 | 7 to 15, nine sizes |
| Sessions | `SessionsPane` | header, group header, empty, icon button, notice | `sessionRow`, `sectionHeader`, `header`, `integrateRow` | 8 | 9, 10, 11, 12 |
| Skills | `SkillsPane` | header, group header, empty, loading, toggle, notice | `discoveredRow`, `suggestionRow`, a private `sectionHeader` | 36 | 9 to 12 |
| Plugins | `PluginsPane` | group header, empty, toggle, notice | `pluginRow`, `catalogRow`, a hand-drawn header | 21 | 8 to 12 |
| Practice | `PracticePane` | header, empty, notice | `findingRow`, `ruleRow`, `howRow`, a `header` | 67 | 9 to 11 |
| Supervisor workspace | `SupervisorWorkspaceView` | group header, icon button, notice | `SupervisorWorkspaceHeader`, rows | 12 | 8 to 12 |
| Supervisor (rows, inbox, queue, merge) | `SupervisorViews`, `SupervisorInboxViews`, `SupervisorQueueViews`, `SupervisorMergeViews` | `paneRow`, group header, toggle, notice | `SupervisorInboxRow`, `entryRow`, `capRow`, `branchRow`, … | 21 / 31 / 14 / 12 | 8 to 12 |
| Backlog panel | `BacklogPanel` | none | `groupHeader`, `header`, `row`, `metaRow` | 26 | 9, 10, 12 |
| Plans panel | `PlansPanel`, `PlanCardView` | none | `header`, `planRow`, `stepRow` | 8 / 2 | 9 to 12 |
| Project tools | `ProjectToolsPanel` | none | none | 10 | 8 to 11 |
| Diagnostics | `DiagnosticsPanelView` | none | `header`, `fileHeader`, `row` | 13 | 8 to 26 |
| To-do strip | `TodoListView` | none | `row` | 8 | 9, 10, 11 |
| Terminal / Preview / Graph | `TerminalPaneView`, `PreviewPaneView`, `GraphPaneView` | none | a header each (Terminal, Graph) | 6 / 2 / 0 | 8 to 13 |

What this adds up to: five section-header shapes, five icon-button styles,
three registers of empty text, a group header that could not be collapsed
anywhere but one place, rows with up to four visible buttons in 9.5 pt grey, and
type from 7 pt to 15 pt with no scale behind it. After this work Skills,
Plugins and Practice are at **zero** private chrome and **zero** text below 11 pt
(before: 36, 21 and 67). The scans below keep them there, and keep every file
that has not moved yet on a visible, named allowlist.

## 2. The standard

Each rule names the Mac convention it follows (`apple-design`: familiarity,
consistency, wayfinding, agency, feedback, grouping, craft) and what to do and
not do, from this app.

### 2.1 The anatomy of a pane

```
 PANE TITLE  12              [ one verb ] [ … ]      header, 38 pt, always present
 ┌──────────────────────────────────────┐
 │ ⌕ Filter skills                      │             filter, only if the pane has search
 └──────────────────────────────────────┘
 ⌄ Needs update  3               [ Update all (3) ]   group header: disclosure, count, ONE bulk action
   ◉  graphify                 [ Update ]  …        row
      Build and query a knowledge graph…              ONE secondary line
 ⌄ On in this project  12
   ◉  pdf-extract                                …
      No description
 › Off in this project  25                            closed: draws nothing below its header
 ───────────────────────────────────────────────
 ⚠ All up to date, but 2 could not be checked.        notice, at the bottom, kind visible
```

The header never scrolls; the body does. Wayfinding (*where am I, what can I do
here, how do I get out*) is answered by the same four places in every pane.

### 2.2 Pane header

| | |
|---|---|
| **Is** | Title (uppercase 11 pt semibold, or the project name at 12 pt), an optional count (`count:`), an optional one-phrase subtitle ("ran 2h ago"), and **at most two trailing actions**: the one verb the pane exists for, and a `PaneOverflowMenu` for everything else. Search sits directly under it. |
| **Convention** | A toolbar holds the primary verb and an overflow; the rest is in a menu (Finder, Mail, Xcode). Hierarchy: the most important thing is the most obvious. |
| **Do** | Skills: `SKILLS 46   [Add…] […]`. Check for updates and Reload are in the menu. |
| **Do not** | Practice's old header: five buttons, three with labels, so *Run now* rendered as *Run no…*. |
| **Kit** | `PaneHeader(title:symbol:uppercase:subtitle:count:trailing:)`, `PaneActionButton`, `PaneOverflowMenu`. |

### 2.3 Group header

| | |
|---|---|
| **Is** | Disclosure chevron, label (11 pt semibold, muted, not uppercase: the pane title is the uppercase line), a count capsule (tinted: orange for "needs attention", accent for an update; hidden at zero), and **at most one bulk action** on the right ("Update all (3)", "Discover"). Click, Space or Return opens and closes it. The choice is remembered per pane and per group. A filter that is active shows its matches even in a closed group. |
| **Convention** | Source lists and disclosure groups (Finder sidebar, Xcode navigator): disclosure is how a long list is made short; the state is remembered across launches. Agency: the person decides what is in the way. |
| **Do** | Skills opens with *Off in this project (25)* and *Suggested (4)* closed: 46 skills read as 20 rows. |
| **Do not** | Sessions' "Finished" list: forty rows, no way to minimise them (the owner's first complaint). A paragraph under every header explaining the group: it is the header's tooltip (`help:`). |
| **Kit** | `PaneGroup(store:id:title:count:tint:help:startsCollapsed:filterActive:trailing:content:)`, `PaneCollapseStore(pane:)`, `PaneSectionHeader` (the header alone, with `onToggle`). |

A group with nothing in it is **not drawn**; a group with a reason to exist
and nothing to show draws a `PaneNote`. Collapsing is instant, not animated:
a height transition inside a mounted pane slot re-lays out the whole sidebar
(ADR-0062). Only the chevron turns.

### 2.4 Row anatomy

```
[leading]  Title ......................... trailing state    [action]  […]
           one secondary line, truncated
```

| Part | Rule |
|---|---|
| **Leading** | A glyph that says what the row *is* (a shape, never colour alone), or the enable switch. One width, so titles align down a group. |
| **Title** | One line, 12 pt, truncated in the middle. An identifier (skill, plugin, rule id) is monospaced. |
| **Secondary** | **One** line, 11 pt, muted, truncated at the tail. What would be a second and third line is a *detail*: shown under the row when it is selected. A missing description is a dim, italic "No description", never a blank and never a stray ">" (the YAML marker the sidecar once passed through). |
| **Trailing state** | State as **text**, with a glyph when it is a warning or an error ("⚠ Not loaded", "✓ Updated"). If it does not fit, the text goes and the glyph stays. Colour only agrees with the words. |
| **Action** | **At most one visible**: the first `.primary` item, which is the point of the row ("Update", "Approve", "Install"). A destructive verb is **never** visible. Everything else is in the "…" menu, which is also the context menu: right-click and the ellipsis offer one list. |
| **Busy** | A spinner takes the action's place while its work runs. |

**Convention**: a list row in Mail or Finder: icon, name, one line of detail,
detail on the right, controls on hover. Consistency: things that look the same
behave the same and live in the same place.
**Do**: Practice findings: `ship.unreviewed … ⚑ High priority · 3 sessions ·
10 % of sessions   [Approve]  […]`, with Fixed in MARVIN, Draft, Dismiss and
the tier choices in the menu. **Do not**: the old card with four small grey
buttons and a bare `0.67 / 1.00`.

Kit: `PaneListRow(rowID:title:titleIsIdentifier:leading:secondary:secondaryStyle:trailingText:trailingSymbol:trailingTint:trailingHelp:selected:busy:items:menuLabel:onSelect:showsDetail:detail:)`,
`PaneRowItem`, `PaneRowLeading`. The *decision* of which item is visible is
`PaneRowActionPlan.plan` in `MARVINLogic`, tested.

A row that genuinely does not fit the anatomy (a git file with a status letter,
a chat tab) wears the shared rectangle, `.paneRow(selected:hovering:)`, and
keeps the rest of the rules (type scale, states, accessibility).

### 2.5 Selection, hover, focus

| State | Look |
|---|---|
| **Rest** | Clear. The "…" rests dimmed (50 %) so fifty rows are not fifty bright ellipses. |
| **Hover** | `MarvinTheme.rowHover` fill; the "…" at full strength. Hover is a *real* affordance on a precise-pointer platform. |
| **Selected** | `MarvinTheme.rowSelected` fill and the detail block opens beneath the row. |
| **Keyboard focus** | The selected row of a list that owns the keyboard gets a 1.5 pt accent hairline inside it. The system focus ring is off (`focusEffectDisabled`): it drew a box round the whole pane, twice (see `PaneHeader.swift`). |
| **Press** | Feedback on pointer *down* (the chip deepens and settles at 0.97, no overshoot), critically damped. Reduced motion drops the scale and keeps the colour. |

Convention: a source list shows a quiet grey selection when its list is not
key and the accent when it is.

### 2.6 Empty, loading, error

One sentence, one action, centred in the body, header still on top.

| State | Words | Action |
|---|---|---|
| No project | "No project open. Open a project to see its skills." | Open Project… |
| Nothing yet | "No plugins yet. Install one from a marketplace…" | The pane's verb ("Install…"), and then the header does not repeat it |
| Filter matched nothing | "No skills match “zzzz”." | Clear filter |
| Loading | "Reading the skills index…" | none |
| Error | "Could not load skills. Check that MARVIN's server is running, then try again." | Retry |

**Do not**: `(empty tree)`, `(initialising)`, `(not a git repository)`: a person
cannot tell from debug text whether the app is broken, busy, or waiting for them.
Copy is data: `PaneEmptyState` (`.noProject`, `.nothingYet`, `.filtered`,
`.couldNotLoad`, `.notARepo`, `.noResults`). Kit: `PaneEmptyView`, `PaneLoadingView`.

### 2.7 Notices (the outcome of an action)

Four kinds, each with its own glyph: info, success, warning, error. A success
leaves after three seconds; a warning or an error **waits to be dismissed**,
because the failure is the message that has to be read. One verb at most
("Retry", "Undo"). Not selectable (ADR-0062). Kit: `PaneNoticeStrip`,
`PaneNotice` (`MARVINLogic`).

### 2.8 Type scale: nothing a person must read is below 11 pt

| Token | pt | Used for |
|---|---|---|
| `PaneFont.paneTitle` | 12 semibold | a pane title that is not the uppercase kind |
| `PaneFont.rowTitle` / `rowTitleMono` | 12 | a row's first line |
| `PaneFont.secondary` / `secondaryMono` | 11 | the secondary line, trailing state, notices |
| `PaneFont.group` / `count` | 11 semibold | group labels, header titles, counts |
| `PaneFont.field` | 12 | text in the filter |
| `PaneFont.emptyHeadline` / `hint` | 12 medium / 11 | empty states |
| `PaneFont.action` | 11 medium | button labels (`PaneActionButton`) |

Glyphs (a chevron, a status symbol) are not text and are not on the scale. The
values are `PaneTypeScale` in `MARVINLogic`; a test holds every token to the
floor. **Exception, documented**: the activity rail's 9 pt count badge in a 44 pt
column (`LeftPane.swift`) is window chrome, not a pane.

### 2.9 Spacing scale

`PaneSpace`: `hairline 2`, `tight 4`, `compact 6`, `standard 8`, **`gutter 10`**,
`section 12`, `roomy 16`; rows are at least 26 pt tall (a pointer target with one
line of text); the overflow button is 24 × 24. The gutter is the left and right
edge of the header, the group header and the row, so they line up. It is 10 and
not 12 because it was already 10 in the header, the rows and the file tree.

### 2.10 Keyboard

| Key | Does |
|---|---|
| ↑ ↓ | Move the selection through the visible rows; stops at the ends |
| Home / End | First / last row |
| Return | Activate: the row's one obvious thing (run its primary action, open it) |
| Space | Toggle: the switch, a group's disclosure when the header has focus |
| Esc | Clear the filter; if it is empty, clear the selection |
| Letters | Type-ahead: the next title that starts with them; a one-second pause starts a new word; one letter again cycles |
| ⌘ and ⌃ chords | Never swallowed: they belong to the window |

Convention: a source list. The rules are `PaneKeyNav` and `PaneTypeAhead`
(`MARVINLogic`, tested); `PaneScrollList` is the wiring.

### 2.11 Accessibility

Every control has a name: the "…" is "More actions for graphify", the switch is
the skill's name, the clear button is "Clear filter", a group header reads
"Needs update, 3 items" with the value "collapsed" or "expanded". State is in
the words and the glyph, never in colour alone. A row's text is one element
(title, secondary and trailing read together); its buttons stay separate.
Reduced motion drops the scale on press and keeps the colour change.

## 3. The kit on one screen

Existing components keep their signatures; everything below was added with
defaults, so a branch written against the earlier kit still compiles.

```swift
// Tokens
PaneFont.paneTitle | rowTitle | rowTitleMono | secondary | secondaryMono | group | count | action | field | emptyHeadline | hint
PaneSpace.hairline | tight | compact | standard | gutter | section | roomy | rowMinHeight

// Header, group, row
PaneHeader(title:, symbol: = nil, uppercase: = true, subtitle: = nil, count: = nil) { trailing }
PaneSectionHeader(title:, count: = nil, tint: = muted, collapsed: = nil, onToggle: = nil, help: = nil) { trailing }
PaneGroup(store:, id:, title:, count: = nil, tint: = muted, help: = nil, startsCollapsed: = false,
          filterActive: = false) { trailing } content: { rows }
PaneCollapseStore(pane: "skills")            // @Observable; persists marvin.pane.<pane>.collapsedGroups
PaneListRow(rowID:, title:, titleIsIdentifier: = false, leading: = .none, secondary: = nil,
            secondaryStyle: = .normal, trailingText: = nil, trailingSymbol: = nil, trailingTint: = muted,
            trailingHelp: = nil, selected: = false, busy: = false, items: = [], menuLabel: = nil,
            onSelect: = nil, showsDetail: = false) { detail }
PaneRowItem(id:, title:, systemImage: = nil, role: = .normal | .primary | .destructive,
            enabled: = true, help: = nil, perform:)
PaneRowLeading: .none | .glyph(symbol, tint) | .toggle(isOn:, name:, help:, onToggle:)
PaneRowSecondaryStyle: .normal | .placeholder | .warning | .error
.paneRow(selected:, hovering:)               // the shared rectangle, for rows that do not fit the anatomy

// Controls and inputs
PaneActionButton(title:, role: = .neutral, help: = nil, disabled: = false, action:)   // 11 pt label
PaneOverflowMenu(label:, emphasised: = true) { menu items }                            // the "…"
PaneFilterField(text:, prompt:)                                                        // under the header
PaneEnableToggle(isOn:, name:, help:, onToggle:)
.paneIconButton(size)

// The scrolling body, with the keyboard
PaneScrollList(rows: [(id, title)], selection: $id, onActivate:, onSpace:, onEscape:) { content }

// States and notices
PaneEmptyView(state:, actionTitle:, action:)    PaneLoadingView(label:)    PaneNote(text:)
PaneNoticeStrip(notice:, actionTitle:, onAction:, onDismiss:)

// MARVINLogic: the decisions, tested
PaneTypeScale  PaneSpacing  PaneFilter.matches(_:in:)  PaneCollapseState  PaneRowActionPlan.plan
PaneBulkAction.title(_:count:)  PaneKeyNav.move  PaneTypeAhead  InstalledGrouping.group  PracticeScoreBand
PaneEmptyState (.noProject .nothingYet .filtered .couldNotLoad .notARepo .noResults .awaitingInput)
PaneSourceScan (the allowlist `migrating`)
```

### A pane in twenty lines

```swift
VStack(spacing: 0) {
    PaneHeader(title: "Things", symbol: "square.stack", count: things.count) {
        PaneActionButton(title: "Add…", role: .primary) { add() }
        PaneOverflowMenu(label: "More actions for things") { Button("Reload") { reload() } }
    }
    PaneFilterField(text: $filter, prompt: "Filter things")
    PaneScrollList(rows: visible, selection: $selection) {
        PaneGroup(store: groups, id: "open", title: "Open", count: open.count) {
            ForEach(open) { t in
                PaneListRow(rowID: t.id, title: t.name, leading: .glyph("circle"), secondary: t.summary,
                            items: [PaneRowItem(id: "done", title: "Done", role: .primary, perform: { done(t) })],
                            onSelect: { selection = t.id })
            }
        }
    }
}
```

## 4. The guard

`PaneSourceScan` (`MARVINLogic`), run by `MARVINTests` over `macos/MARVIN/`:

1. **No private chrome.** A pane file may not define a header, a row or a
   section-header view (`func`/`var`/`struct` named `…Row`, `…Header`, `row…`,
   `header…` that returns a view) unless its body builds from the kit
   (`PaneListRow`, `.paneRow`, `PaneHeader`, `PaneSectionHeader`, `PaneGroup`,
   `PaneFilterField`). A `skillRow(_:)` that returns a `PaneListRow` is fine; one
   that draws its own `HStack` fails the build.
2. **No text below 11 pt.** `.font(.system(size: N))` with N under 11, or `.caption`,
   `.caption2`, `.footnote`, fails, except for a glyph (an `Image` on the same or
   the two preceding lines, or a `// glyph` note).

A "pane file" is `Pane*.swift` (the kit: scanned for size only), `*Pane.swift`,
`*Panel.swift`, `*PaneView.swift`, `*PanelView.swift`, and a short named list. A
new `FooPane.swift` is scanned the day it appears.

`PaneSourceScan.migrating` is the allowlist: each file with who is moving it.
It starts with the panes not yet on the kit (Sessions, Backlog, Plans, Plan
card, Source control: one agent each on 2026-11-25; the rest *unassigned*, from
the inventory above). **Entries leave as those branches merge; nothing joins
it.** Migrated files are asserted off the list by name.

## 5. How a pane moves onto the standard

1. Replace the header with `PaneHeader` (one verb, one `PaneOverflowMenu`).
2. Replace each section with a `PaneGroup`; move the explaining paragraph into
   its `help:`.
3. Replace each row with `PaneListRow` and a list of `PaneRowItem`s (one
   `.primary`); anything a row used to show as a second or third line becomes its
   `detail`.
4. Replace empty, loading and error text with `PaneEmptyState`.
5. Put `PaneScrollList` around the rows and feed it the visible ids.
6. Take the file off `PaneSourceScan.migrating`; the two scans must pass.
7. Render it (`MARVIN_SNAPSHOT_VIEW`, see `SurfaceSnapshotPaneKit.swift`) with
   dozens of rows, empty, and error, at 260 and 420 pt, and read the PNGs.

## 6. Known gaps, on purpose

- `InlineActionChip.swift` still draws its label at 10 / 10.5 pt. `PaneActionButton`
  sets the label at 11 pt on top of it; folding the two (one style, 11 pt) is a
  one-line change in a file other panes are editing today, so it waits.
- Keyboard behaviour is tested as logic (`PaneKeyNav`, `PaneTypeAhead`) and
  rendered; it has **not** been driven by a person in the running app, which this
  work was not allowed to touch. Verify arrows, Return, Space, Esc and type-ahead
  in a live Skills pane before relying on it.
- Group disclosure persists in `UserDefaults` under `marvin.pane.<pane>.collapsedGroups`.
  Two windows share it; that is the intended behaviour, not a bug.

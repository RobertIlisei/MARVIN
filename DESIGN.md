---
name: MARVIN (native macOS app)
description: A dense, flat, hairline-separated macOS IDE shell in two close greys, built on native AppKit/SwiftUI controls with the system accent.
colors:
  chrome-dark: "#181818"
  chrome-light: "#F3F3F3"
  content-dark: "#1F1F1F"
  content-light: "#FFFFFF"
  inset-dark: "#262626"
  inset-light: "#F7F7F7"
  hairline-dark: "#2B2B2B"
  hairline-light: "#E5E5E5"
  text-primary-dark: "#D4D4D4"
  text-primary-light: "#1F1F1F"
  text-muted-dark: "#9D9D9D"
  text-muted-light: "#6E6E6E"
  row-selected-dark: "#37373D"
  row-selected-light: "#E4E6F1"
  row-hover-dark: "#2A2D2E"
  row-hover-light: "#F0F0F0"
  git-added: "#6BD18F"
  git-modified: "#E8BD78"
  git-deleted: "#D95440"
typography:
  pane-title:
    fontFamily: "SF Pro (system)"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.4px"
  pane-title-project:
    fontFamily: "SF Pro (system)"
    fontSize: "12px"
    fontWeight: 600
  section-header:
    fontFamily: "SF Pro (system)"
    fontSize: "9.5px"
    fontWeight: 600
    letterSpacing: "0.4px"
  chip-label:
    fontFamily: "SF Pro (system)"
    fontSize: "10.5px"
    fontWeight: 500
  chip-label-compact:
    fontFamily: "SF Pro (system)"
    fontSize: "10px"
    fontWeight: 500
  notice:
    fontFamily: "SF Pro (system)"
    fontSize: "10.5px"
  notice-detail:
    fontFamily: "SF Mono (system monospaced)"
    fontSize: "9.5px"
  empty-headline:
    fontFamily: "SF Pro (system)"
    fontSize: "11.5px"
    fontWeight: 500
  chat-body:
    fontFamily: "SF Pro (system)"
    fontSize: "body text style"
  chat-meta:
    fontFamily: "SF Mono (system monospaced)"
    fontSize: "caption text style"
  editor:
    fontFamily: "SF Mono (system monospaced)"
    fontSize: "12px"
    fontWeight: 400
rounded:
  badge: "3px"
  chip: "5px"
  card: "6px"
  bubble: "12px"
spacing:
  pane-header-height: "38px"
  rail-width: "44px"
  status-bar-height: "22px"
  row-x: "10px"
  row-y: "3px"
components:
  chip-neutral:
    backgroundColor: "{colors.inset-dark}"
    textColor: "{colors.text-primary-dark}"
    typography: "{typography.chip-label}"
    rounded: "{rounded.chip}"
    padding: "3px 8px"
  chip-neutral-hover:
    backgroundColor: "{colors.row-hover-dark}"
  chip-neutral-pressed:
    backgroundColor: "{colors.row-selected-dark}"
  pane-row:
    rounded: "{rounded.chip}"
    padding: "3px 10px"
  pane-row-selected:
    backgroundColor: "{colors.row-selected-dark}"
  pane-row-hover:
    backgroundColor: "{colors.row-hover-dark}"
  pane-header:
    height: "{spacing.pane-header-height}"
    padding: "0 10px"
  notice-strip:
    rounded: "{rounded.card}"
    padding: "6px 10px"
  user-bubble:
    backgroundColor: "{colors.inset-dark}"
    rounded: "{rounded.bubble}"
    padding: "8px 12px"
  activity-rail:
    backgroundColor: "{colors.chrome-dark}"
    width: "{spacing.rail-width}"
---

# Design System: MARVIN (native macOS app)

> **Provenance: derived from source, not checked against renders.** Every value below was read from the Swift sources under `macos/MARVIN/` (cited as `file:line`) and from measured counts of how the views use color, type, spacing and radii. No screenshot, snapshot or running app was consulted: this Mac cannot build the app yet, and the offscreen snapshot harness (`SurfaceSnapshot.swift`, committed unverified in `ff51c16`) has not run. Treat the file as a record of what the code *says*, to be reconciled with renders later. The system is recorded as it is; inconsistencies are listed under **Observed inconsistencies** and are not fixed here.
>
> Hex values in the frontmatter are the *dark / light* pair from `MarvinTheme.swift` (one key per appearance, because the format holds one value per key). Component tokens use the dark values; the light counterpart is the matching `-light` color.

## Overview

**Creative North Star: "The Quiet Instrument"**

MARVIN's shell is a dense, flat tool that recedes so the work (code, a plan, a diff, a confirm) leads. The source states the principle itself: regions are "separated by hairline borders, not by fill contrast" (`MarvinTheme.swift:12-16`), and the palette is two close greys sampled from Antigravity/VS Code chrome (sidebar `#181818`, editor `#1F1F1F`, `MarvinTheme.swift:12-13`). An earlier, darker cut was rejected for over-separating ("very dark and weird", `MarvinTheme.swift:14-16`).

On top of that flat shell sit native macOS controls (system `Toggle`/`Button`/`Picker`, `.controlSize(.small)` 90 times), the system accent color, SF Pro for interface text, SF Mono for anything code-like, and SF Symbols for icons. The one hand-built control vocabulary is the left-pane set from ADR-0114 (`PaneHeader`, `PaneSectionHeader`, `paneRow`, `InlineChipStyle`, `paneIconButton`, `PaneNoticeStrip`, `PaneEmptyView`). Chrome type is small (9–12 pt); the chat transcript and editor carry the larger sizes.

Brand commitments that constrain the look (from PRODUCT.md): the user remains overwatch, so status, confirms and review state must stay legible at a glance; the app stays native and keyboard-first; the assistant is called "marvin" in the transcript gutter.

**Key Characteristics:**
- Two surface greys 1–2 steps apart; hairline borders do the separating.
- Light and dark both ship, as fixed hex pairs resolved per appearance, not as derived system colors.
- Dense, small chrome type with a fixed-point scale; semantic text styles in the transcript.
- Monospace is a first-class voice (tool rows, role labels, notice detail, editor), not just code.
- Hover is a real affordance; press feedback is a 0.97 scale and a deeper fill.
- The system accent is the only chromatic brand color; the app defines none of its own.

## Colors

A neutral, near-monochrome shell with one system-provided accent and a small status vocabulary. Values are from `MarvinTheme.swift:17-44` unless noted.

### Primary
- **System Accent** (`Color.accentColor`): the user's macOS accent. Used for the primary chip (`InlineActionChip.swift:88,96`), the active rail item's 2 pt leading bar (`LeftPane.swift:426-428`), and the "you" label in the transcript (`ChatMessageRow.swift:104,146`). There is no app-defined accent asset in `macos/MARVIN/Resources/` (listing: `AppIcon.icns`, `Queries`, `Symbols`, three `marvin-*.svg`), so the accent changes with System Settings.

### Neutral
- **Chrome** (`#181818` dark / `#F3F3F3` light, `background`, `MarvinTheme.swift:22`): sidebar, activity rail, chrome strips. The darker of the two surfaces. Also exposed as `NSColor` for `NSWindow.backgroundColor`.
- **Content** (`#1F1F1F` / `#FFFFFF`, `panel`, `:26`): editor, chat, file viewer body. Used in only 4 references (`MarvinTheme.panel`), against 16 for `background`.
- **Inset** (`#262626` / `#F7F7F7`, `elevated`, `:31`): one step above content: code blocks, the input box, cards, the neutral chip, the user bubble, the hover-tooltip panel (`HoverTooltip.swift:127`). The most-referenced fill (26 uses).
- **Hairline** (`#2B2B2B` / `#E5E5E5`, `border`, `:35`): borders and the split-view divider (`SplitDividerTheme.swift:90`). Deliberately low contrast.
- **Text Primary** (`#D4D4D4` / `#1F1F1F`, `textPrimary`, `:39`): primary text; the comment calls it the "VS Code editor fg".
- **Text Muted** (`#9D9D9D` / `#6E6E6E`, `textMuted`, `:41`): secondary and caption text, pane titles, icon default.
- **Row Selected** (`#37373D` / `#E4E6F1`, `:43`) and **Row Hover** (`#2A2D2E` / `#F0F0F0`, `:44`): row, chip, icon-button and rail states.

### Status
- **Git Added** `#6BD18F`, **Git Modified** `#E8BD78`, **Git Deleted** `#D95440` (`GitStatusBadge.swift:36-40`, as `Color(red:green:blue:)`). Reused for notice kinds: success = added, error = deleted (`PaneNoticeStyle.swift:25-27`).
- **Orange** (system): warning notices (`PaneNoticeStyle.swift:26`) and tool confirmation (`ConfirmSheet.swift` card icon and badge).
- System **red** / **green** / **purple** / **blue** appear for errors, success checks, plan approval and links in view code (counts: red 19, purple 13, green 12, blue 7).

### Syntax and file-type colors
- **Syntax palette**: ~25 literal `NSColor(red:green:blue:)` pairs, a dark and a light value per tree-sitter capture (`SyntaxHighlighter.swift:318-412`): e.g. keyword purple `(0.78,0.50,0.85)` dark / `(0.55,0.18,0.65)` light, string green, number orange, function blue, type cyan, comment grey-blue `(0.42,0.51,0.55)`. Independent of `MarvinTheme`.
- **File-type tints**: literal brand-style colors per language (`FileTypeIcons.swift:132-148`, e.g. Swift orange, TS blue, Go cyan).

### Tint ladder
Semantic fills are made by opacity over a color, not by separate tokens. Most used: `0.08` (22×), `0.18` (21×), `0.06` (17×), `0.15` (11×), `0.12` (8×). Chips use `0.15` rest / `0.24` hover / `0.32` pressed with a `0.28`/`0.45` stroke (`InlineActionChip.swift:104-119`); notices use `0.08` (`PaneNoticeStrip.swift:66`); section count capsules use `0.18` (`PaneSectionHeader.swift:42`).

### Named Rules
**The Hairline Rule.** Regions are separated by a 0.5–1 pt `MarvinTheme.border`, not by fill contrast. Surfaces stay within one or two greys of each other.
**The One Accent Rule.** The only chromatic brand color is the system accent, and at most one accent-filled (primary) chip appears per group (`InlineActionChip.swift:37-39`).
**The Outcome Color Rule.** Green, orange and red mean outcome (merge/sync/discard, added/warning/deleted) and are paired with a distinct glyph, because "a red word among tinted status text is just another tinted word" (`PaneNoticeStyle.swift:3-7`).

## Typography

**Interface Font:** SF Pro (system, via `.font(.system(size:))` and SwiftUI text styles).
**Mono Font:** SF Mono (system monospaced): `design: .monospaced` 135×, `.monospaced()` 152×, `NSFont.monospacedSystemFont` in the editor.

**Character:** A small, tight system-font interface that reaches for monospace whenever the content is machine-flavored (tool names, role labels, paths, notice detail), so the transcript reads as a log of actions rather than a chat app.

Two scales coexist (see inconsistencies): fixed-point sizes dominate pane chrome, text styles dominate the transcript.

### Hierarchy
- **Pane title** (semibold 11, +0.4 tracking, uppercase, muted; `PaneHeader.swift:41-47`): title row of every left pane; 12 semibold, primary color, not uppercased when the title is the project name.
- **Section header** (semibold 9.5, +0.4 tracking, uppercase, muted; `PaneSectionHeader.swift:31-36`) with a monospaced-digit 9.5 count capsule.
- **Chip label** (medium 10.5, compact 10; `InlineActionChip.swift:58`).
- **Notice** (10.5 regular; detail 9.5 monospaced, 3-line limit; `PaneNoticeStrip.swift:36-46`).
- **Empty state** (headline medium 11.5 muted, hint 10.5 tertiary, symbol 20 light; `PaneStateViews.swift:23-36`).
- **Chat body** (`.body`, `ChatMessageRow.swift:232,244`); code spans `.body.monospaced()` (`:293`).
- **Transcript meta** (`.caption.monospaced()` for role gutter, tool rows, streaming label; `ChatMessageRow.swift:72,131`); user label `.caption2.monospaced()` tracked 2, uppercase (`:101-103`).
- **Editor** (SF Mono 12 regular, `FileViewerView.swift:417-420`); chat input uses `NSFont.systemFontSize` (`ChatInputView.swift:89`).
- **Markdown headings** are relative to the body size: `body+4` bold, `body+2` bold, `body` semibold, `body-1` semibold (`MarkdownView.swift:246-249`).

Most-used fixed sizes (count of `.system(size:)`): 10 (121), 11 (113), 9 (58), 12 (52), 9.5 (33), 8 (22), 10.5 (20), 13 (18). Semantic styles: `.caption` 199, `.caption2` 86, `.callout` 46, `.body` 32, `.headline` 30.

### Named Rules
**The Mono-For-Machines Rule.** Tool names, paths, role labels, counts and diagnostics set in SF Mono; prose in SF Pro.
**The Uppercase-Chrome Rule.** Pane and section titles are uppercase, tracked +0.4, muted. A user-supplied name (the project) is never uppercased (`PaneHeader.swift:26-29`).

## Layout

An IDE shell: a fixed **44 pt activity rail** (`LeftPane.swift:376-377`) on the left, a resizable sidebar (ideal 260, min 45 so the rail survives collapse; `ContentView.swift:230`), content/chat area (min 320; `ContentView.swift:234,247`), and a **22 pt status bar** (`AppStatusBar.swift:73`). The main window defaults to 1280×820 (`MARVINApp.swift:773`); the shell window has min 960 / ideal 1440 (`MARVINApp.swift:540-541`). A separate window uses `.hiddenTitleBar` (`MARVINApp.swift:759`).

All seven left panes stay mounted together, so a pane must never declare an intrinsic width: panes `minWidth: 0` and clip, and `PaneEmptyView` caps its prose column at 260 (`PaneHeader.swift:9-16`, `PaneStateViews.swift:47`, ADR-0114).

The pane header is 38 pt (`MarvinTheme.paneHeaderHeight`, `:57`) so the rail's first icon centers on it. Rows are `3 × 10` pt padded (`PaneRow.swift:22-23`). Transcript rows have a 56 pt role gutter + 10 pt gap for non-user messages and a right-aligned bubble with a 40 pt minimum leading space for user messages (`ChatMessageRow.swift:55,60-62`).

**Spacing is not tokenized.** Observed padding values, by count: 12 (95), 8 (80), 6 (65), 4 (55), 10 (54), 2 (44), 5 (40), 1 (36), 14 (30), 16 (25). Observed stack spacing: 6 (119), 8 (110), 0 (86), 4 (72), 2 (46), 10 (42). Treat 2/4/6/8/10/12/16 as the working rhythm, with 1/3/5/14 as one-offs.

Density: small controls by default (`.controlSize(.small)` 90×, `.mini` 10×, `.large` 5×).

## Elevation & Depth

Flat and tonal. Depth comes from the three-step surface ladder (chrome → content → inset) and from hairlines; there is no shadow vocabulary. Exactly one shadow exists in the views: the slash-command popup (`.shadow(color: .black.opacity(0.18), radius: 12, y: 4)`, `SlashCommandPopup.swift:226`). Exactly one SwiftUI material exists: `.thinMaterial` on an image-preview overlay (`FileViewerView.swift:1735`). The hover tooltip is an AppKit panel filled with the inset color (`HoverTooltip.swift:127`).

Interaction state is a fill change, not elevation: rest → `row-hover` → `row-selected`/pressed, plus a 0.97 (chip) or 0.94 (icon button) scale that is dropped under Reduce Motion (`InlineActionChip.swift:78`, `PaneControls.swift:35`).

Motion: one shared `easeOut(0.18)` (`MarvinTheme.transition`, `:50`) for pane and tab transitions; `snappy(0.14–0.16, extraBounce: 0)` for press/hover on controls ("a button is not a thrown object", `InlineActionChip.swift:22-24`). Notice transitions use opacity only, because a height transition re-lays out a mounted pane (`PaneNoticeStrip.swift:15-16`).

### Named Rules
**The Flat-By-Default Rule.** Nothing casts a shadow at rest. A shadow or material is an exception that needs a reason.
**The No-Overshoot Rule.** Control animation is critically damped (`extraBounce: 0`); nothing bounces.

## Shapes

Continuous (squircle) corners (`style: .continuous`) on the shared components. A three-step radius scale was introduced by ADR-0114 (`MarvinTheme.Radius`, `:66-73`): **badge 3** (count capsules, pills), **chip 5** (buttons, chips, rows, anything a pointer targets), **card 6** (notices, grouped blocks, anything holding a paragraph). The user bubble uses **12** (`ChatMessageRow.swift:118`). Capsules are used for section counts (`PaneSectionHeader.swift:42`).

Borders are hairlines: 0.5 pt on chips, 1 pt on the user bubble and cards (`lineWidth` 1: 16×, 0.5: 15×). The split-view divider is a 1 pt line in the hairline color; the AppKit hit area is 5 pt (`SplitDividerTheme.swift:14-24`). Color swatches in the editor are rounded squares with a hairline (`ColorSwatchAttachment.swift:57-58`).

Icons are SF Symbols (83 distinct `systemName`s; most used: `xmark` 15, `xmark.circle.fill` 9, `exclamationmark.triangle.fill` 9, `arrow.clockwise` 8, `chevron.down` 6). File and folder icons come from a vendored third-party icon theme (**Symbols**, Miguel Solorio, MIT; `SymbolsIconMap.swift:1-13`, SVGs under `Resources/Symbols/`), a generated map of 72 folder icons plus file icons keyed by extension. Notice glyphs are fixed: `info.circle`, `checkmark.circle.fill`, `exclamationmark.triangle.fill`, `xmark.octagon.fill` (`PaneNoticeStyle.swift:12-20`).

## Components

### Buttons and chips
- **Chip** (`InlineChipStyle`, `InlineActionChip.swift:46-121`): the one way an inline action reads as an action. Radius 5, 0.5 pt stroke, label medium 10.5 (compact 10), padding 8×3 (compact 7×2.5), `lineLimit(1)` and `fixedSize` so it clips rather than wraps.
- **Roles**: `primary` (accent text, accent-tinted fill 0.15/0.24/0.32, at most one per group), `neutral` (inset fill, hairline stroke, primary text; hover → row-hover, pressed → row-selected), `tinted(Color)` (green to merge, orange to sync, red to discard).
- **Icon button** (`paneIconButton`, `PaneControls.swift:19-48`): size + 8 square, muted glyph at medium weight, radius 5, hover → row-hover, pressed → row-selected, 0.94 scale.
- **Enable toggle** (`PaneEnableToggle`, `:59-71`): a real `Toggle` with `.switch` style and `.mini` size, used for Skills and Plugins. Chosen over a tinted glyph because enabling a plugin loads MCP servers.
- Native styles also appear throughout: `buttonStyle` `.plain` 74×, `.borderless` 36×, `.borderedProminent` 25×, `.bordered` 15×, `.link` 6×.

### Left-pane rows and headers
- **Pane header** (`PaneHeader.swift`): 38 pt, optional 11 pt medium symbol, uppercase 11 semibold title, optional 10.5 tertiary subtitle (middle truncation), trailing actions keep their size while the title yields.
- **Section header** (`PaneSectionHeader.swift`): 9.5 uppercase, optional chevron (8 pt, collapsible), count in a tinted capsule that only shows when the count is worth showing.
- **Row** (`paneRow`, `PaneRow.swift`): modifier, not a container: padding 3×10, radius 5, selected/hover fills; the caller owns hover state.
- **Notice strip** (`PaneNoticeStrip.swift`): glyph + headline 10.5 (+ optional 9.5 mono detail), at most one verb chip ("Retry"/"Undo"), dismiss `xmark`; fill is the kind's tint at 0.08 (none for info); radius 6. Detail is deliberately not selectable (ADR-0062).
- **Empty / loading** (`PaneStateViews.swift`): centered column capped at 260, symbol 20 light in `.quaternary`, headline + hint, optional neutral chip; loading is a 0.6-scaled small `ProgressView` with 11 tertiary text.

### Navigation
- **Activity rail** (`LeftPane.swift:363-424`): 44 pt wide, 34 pt tall buttons, 15 pt medium SF Symbol; muted at rest, primary on hover/selected; selected shows `row-selected` fill and a 2 pt accent leading bar. A custom AppKit hit layer supplies the tooltip, because SwiftUI `.help` "never surfaced" there (comments on `ActivityBarButton` / `TooltipHitLayer` in `LeftPane.swift`; `HoverTooltip.swift`).
- **Dividers**: `MarvinDivider` (`MarvinTheme.swift:113-117`), a `Divider()` overlaid with the hairline color so it stays orientation-aware.

### Chat transcript
- **User message**: right-aligned bubble, inset fill, 1 pt hairline stroke, radius 12, padding 12×8, tracked uppercase mono "you" label in the accent at 0.8 opacity. Neutral rather than accent-tinted because background-job reports arrive as user messages and rendered as "a large navy block" (`ChatMessageRow.swift:113-124`).
- **Assistant / system / result**: no bubble; a 56 pt mono role gutter colored by role (assistant → primary, system → muted, result → muted at 0.7).
- **Tool call block** (`ChatMessageRow.swift:338+`): radius 6 container, mono caption name badge (radius 4, tinted), input/output in mono caption, errors in red 0.85.
- **Confirm card** (`ConfirmSheet.swift:390+`): in the tray above the input (ADR-0112), shield glyph in orange (purple for plan approval), mono tool badge on `orange.opacity(0.16)`, `Deny` (small) and `Allow` (small, `.borderedProminent`).

### Editor and markdown
- Editable STTextView with a line-number ruler and tree-sitter highlighting (`FileViewerView.swift:341+`), SF Mono 12; inline hex-color swatches drawn as an attribute, not inserted text (`ColorSwatchAttachment.swift:12-20`); diagnostics underline in a dotted line using the git deleted/modified RGB (`FileViewerView.swift:876-877`).
- `MarkdownView` renders prose through `NSTextView` (`RichText`), tables, code blocks and quotes; heading sizes are relative to the body size (`MarkdownView.swift:246-249`).

## Do's and Don'ts

### Do:
- **Do** use `MarvinTheme` colors (`background`, `panel`, `elevated`, `border`, `textPrimary`, `textMuted`, `rowHover`, `rowSelected`) for shell surfaces and text, so appearance switching stays consistent.
- **Do** separate regions with `MarvinDivider` / `MarvinTheme.border`, not with a darker fill.
- **Do** build left-pane UI from the ADR-0114 vocabulary (`PaneHeader`, `PaneSectionHeader`, `paneRow`, `chip`/`rowChip`, `paneIconButton`, `PaneNoticeStrip`, `PaneEmptyView`).
- **Do** pick corner radii from `MarvinTheme.Radius` (3 / 5 / 6).
- **Do** give every status color a glyph, and keep at most one accent-filled chip per group.
- **Do** keep a pane's intrinsic width at zero (`minWidth: 0`, `Spacer(minLength: 0)`, clip) because all seven panes stay mounted.
- **Do** honor Reduce Motion by dropping scale effects (already done in chip and icon button).
- **Do** set machine-flavored text (tool names, paths, counts) in SF Mono.

### Don't:
- **Don't** make a primary action look like text: a plain tinted button strips every control cue (`InlineActionChip.swift:4-10`).
- **Don't** add a height transition inside a pane slot, or `.textSelection` on a `ScrollView`-rooted left-pane view: both have crashed or oscillated layout (`PaneNoticeStrip.swift:11-16`, ADR-0062).
- **Don't** make a pane header `.focusable()`: macOS draws a focus ring around the whole pane (`PaneHeader.swift:18-19`).
- **Don't** tint the user bubble with the accent: injected background-job reports are user messages (`ChatMessageRow.swift:113-116`).
- **Don't** use a bare `Spacer()` in a header row; it contributes intrinsic width (`PaneHeader.swift:14-16`).
- **Don't** introduce shadows or materials without a reason; the system has one of each.

## Observed inconsistencies (recorded, not fixed)

All measured from source; none verified against renders.

1. **Radius scale is barely adopted.** `MarvinTheme.Radius` is referenced 5 times (`chip` 4, `card` 1), while literal `cornerRadius:` values appear ~120 times: 6 (48), 5 (17), 4 (17), 8 (13), 3 (10), 7 (5), 2 (5), 12 (2), 10 (1). Values 2, 4, 7, 8 and 10 are outside the 3/5/6 scale. `InlineActionChip.swift` hardcodes `5` three times (`:69,73,80`) instead of using `Radius.chip`; the hover tooltip hardcodes `5` (`HoverTooltip.swift:130`).
2. **Two type systems.** ~450 fixed `.system(size:)` calls (half-point sizes 9.5, 10.5, 11.5 included) coexist with ~400 semantic text-style calls (`.caption`, `.caption2`, `.callout`, `.body`, `.headline`). Pane chrome is fixed-size; the transcript is style-based. The PRODUCT.md macOS block says "system text styles at macOS sizes"; the chrome does not follow it.
3. **Two greys.** Text hierarchy uses system `.secondary` (260×) and `.tertiary` (226×) far more than `MarvinTheme.textMuted` (34×) and `textPrimary` (28×). `MarvinTheme` says its palette is "fixed per appearance rather than derived from the system" (`MarvinTheme.swift:5-8`), but most secondary text derives from the system.
4. **Hardcoded color literals outside the theme.** Git colors are defined once (`GitStatusBadge.swift:36-40`) but the same RGB values are re-typed in `FileViewerView.swift:876-877`; `FileTreeView.swift:808` uses `Color(white: 0.72)`; `FileTypeIcons.swift:132-148` and `SyntaxHighlighter.swift:318-412` carry ~40 literal colors with no link to `MarvinTheme`. Syntax colors are not shared with git/status colors and do not track the grey ladder.
5. **Content surface under-used.** `MarvinTheme.panel` (the editor/chat fill) has 4 references versus `background` 16 and `elevated` 26.
6. **No spacing or stroke tokens.** ~12 distinct padding values, with near-duplicates (5/6, 3/4, 10/12, 14/16); stroke widths 0.5 and 1 are chosen per view; opacity tints have six near-equal levels (0.06, 0.08, 0.12, 0.14, 0.15, 0.18).
7. **Divider drift.** `MarvinDivider` is used 108×, but ~42 raw `Divider()` calls remain; the comment on `MarvinDivider` records that a raw `Divider()` paints a lighter system separator (`MarvinTheme.swift:101-107`).
8. **Button vocabulary is mixed.** Chips (`.chip`/`.rowChip`) are used 30×, `paneIconButton` 8×, against 74 `.plain`, 36 `.borderless` and 25 `.borderedProminent` buttons. ADR-0114's comments say plain tinted text buttons were the original bug; the pane vocabulary has not reached everywhere.
9. **Two tooltip mechanisms.** The rail uses a custom AppKit `TooltipHitLayer` because `.help()` did not surface; `.help(` is used 171 times elsewhere.
10. **Two file-icon systems described.** `FileTypeIcons.swift:1-20` says "SF Symbols only … bundled icon sets would bloat the .app", while `SymbolsIconMap.swift` vendors the Symbols icon theme and says it replaced an earlier Seti port. I did not trace which one each tree/tab call site renders; the header comment is likely stale.
11. **Accent is the user's, not the brand's.** No app accent asset was found; `.accentColor` follows System Settings. The primary chip, active rail bar and "you" label therefore change color per user; the brand has no fixed chromatic identity.
12. **Window chrome differs.** One window uses `.windowStyle(.titleBar)` (`MARVINApp.swift:551`), another `.hiddenTitleBar` (`MARVINApp.swift:759`). Not necessarily a defect; recorded because a render check should confirm they read as one app.

## Not yet verified (for the render pass)

- Whether the light-mode greys (`#F3F3F3` / `#FFFFFF` / `#F7F7F7`) separate as intended; the dark pair was tuned against Antigravity and the light pair has no stated reference.
- Contrast of `text-muted` on `chrome` and `inset` in both appearances, and under Increase Contrast.
- Whether `.secondary`/`.tertiary` text reads against the fixed greys.
- How the pane chrome behaves at the narrowest sidebar width (the pane widths used by the snapshot harness are 260 and 420).
- Anything about the Brain/graph pane (Metal) and the terminal (SwiftTerm), which were not read here.

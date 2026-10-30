# Audit: MARVIN native macOS app (`macos/MARVIN`)

> **Source-only audit. No renders, no build, no running app.** Method: Impeccable `audit.native.md`, scored against `ios.md` as overridden by PRODUCT.md's *macOS translation* block and against DESIGN.md. Hex values and token names come from DESIGN.md; **contrast ratios are computed from those token values (WCAG 2.x formula), not measured on screen**, and system `.secondary`/`.tertiary` values are estimates (see "Contrast").
>
> **How findings were gathered.** Four read-only scouts read the source in parallel by surface (chat; window chrome; left panes; work surfaces), none of which had a shell, so their counts are hand tallies. The app-wide counts and the contrast table were produced by me with grep and a script. Each finding below is tagged **V** (I re-read the cited lines in this tab and the claim holds) or **S** (reported by a scout from the cited lines; not re-read by me). Where a scout flagged a claim as unverified, it is marked *unverified* in the row. Severity was re-calibrated by me; changes from the scouts' ratings are listed under "Severity changes".
>
> macOS reading of the checks: keyboard and VoiceOver instead of touch/Dynamic Type; window resizing, pane collapse and tiling instead of size classes; no touch-target rule (a ~20 pt pointer minimum is used as a floor); no safe areas.

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | **1** | VoiceOver API is nearly absent (5 `accessibilityLabel`, 0 hint, 0 value in 50,623 lines); many controls are tap-only or hover-only; Reduce Motion honoured in 3 of 33 animation sites; git-status colours fail contrast in light mode. Keyboard coverage (66 `keyboardShortcut`s, one command registry) is the strong part. |
| 2 | Performance | **2** | Lists and transcript are mostly lazy, rows are `Equatable`, history is windowed; but markdown/syntax parsing runs in `body`, the Source Control list is eagerly built, several pickers recompute O(n) per keystroke, and the Brain animates at 30 fps when idle. |
| 3 | Appearance & Theming | **2** | A real dynamic-colour token set exists (`MarvinTheme`) and both appearances ship, but it is adopted inconsistently: the editor picks the dark syntax palette when the system is light, status colours are single-value, ~118 literal radii, 40+ literal colours, sibling sheets use system greys. |
| 4 | Platform Conformance | **2** | Reads as a native Mac app (native controls, SF Symbols, native dialogs, one command registry feeding menu/palette/help), but three kinds of violation recur: hover-/tap-only controls, destructive actions that are the default or unconfirmed, and link/glyph-styled buttons. See verdict. |
| 5 | Adaptivity | **2** | Pane collapse and `minWidth: 0` discipline are deliberate and good; but the window minimum (960 pt) blocks half-screen tiling, fixed chrome heights exceed the declared 200 pt minimum, the composer and status bars have no overflow strategy, and Return commits mid-IME composition. |
| **Total** | | **9/20** | **Poor (6–9): major overhaul needed, concentrated in Accessibility** |

*Borderline note:* Platform Conformance is the closest call. A 3 would give 10/20 (Acceptable). It is scored 2 because the same non-native pattern (hover-only or tap-gesture controls with no keyboard or VoiceOver path) recurs on at least seven surfaces, and because four destructive actions lack a safe default or confirmation.

## Platform Conformance Verdict

**Pass with reservations: it reads as a native Mac app, not a ported website.**

What is genuinely native: system `Toggle`/`Picker`/`Form`/`confirmationDialog`/`NSTextFinder`/`Table`-style `List`, SF Symbols throughout (one deliberate exception: the vendored Symbols file-icon theme), a single `CommandRegistry` feeding the menu bar, ⇧⌘P palette and ⌘/ sheet, ⌘Q confirms while a turn is running, native context menus and Quick Look, split view with autosave.

Violations a fluent Mac user would notice:
1. **Hover-/tap-gesture-only controls** with no focus, trait or action: Source Control file rows (`SourceControlView.swift:1726,1739`), Files tree (`FileTreeView.swift:788,850`), Sessions rows (`SessionsPane.swift:441`), editor tabs (`FileViewerView.swift:1264`), slash popup (`SlashCommandPopup.swift:192`), image previews (`ChatMessageRow.swift:283`), cost chart (`ContentView.swift:885`).
2. **Destructive or escalating actions with the wrong default or no confirm**: Return = confirm on `danger` git sheets (`GitConfirmSheet.swift:160`), "Accept all" is the default next to an unconfirmed "Reject all" (`ReviewChangesView.swift:353-356`), one click raises posture auto→full auto (`ChatAgentsFooter.swift:189`), Reset deletes the stored key (`AuthSettingsSection.swift:99`), Stop on background jobs (`ActivityPopover.swift`).
3. **Web-shaped affordances**: a text glyph `"▸"` as the tool-card disclosure (`ChatMessageRow.swift:395`), `.buttonStyle(.link)` at 10 pt (`SessionModeChip.swift:136+`), a hand-rolled on/off pill (`TopBarPopovers.swift:121`), scroller style forced to overlay (`FileViewerView.swift:602`).
4. **Menu/keyboard convention drift**: Check for Updates and Keyboard Shortcuts sit in the Window menu (`MARVINApp.swift:708-711`), ⌘/ is Keyboard Shortcuts where editors use it for Toggle Comment (`CommandRegistry.swift:191,431`), F-key shortcuts are printed but not bound (`MARVINApp.swift:227-232`).

## Executive Summary

- **Audit Health Score: 9/20 (Poor).**
- **Issues: 0 P0, 23 P1, 76 P2, 5 P3 (104 total)**; per-surface counts at the end of this file are computed from the tables.
- **Top issues:** (1) no VoiceOver layer; (2) hover-/tap-only controls; (3) git-status colours unreadable in light mode; (4) editor/Brain choose the dark palette on a light system; (5) irreversible actions one click or one Return away.
- **No P0.** The scouts' single P0 (Source Control per-file actions hover-only) is rated P1 here: "Stage all / Unstage all / Discard all" are real buttons, so the keyboard user can still complete the task in bulk (see "Severity changes").
- **Next steps:** `/impeccable harden` for the accessibility and destructive-action findings first, `/impeccable colorize` for light-mode status colours and the dark-by-default palette, `/impeccable optimize` for body-time parsing, then `/impeccable adapt` and `/impeccable typeset`, ending with `/impeccable polish`.

## Systemic patterns

| # | Pattern | Evidence (app-wide) |
|---|---------|---------------------|
| S1 | **No VoiceOver layer.** Labels exist where a control is *named* (`.help` 171×, SF Symbol auto-labels) but state, value, selection, grouping and announcements are absent. | `accessibilityLabel` 5 (`SkeletonRows.swift:31`, `ChatMessageRow.swift:290`, `FindInFilesView.swift:291`, `LeftPane.swift:436`, `TodoListView.swift:248`); `accessibilityHint` 0; `accessibilityValue` 0; `accessibilityElement` 1; `accessibilityAddTraits` 2; `accessibilityReduceTransparency` 0; `colorSchemeContrast` 0. 100+ files over 150 lines have none. |
| S2 | **Pointer-only controls.** `onTapGesture`/`onHover`/`DragGesture` carry the action with no button trait, focus, or accessibility action. | Rows and tabs listed in the verdict; resize handles `ChatInputView.swift:713-749`, `TodoListView.swift:206-249`, `LeftPane.swift:116-128`, `SourceControlView.swift:1511`. |
| S3 | **Small hit areas on frequent controls.** 8–15 pt glyph buttons with no padded `contentShape`. | `xmark` 8 pt (`TerminalPaneView.swift:84`, `ChatPreviewView.swift:3073`), 14×14 (`PaneNoticeStrip.swift:55`), 15×15 (`SourceControlView.swift:1774`), 11 pt status-bar glyphs (`AppStatusBar.swift:617`). |
| S4 | **Small, faint information text.** 8–10.5 pt in `.tertiary` carries real information (failure detail, paths, line:col, file kind). | `PaneNoticeStrip.swift:42`, `DiagnosticsPanelView.swift:320`, `ProjectToolsPanel.swift:396`, `TerminalPaneView.swift:109`. |
| S5 | **Reduce Motion.** 33 animation sites (19 `withAnimation`, 7 `.animation(`, 7 `.transition(`); honoured in `PaneControls.swift:35`, `InlineActionChip.swift:78`, and the Brain frame rate (`BrainMetalView.swift:264`, which only slows it). | Rated P2: the unguarded animations are small fades/expands. |
| S6 | **Work in `body`.** Parsing, highlighting, sorting, filtering and registry construction are recomputed per render. | `MarkdownView.swift:27,39,345`; `PlanCardView.swift:62`; `BacklogPanel.swift:105-129`; `DiagnosticsPanelView.swift:130,270,278`; `CommandRegistry.swift:84`; `QuickOpenSheet.swift:190`; `FileViewerView.swift:1447`. |
| S7 | **`GeometryReader` against the repo's own rule** (use `onGeometryChange`). 8 code sites. | `FileViewerView.swift:1134,1143,1698`, `ChatPreviewView.swift:2756`, `ChatInputView.swift:611`, `ContentView.swift:977`, `ContextDetailPopover.swift:106`, `LeftPane.swift:201`. (`onGeometryChange` is used 9×.) |
| S8 | **Token adoption** (from DESIGN.md observations, restated with the user-visible effect): radius tokens 5 uses vs ~118 literals; two grey systems; single-value status colours. | See Theming findings. |

## Contrast (computed from DESIGN.md token values, WCAG 2.x)

Text on the shell surfaces (ratio; 4.5 is the normal-text AA bar, 3 for large/UI):

| Text | chrome | content | inset | row-hover | row-selected |
|------|--------|---------|-------|-----------|--------------|
| dark `text-primary` #D4D4D4 | 11.98 | 11.12 | 10.21 | 9.36 | 7.98 |
| dark `text-muted` #9D9D9D | 6.55 | 6.08 | 5.58 | 5.12 | **4.36** |
| light `text-primary` #1F1F1F | 14.85 | 16.48 | 15.39 | 14.46 | 13.26 |
| light `text-muted` #6E6E6E | 4.60 | 5.10 | 4.76 | **4.47** | **4.10** |

Status colours as text (single value in both appearances):

| Colour | on dark content | on light content |
|--------|-----------------|------------------|
| git added #6BD18F | 8.75 | **1.88** |
| git modified #E8BD78 | 9.40 | **1.75** |
| git deleted #D95440 | 4.15 | **3.97** |
| system blue 007AFF (typical accent) | 4.10 | 4.02 |

Structure: hairline #2B2B2B vs chrome 1.25 / content 1.16 (dark); #E5E5E5 vs chrome 1.14 / content 1.26 (light). Chrome→content surface step is 1.08 (dark) and 1.11 (light): regions separate by hairline only, which is by design but disappears under Increase Contrast (no `colorSchemeContrast` handling anywhere).

*Estimates:* system `.tertiary` approximated as 25% label alpha gives ~2.3:1 on dark chrome and ~1.9:1 on light chrome; `.secondary` as 50–55% gives ~6.1 dark / ~3.9 light. The real system values vary, so treat any `.tertiary`/`.secondary` finding as *likely*, not measured. Only light-mode muted text (4.10–4.60) and the git colours are conclusive from the tokens alone.

## Detailed findings by surface

Columns: **ID**, **Sev**, finding, **location**, dimension (A11y / Perf / Theme / Conf / Adapt), suggested command, **V/S**.

### Chat transcript, composer, tray, sheets

| ID | Sev | Finding and impact | Location | Dim | Command | V/S |
|----|-----|--------------------|----------|-----|---------|-----|
| C1 | P1 | **Return submits while an IME is composing.** `keyDown` calls `onSubmit` before `super.keyDown`; `hasMarkedText()` is never checked. CJK users confirming a composition send a half-typed message, though the file header claims IME handling. | `ChatInputView.swift:247-250` | Adapt | harden | V |
| C2 | P1 | **One click on the posture pill escalates auto → full auto**, waiving the containment confirms; no confirmation, posture shown by a 6 pt dot and a label. (`next` cycles gated→auto→full→gated.) | `ChatAgentsFooter.swift:189-191`; `MARVINLogic/PermissionStrategyChoice.swift:44-49` | Conf | harden | V |
| C3 | P1 | **A pending tool confirm, errors and tray changes are never announced to VoiceOver**; the confirm card has no grouping or label. A blocked turn waits silently. | `ChatPreviewView.swift:3622-3627`; `ConfirmSheet.swift:399-421` | A11y | harden | S |
| C4 | P1 | **Tool-call expand control is the text glyph `"▸"`/`"▾"`** in a borderless button (~10 pt), no state announced; the rest of the header is not clickable. Same for `show all (N chars)`. | `ChatMessageRow.swift:395`, `:592` | A11y | harden | S |
| C5 | P1 | **AskUserQuestion options have no selection semantics**: radio/checkbox state is an SF Symbol plus tint; no selected trait or grouping. It is the only way to answer the model. | `AskQuestionSheet.swift:150-183`, `:189` | A11y | harden | S |
| C6 | P1 | **Composer + strips can exceed the window height.** Declared min height 200, but editor height (default 120, max 600), plan strip (default 132, max 520) and a 140 pt transcript minimum are persisted fixed sizes. | `ChatPreviewView.swift:2341,2287`; `ChatInputView.swift:439,576,742`; `TodoListView.swift:55,62,191` | Adapt | adapt | S |
| C7 | P2 | Composer action row (3 `.fixedSize()` menus + Stop, Stop All, Send) likely needs ≥ ~500 pt; pane minimum is 280. *Unverified, arithmetic from fixed sizes.* | `ChatInputView.swift:655-703`; `ChatModeToolbar.swift:62,140,191` | Adapt | adapt | S |
| C8 | P2 | Allow is `.defaultAction` and the composer Send is `.keyboardShortcut(.return)`; while a confirm is pending a stray Return may approve (the text view consumes Return itself when focused, so risk is when focus is elsewhere). Esc is global too. | `ConfirmSheet.swift:420,416`; `ChatInputView.swift:699` | Conf | harden | V |
| C9 | P2 | **"Deny" does not deny on first click**: it opens an unfocused reason field; denial takes two steps. | `ConfirmSheet.swift:412-414` | Conf | clarify | V |
| C10 | P2 | Tray rows are index-keyed `AnyView`; inserting a row shifts identity, so `ConfirmCard`'s `denyOpen`/`denyMessage` and the plan strip's `collapsed` state bleed between rows. | `ChatPreviewView.swift:3603,3618`; `ConfirmSheet.swift:394-395` | Perf | harden | S |
| C11 | P2 | Slash-command popup rows are tap-only with no selected trait; opening/selection never announced. | `SlashCommandPopup.swift:192-196,258` | A11y | harden | S |
| C12 | P2 | "Revise" overwrites the unsent draft (`model.draft = "Revise the plan — "`) and does not focus the composer. | `ChatPreviewView.swift:3487` | Conf | harden | S |
| C13 | P2 | A failed "Park to backlog" (`_ = try? await URLSession...`) is still marked handled and greyed. | `ChatPreviewView.swift:4182-4184` | Conf | harden | S |
| C14 | P2 | Every notice is titled "Stream error" (incl. "Stopped:…"); error toasts auto-dismiss after 8 s. | `ChatPreviewView.swift:4382,2237,2295` | Conf | clarify | S |
| C15 | P2 | Frequent icon-only controls ≤ 14 pt and unlabelled: tab close (`xmark` 8 pt in 14×14), chip remove, plan chevron, `+` new tab, queue remove, paperclip; active tab has no `.isSelected`. | `ChatPreviewView.swift:3073-3081,3018-3099,2810`; `ChatAttachments.swift:201-208,269-283`; `TodoListView.swift:98-104` | A11y | polish | S |
| C16 | P2 | Resize handles and image previews are pointer-only; the plan-strip grip has a VoiceOver label but no adjustable action. | `ChatInputView.swift:713-749`; `TodoListView.swift:206-249`; `ChatMessageRow.swift:283` | A11y | harden | S |
| C17 | P2 | Literal colours: white 9 pt on orange capsule, `Color.black.opacity(0.18)`, `.green` body text in the confirm diff; weak on light, no Increase Contrast. | `ChatPreviewView.swift:3058-3059`; `ConfirmSheet.swift:286,300-304,326-327` | Theme | colorize | S |
| C18 | P2 | Syntax highlighting runs in `body` and bakes the appearance into colours (reads `NSApp.effectiveAppearance` at render). | `MarkdownView.swift:345-361` | Perf/Theme | optimize | S |
| C19 | P2 | Markdown blocks and plan lines re-parse on every body pass (every streamed token). | `MarkdownView.swift:27,39`; `PlanCardView.swift:62,75,86` | Perf | optimize | S |
| C20 | P2 | Tab strip: `GeometryReader`, per-tab title lookups that grow quadratically, formatters constructed per call. | `ChatPreviewView.swift:2756,3098,3183,3225-3229` | Perf | optimize | S |
| C21 | P2 | Two uncancelled `/api/commands` requests per keystroke after `/`. | `ChatInputView.swift:534,587-589`; `SlashCommandPopup.swift:89` | Perf | optimize | S |
| C22 | P2 | File-mention picker keeps a stale selection when the query changes and re-filters the tree ~3× per keystroke; no scroll-to-selection. | `ChatAttachments.swift:313,340,348,418` | Conf/Perf | harden | S |
| C23 | P2 | Scope-met chip "Save session note" gives no feedback; "Start fresh next turn" creates a tab immediately; three bordered buttons in one HStack won't fit narrow. | `ChatPreviewView.swift:3858-3894` | Conf | clarify | S |
| C24 | P2 | Meta text 8–10 pt in `.tertiary` (brain/chevron glyphs, sub-tasks, code at caption size, footers). | `ChatMessageRow.swift:641-649`; `TodoListView.swift:262`; `MarkdownView.swift:326`; `ChatAgentsFooter.swift:111`; `SessionModeChip.swift:285` | A11y | typeset | S |
| C25 | P2 | `AskQuestion`/`AskOption` mint `UUID()` ids per parse, re-parsed on every keystroke; row identity and `Equatable` never hold. | `AskQuestionSheet.swift:21,28,79` | Perf | optimize | S |
| C26 | P2 | `NotificationCenter.addObserver` in `.onAppear` with no removal; the file's own comments say the split view rebuilds many times, so observers duplicate. | `ChatPreviewView.swift:2384-2420` | Perf | harden | S |
| C27 | P3 | `.help` applied twice to the `+` button (second wins). | `ChatPreviewView.swift:2819,2825` | Conf | polish | S |

### Window chrome: toolbar, status bar, popovers, sheets, menus, settings

| ID | Sev | Finding and impact | Location | Dim | Command | V/S |
|----|-----|--------------------|----------|-----|---------|-----|
| W1 | P1 | **Selection in Quick Open, Go to Symbol and Run Task is invisible and not scrolled into view.** Return acts on `selection ?? filtered.first` with no highlight until the first arrow press; the lists lack a `ScrollViewReader` (the palette has one). In Run Task, Return runs a shell command. | `QuickOpenSheet.swift:158,37,214-222`; `BuildTaskSheet.swift:86,148`; `SymbolSearchSheet.swift:130,222` (compare `CommandPaletteSheet.swift:64`) | A11y | harden | V (158) / S |
| W2 | P1 | **Return is the default action on `danger` git confirms** (discard, force-push). macOS convention is Cancel as default for destructive sheets. | `GitConfirmSheet.swift:160-161` | Conf | harden | V |
| W3 | P1 | First-run install command (`brew install claude-code && claude login`) cannot be selected or copied; `UpdatePromptView.swift:41-53` solves the same case. | `OnboardingView.swift:265` | Conf | harden | S |
| W4 | P2 | ModelsDialog pickers have an empty accessible name (`Picker("", …).labelsHidden()`) for Executor, Advisor and every helper role. | `TopBarPopovers.swift:493,509` | A11y | harden | V |
| W5 | P2 | F8, ⇧F8, F12 are printed in the palette and ⌘/ sheet but never bound in the menu (`parse` returns nil for F-keys; code comment says SwiftUI has no `KeyEquivalent` for them). | `MARVINApp.swift:227-232`; `CommandRegistry.swift:323,344,349` | Conf | harden | V |
| W6 | P2 | Auth key field: Return does not save; "Reset to default" deletes the stored credential file immediately, no confirm. | `AuthSettingsSection.swift:72-79,99-101` | Conf | harden | V (99) / S |
| W7 | P2 | Status-bar controls hit-test on their 11–14 pt glyphs only (no `contentShape`/padding in a fixed 22 pt bar); bell unread state is a glyph swap and tooltip. | `AppStatusBar.swift:617-628,146-156,119-139,361-371,73` | A11y | harden | S |
| W8 | P2 | `ctx` and `graph/reads` state is colour-only, with `.tertiary` as the floor at 11 pt; the explanatory hint exists only in a tooltip. | `AppStatusBar.swift:451-458,512-519` | A11y | colorize | S |
| W9 | P2 | Status bar has no collapse/priority strategy; the right cluster can hold ~10 segments against a 960 pt minimum. *Unverified.* | `AppStatusBar.swift:67-71,335-355` | Adapt | adapt | S |
| W10 | P2 | Cost-history bars expose daily values only on pointer hover; bars are not accessibility elements. | `ContentView.swift:885-887,919` | A11y | harden | S |
| W11 | P2 | Chrome transitions ignore Reduce Motion. | `ContentView.swift:202,206,396,439,441` | A11y | animate | S |
| W12 | P2 | `GeometryReader` in the plan-usage bar and the context popover; neither bar exposes an accessibility value. | `ContentView.swift:977`; `ContextDetailPopover.swift:106` | Perf | optimize | V (sites) |
| W13 | P2 | Quick Open recomputes `filtered` (lowercases every path) 3×, builds `Set(allFiles)` per access; no debounce. | `QuickOpenSheet.swift:190-212,131-135,76` | Perf | optimize | S |
| W14 | P2 | Go to Symbol decodes `graph.json` inline on appear (likely main actor) and lowercases every node per render. *Unverified isolation.* | `SymbolSearchSheet.swift:92,193-206,261-262` | Perf | optimize | S |
| W15 | P2 | `CommandRegistry.all` is a computed property rebuilt (~70 commands + closures) per access, ≥ rows+4 times per palette render and per menu slot. | `CommandRegistry.swift:84,467`; `CommandPaletteSheet.swift:23-27,93` | Perf | optimize | S |
| W16 | P2 | Hand-rolled "on/off" pill instead of `Toggle`; **`SetupPopoverContent` and `ProjectPickerToolbarItem` are referenced nowhere outside the snapshot harness** (dead in the shipped UI; the picker's only other mention is a comment at `AppStatusBar.swift:162`). | `TopBarPopovers.swift:121,135-139,149`; `ProjectPickerToolbar.swift:13` | Conf | distill | V (dead refs) |
| W17 | P2 | Bottom-panel tab strip has no selected trait; the hide chevron is a 10 pt glyph with only `.help`. | `ContentView.swift:509-548` | A11y | harden | S |
| W18 | P2 | Palette rows: `contentShape` before padding and a clear background, so the row gaps likely don't click. | `CommandPaletteSheet.swift:119-122` | Conf | polish | S |
| W19 | P2 | QuickOpen, SymbolSearch, BuildTask, Shortcuts, Welcome, Onboarding and the bottom tab strip use system `.underPageBackgroundColor`/`.controlBackgroundColor`, not `MarvinTheme` (the palette uses `MarvinTheme.elevated`). | `QuickOpenSheet.swift:54,107`; `SymbolSearchSheet.swift:60,87`; `BuildTaskSheet.swift:36,71`; `ShortcutsHelpSheet.swift:98,117`; `WelcomeView.swift:23,30`; `ContentView.swift:552` | Theme | colorize | S |
| W20 | P2 | Tooltip panel resolves dynamic colours to `cgColor` once (stale after a theme toggle) and doesn't inherit a forced appearance; pointer-only. *Unverified.* | `HoverTooltip.swift:127-130` | Theme | colorize | S |
| W21 | P2 | Menu placement/shortcuts: Check for Updates and Keyboard Shortcuts live in the Window menu; ⌘/ = Keyboard Shortcuts, Toggle Comment = ⌘'. | `MARVINApp.swift:708-711,723`; `CommandRegistry.swift:191,431` | Conf | polish | S |
| W22 | P2 | Window minimum 960 pt (ContentView's own 480×320 minimum is overridden), so macOS half-screen tiling on a 1440 pt display (720 pt) is impossible; the three panes need ~685 pt. | `MARVINApp.swift:539-544`; `ContentView.swift:78,230,234,247` | Adapt | adapt | V |
| W23 | P2 | Main window found by title (`first(where: title != aboutTitle)`); Settings, Review Changes, status-item and tooltip windows aren't excluded. | `ContentView.swift:620`; `StatusBarController.swift:164-166,241` | Adapt | harden | S |
| W24 | P2 | Menu-bar status item has a tooltip but no accessibility label/value; busy state is an icon swap. | `StatusBarController.swift:79-90` | A11y | harden | S |
| W25 | P2 | Activity popover: unlabelled refresh icon; Stop cancels a job with no confirm; every failed fetch collapses to `[]` and renders "No background jobs running"; audit time is a sliced ISO string. | `ActivityPopover.swift:48-51,86-87,132,170-178` | A11y/Conf | clarify | V (170-178) / S |
| W26 | P3 | Developer copy "Swift native shell · Phase 1c" in About; fixed 540 pt height may clip (*unverified*); "UTF-8"/"LF" hard-coded in the status bar. | `AboutView.swift:38,109`; `AppStatusBar.swift:342-344` | Conf | clarify | S |

### Left panes and activity rail

| ID | Sev | Finding and impact | Location | Dim | Command | V/S |
|----|-----|--------------------|----------|-----|---------|-----|
| L1 | P1 | **Source Control per-file actions are hover-only and open-diff is tap-only.** Stage/unstage/discard buttons exist in the tree only while `hovering`; the row is not a Button; the context menu needs a right-click. Keyboard/VoiceOver users cannot act on a single file (bulk "Stage all" works). | `SourceControlView.swift:1726-1727,1739,1741` | A11y | harden | V |
| L2 | P1 | **Files tree has no keyboard navigation.** It is `.focusable()` with the focus effect disabled and handles only Space (Quick Look); no arrows/Return/←→; rows/chevrons are tap-gesture with no traits. | `FileTreeView.swift:269-271,788,850` (single `onKeyPress` at `:271`) | A11y | harden | V |
| L3 | P1 | **Activity rail is not in the key-view loop** (`acceptsFirstResponder` false) and has no selected trait; selection shows only as fill + accent bar. `LeftPane.swift` has no `keyboardShortcut`. *View-menu routes unverified.* | `LeftPane.swift:517,436-437,422-428` | A11y | harden | S |
| L4 | P1 | **Git-status colours as file-name text fail contrast in light mode** (added 1.88:1, modified 1.75:1, deleted 3.97:1 on #FFFFFF); one RGB for both appearances; also 11 pt status letters, session-chip text, and notice glyphs. | `FileTreeView.swift:808,987`; `SourceControlView.swift:1822`; `GitStatusBadge.swift:36-40`; `SessionsPane.swift:63,259,308` | Theme | colorize | V |
| L5 | P1 | **Source Control change list is not lazy**: `repoGroup` is one eager `VStack` child of the `LazyVStack`, so every changed file (the file header cites 477) is built as a stateful row and re-evaluated on each model change. | `SourceControlView.swift:839-840,870-882,1166` | Perf | optimize | V |
| L6 | P1 | **Replace All ignores "Whole word"** (substring/regex replace on the text, search used `wholeWord`), and the button stays enabled while a search is in flight, so stale results can rewrite identifiers on disk. | `FindInFilesView.swift:543-546,539-541,151` | Conf | harden | V |
| L7 | P1 | **Sessions inline Allow/Deny decides on a one-line, middle-truncated 9.5 pt excerpt**; full text only in a `.help` tooltip. | `SessionsPane.swift:499-510` | Conf | clarify | S |
| L8 | P1 | **Skills/Plugins enable switch has no accessible name** (`Toggle("", …).labelsHidden()`); enabling a plugin loads MCP servers into the tool surface. | `PaneControls.swift:65-68`; `PluginsPane.swift:234`; `SkillsPane.swift:1152` | A11y | harden | V |
| L9 | P2 | Per-row `NSWorkspace.urlsForApplications` is called inside `contextMenu` content. *Runtime cost unverified.* | `FileTreeView.swift:905-908` | Perf | optimize | S |
| L10 | P2 | Section-header Button wraps nested "Stage all / Discard all" buttons; no expanded value. *Merging unverified.* | `SourceControlView.swift:1152-1162,1187-1192` | A11y | harden | S |
| L11 | P2 | Branch picker's ↑/↓ moves `effectiveSelection` through a fixed 400 pt list with no `ScrollViewReader`; Return acts on an off-screen row. | `GitRefPicker.swift:105-111,222-230` | Conf | polish | S |
| L12 | P2 | "Discard branch" (unmerged commits) has no confirmation in this view. *`registry.discardKept` may confirm internally, unverified.* | `SessionsPane.swift:334` | Conf | harden | S |
| L13 | P2 | Icon-only pane buttons 14–19 pt, labelled only by `.help`/symbol name. | `PaneControls.swift:30`; `SourceControlView.swift:1774`; `PaneNoticeStrip.swift:55`; `FindInFilesView.swift:85`; `SessionsPane.swift:271-275` | A11y | harden | S |
| L14 | P2 | Failure detail and hints are `.tertiary` at 9.5–10.5 pt: the explanation of a failure is the faintest text in the strip. | `PaneNoticeStrip.swift:42-43`; `PaneHeader.swift:50-51`; `PaneStateViews.swift:33-34`; `SessionsPane.swift:423-424` | A11y | typeset | S |
| L15 | P2 | Neutral chip (the only "this is a button" cue): fill #262626 on #181818 is ~1.2:1 with a #2B2B2B stroke (computed); no Increase Contrast response. | `InlineActionChip.swift:108,117` | Theme | colorize | S |
| L16 | P2 | Draggable tool/graph heights clamp to fixed maxima (520/600), not to the pane; hover cursor push/pop is unbalanced if the divider disappears; no keyboard adjust. | `LeftPane.swift:116,128`; `SourceControlView.swift:1511` | Adapt | adapt | S |
| L17 | P2 | Source Control declares `.frame(minWidth: 200)`, contradicting the zero-intrinsic-width rule; clips below ~245 pt sidebar. | `SourceControlView.swift:646` | Adapt | adapt | S |
| L18 | P2 | Status-fetch banner `×` is inert (`{}`); raw Swift errors and "(no commits yet)" survive in GitRef/Graph/SC, using the old `banner()` not `PaneNoticeStrip`. | `SourceControlView.swift:1573,188`; `GitRefPicker.swift:61,216`; `GitGraphView.swift:228,230` | Conf | clarify | S |
| L19 | P2 | Skills actions hold spinners 3–4 s after completion (`Task.sleep(3_500_000_000)`) and swallow failures (toggle/park/unpark). | `SkillsPane.swift:636-637,603,1046,1113,1131` | Perf | optimize | S |
| L20 | P2 | A `.popover(item:)` on one shared binding is attached to every suggestion row. *Runtime unverified.* | `SkillsPane.swift:927` | Conf | polish | S |
| L21 | P2 | Split-divider restyle uses KVC on a private `backgroundColor` key; if a future macOS drops it, layout raises an uncatchable exception. | `SplitDividerTheme.swift:91-93` | Conf | harden | S |
| L22 | P2 | Search compiles the regex in a computed property read twice per body; match rows build eagerly per file. | `FindInFilesView.swift:268-278,151,195,379` | Perf | optimize | S |
| L23 | P2 | Pane geometry probe `NSLog`s on every `.global` frame change in release builds (window moves, divider drags). | `PracticePane.swift:987-991`; `SessionsPane.swift:27` | Perf | optimize | S |
| L24 | P2 | Session rows are tap-gesture views with no traits; selection uses `.textBackgroundColor` (≈ chrome) rather than `rowSelected`. | `SessionsPane.swift:441,444,474-486` | A11y | harden | S |
| L25 | P2 | Pane and section titles lack the header trait, so VoiceOver heading navigation can't jump between sections. | `PaneHeader.swift:41-47`; `PaneSectionHeader.swift:31-36` | A11y | harden | S |

### File viewer / editor, Review / diff, Backlog, Terminal, Problems, Preview, Brain

| ID | Sev | Finding and impact | Location | Dim | Command | V/S |
|----|-----|--------------------|----------|-----|---------|-----|
| K1 | P1 | **"Reject all" (and per-file / per-hunk reject) restores baselines on disk with no confirm or undo, next to "Accept all" as `.defaultAction`.** Plain Return bulk-accepts. *Whether `model.resolve` guards user edits is unverified.* | `ReviewChangesView.swift:353-357,403,419,668` | Conf | harden | V |
| K2 | P1 | **Esc/Close in the backlog detail sheet silently discards an unsaved body edit**; `bodyDirty` exists but Close never checks it. | `BacklogPanel.swift:895-896,865` | Conf | harden | V (895) / S |
| K3 | P1 | **Editor tabs are `onTapGesture` HStacks**, not buttons; no focus, button or selected trait. | `FileViewerView.swift:1264-1266` | A11y | harden | V |
| K4 | P1 | **Syntax/scroller palette is chosen as `preferredColorScheme != .light`.** `Bridge.preferredColorScheme` returns `nil` unless the theme is explicitly set, so with a *light system appearance and no explicit theme* the editor (and Brain) get the **dark** palette on a light editor. | `FileViewerView.swift:1467`; `BrainMetalView.swift:490`; `Bridge.swift:825-831` | Theme | colorize | V |
| K5 | P1 | **Brain pane animates when idle**: 30 fps target at idle with an 8000-particle profile; the only pause is window occlusion. *Whether the pane is unmounted when hidden is unverified.* | `BrainMetalView.swift:266-267,281-284`; `BrainProfile.swift:125` | Perf | optimize | S |
| K6 | P1 | **Split diff and gutter encode added/removed in colour only** (10% red/green tints; green vs orange 3 pt gutter); no +/− glyph. | `ReviewChangesView.swift:613,621`; `DiffGutterBar.swift:86-87` | A11y | colorize | S |
| K7 | P2 | `NSImage(contentsOfFile:)` runs in the `content` builder, decoding on the main thread on every body evaluation. | `FileViewerView.swift:1447-1448` | Perf | optimize | S |
| K8 | P2 | Diff sheet builds every row in a non-lazy `VStack` (up to the 2 MB cap) and re-splits the text each pass; Review Changes already uses a lazy stack and a size gate. | `DiffSheet.swift:218,224-225,235` | Perf | optimize | S |
| K9 | P2 | Terminal tab `×` and `+` are 8–9 pt glyphs; close hangs up a shell with no confirm (only shown with > 1 shell). | `TerminalPaneView.swift:81-89,98`; `TerminalSessionStore.swift:177` | A11y | harden | V |
| K10 | P2 | Icon-only/state controls have no label, value or selected/expanded state: split/inline picker segments, tab dirty dot, severity dot, zoom buttons, collapse chevrons. | `ReviewChangesView.swift:346`; `FileViewerView.swift:1233-1235,1717-1727`; `BacklogPanel.swift:571`; `DiagnosticsPanelView.swift:306`; `ProjectToolsPanel.swift:248` | A11y | harden | S |
| K11 | P2 | Preview: Close button carries two `.help`s (the second, "Open in default browser", wins); no browser shortcuts (⌘R/⌘[/⌘]/⌘L); a landed URL may be fed back as a change and reload. *Reload effect unverified.* | `PreviewPaneView.swift:144-145,195-197,336` | Conf | polish | S |
| K12 | P2 | Transparent `WKWebView` background (private KVC `drawsBackground`) over the window fill: default-styled local pages may be unreadable in dark mode. *Render unverified.* | `PreviewPaneView.swift:326`; `GraphPaneView.swift:146` | Theme | colorize | S |
| K13 | P2 | Three `GeometryReader`s in the editor chrome; the image preview fits once on appear and never refits on resize; no pinch/⌘± zoom. | `FileViewerView.swift:1134,1143,1698,1709-1713` | Perf/Adapt | adapt | V (sites) |
| K14 | P2 | Every keystroke copies the whole document and republishes the buffer map; dirty = `content != originalContent`; per-edit line scan; `textView.string != content`. | `FileViewerView.swift:709,252,84,1483,506` | Perf | optimize | S |
| K15 | P2 | Problems panel recomputes filtered/grouped lists ~6× per body, with string allocation per item. | `DiagnosticsPanelView.swift:130,270,278` | Perf | optimize | S |
| K16 | P2 | Backlog list sorts and filters on every body evaluation (comments cite 1,076 items); the provisional block is a non-lazy VStack. | `BacklogPanel.swift:105-129,146,463` | Perf | optimize | S |
| K17 | P2 | Review rows (`rowItems`/`sideBySideRows`) are rebuilt in `body`; toggling `busy` re-pairs the whole diff. | `ReviewChangesView.swift:457,530,447` | Perf | optimize | S |
| K18 | P2 | One click on a Tasks row runs a project script in the shell immediately; the `cd` quoting only escapes spaces. | `ProjectToolsPanel.swift:393,423` | Conf | harden | S |
| K19 | P2 | Outline/timeline results can land on the wrong file (no cancel or current-path check); the shared `nonisolated(unsafe)` cache is mutated from detached tasks. Same pattern for the diff gutter. | `ProjectToolsPanel.swift:64-66,122,138`; `FileViewerView.swift:1505` | Perf | harden | S |
| K20 | P2 | Reduce Motion only drops the Brain to 10 fps; particles, trails and the boot animation keep moving. | `BrainMetalView.swift:264-265,108-116` | A11y | animate | S |
| K21 | P2 | Editor, terminal and Markdown preview use fixed 12/12/14 pt with no zoom control found. | `FileViewerView.swift:417-420`; `PTYTerminalView.swift:87`; `MarkdownFilePreview.swift:42` | A11y | typeset | S |
| K22 | P2 | Information text at 8–9 pt `.tertiary`: Problems path/source/line:col, Tasks kind chip, `TERMINAL` header. | `DiagnosticsPanelView.swift:320,363-370`; `ProjectToolsPanel.swift:396-399`; `TerminalPaneView.swift:109-112` | A11y | typeset | S |
| K23 | P2 | Scrollers forced to overlay, overriding "Show scroll bars: Always". | `FileViewerView.swift:602` | Conf | polish | S |
| K24 | P3 | Graph availability probe downloads the whole HTML, then the web view fetches it again; the graph is a pointer-only `WKWebView`. | `GraphPaneView.swift:118,147` | Perf | optimize | S |
| K25 | P3 | `savedFlash` never reset after classify; blocked-on text commits only on Return; success message "Filed: url" shown through the red error text. | `BacklogPanel.swift:1022,963,734` | Conf | polish | S |
| K26 | P3 | Terminal ANSI palette and appearance switching are unverified; header file path not selectable. | `PTYTerminalView.swift:86-91`; `FileViewerView.swift:1282` | Theme | polish | S |

## Severity changes (mine vs the scouts')

| Finding | Scout | Here | Why |
|---------|-------|------|-----|
| L1 SC per-file actions hover-only | P0 | P1 | "Stage all / Unstage all / Discard all" are buttons, so the task is completable from the keyboard in bulk; per-file is the gap. |
| K9 Terminal close | P1 | P2 | Only visible with > 1 shell; hit-area and confirm gap, no data loss. |
| C8 Return default vs composer | P1 | P2 | The text view consumes Return itself when focused; risk applies only when focus is elsewhere. |
| W5 F-keys | P1 | P2 | A documented choice in code; items remain menu- and palette-runnable. |
| W4 ModelsDialog pickers | P1 | P2 | A visible label sits beside each picker; VoiceOver name only. |
| K7 / K8 | P1 | P2 | Image tabs / a size-capped sheet, not every-render paths of the main surface. |
| L9, L10, L12 | P1 | P2 | Runtime or merging behaviour the scout marked unverified. |

## Positive findings

- **Command registry:** one array feeds the menu bar, ⇧⌘P palette and ⌘/ sheet; disabled rows are skipped (`CommandRegistry.swift:84-443`, `MARVINApp.swift:198-235`, `CommandPaletteSheet.swift:128-141`).
- **Keyboard coverage:** 66 `keyboardShortcut`s; Sessions has ↑↓⏎ with the focus ring on the row, not the pane (`SessionsPane.swift:73-86,447`); the branch picker has a step-back Esc flow (`GitRefPicker.swift:148-161`).
- **Transcript performance:** `ChatMessageRow` is `Equatable` with `.equatable()`, a `LazyVStack` and a bounded render window (`ChatMessageRow.swift:34`, `ChatPreviewView.swift:3769,3789`); "Copy Message" reads the model, not the AppKit view (`ChatMessageRow.swift:83-89`).
- **Honest status signals:** tab state uses spinner/dot/count/glyph so colour is never the only cue (`ChatPreviewView.swift:3030-3068`); notice kinds pair colour with distinct glyphs and errors persist (`PaneNoticeStyle.swift:12-29`, `PaneNoticeStrip.swift:30-34`).
- **Reduce Motion done right where done:** chip and icon button drop their scale (`InlineActionChip.swift:78`, `PaneControls.swift:35`); the Brain pauses on occlusion and throttles during live resize (`BrainMetalView.swift:137,147,283`); the skeleton is static and labelled (`SkeletonRows.swift:20-31`).
- **Safe destructive paths exist:** `ChatTabCloseDialog` uses `confirmationDialog` with a `.destructive` role (`ChatTabCloseDialog.swift:25-46`); Replace All has a confirmation (`FindInFilesView.swift:153`); ⌘Q confirms while a turn runs (`MARVINApp.swift:489-506`); Files has a Trash confirm (`FileTreeView.swift:228-242`); `UpdatePromptView` defaults to the safe "Later".
- **Native editor plumbing:** `NSTextFinder`, Revert/stale-on-disk/unsaved alerts, context menu appended rather than replaced (`FileViewerView.swift:436,1015,1038-1086,354`).
- **Settings and sheets:** grouped `Form` with `LabeledContent`, `SecureField`, selectable paths (`SettingsView.swift:58-217`); `PrepareMRSheet` states its consequence in the button and uses a native checkbox (`PrepareMRSheet.swift:98,170`).
- **Layout discipline:** panes declare `minWidth: 0` and clip so the 44 pt rail survives collapse (`PaneHeader.swift:9-16`, `LeftPane.swift:376-377`); popover edge is one constant (`AppStatusBar.swift:44`); `LayoutOscillationProbe` uses `onGeometryChange` (`LayoutOscillationProbe.swift:76-80`).
- **Large-diff handling:** Review Changes uses a flat `LazyVStack` and a 1500-line "Show anyway" gate (`ReviewChangesView.swift:451-466`).

## Recommended actions (priority order)

1. **[P1] `/impeccable harden`**: the accessibility and destructive-action core. Give every control a name/state/value (`PaneEnableToggle`, `ModelsDialog`, tabs, rail, rows, tool-card disclosure, AskQuestion options); give hover-/tap-only rows a focusable button plus `accessibilityAction`s (L1, L2, L3, K3, C4, C5); announce confirms and errors (C3); add confirms or safe defaults for Reject all, full-auto escalation, `danger` git sheets, Reset key, backlog Esc, Replace All whole-word (K1, C2, W2, W6, K2, L6); stop Return submitting mid-IME (C1); make Quick Open/Symbol/Run Task selection visible and scrolled (W1).
2. **[P1] `/impeccable colorize`**: make git-status and diff colours appearance-adaptive with a glyph (L4, K6); derive the syntax/Brain palette from the effective appearance (K4); route the sibling sheets through `MarvinTheme` (W19); lift neutral-chip contrast and honour Increase Contrast (L15).
3. **[P1] `/impeccable optimize`**: make the Source Control list truly lazy (L5); cache markdown/plan parses and highlighting (C18, C19); stop work-in-body in Quick Open, palette, Problems, Backlog (W13, W15, K15, K16); pause the Brain when idle/hidden (K5); decode off-main (W14, K7).
4. **[P2] `/impeccable adapt`**: lower the 960 pt window minimum and clamp persisted heights/fixed chrome to the available size (W22, C6, L16, L17); give the status bar and composer row an overflow strategy (W9, C7).
5. **[P2] `/impeccable typeset`**: raise information text from 8–10.5 pt `.tertiary` to ≥ 11 pt `.secondary`/`textMuted` (S4, L14, K22, C24); add editor/terminal font-size zoom (K21).
6. **[P2] `/impeccable clarify`**: error copy and notice kinds (C14, C9, L18, W25), the scope-met chip (C23), truncated permission excerpts in Sessions (L7).
7. **[P2] `/impeccable animate`**: Reduce Motion across the remaining transitions and the Brain (S5, W11, K20).
8. **[P3] `/impeccable distill`**: remove the dead `SetupPopoverContent`/`ProjectPickerToolbarItem` (W16, and update the snapshot harness).
9. **`/impeccable polish`** as the final pass (menu placement, shortcut conventions, tooltip duplicates, palette hit areas, scroller style).

## Coverage

All four surface groups were read by scouts, most files in full: chat (14 files, `ChatPreviewView.swift` in full), chrome (27), left panes (24 in full, `FileTypeIcons.swift` partly), work surfaces (19 in full, `BacklogService`/`BrainGPUSimulation`/`BrainProfile`/`Bridge` partly). Not read by anyone: `BrainShaders.swift`, `Bridge.swift` beyond lines 1–260 and the theme property, `NativePrefs.swift`, `SessionRegistry.swift`, and the sidecar. The `Metal`/`WKWebView`/`NSTextView`-backed surfaces (Brain, Graph, Preview, editor, markdown prose) can only be judged for behaviour in code here; how they look is unchecked. **Everything about pixels (spacing, truncation, overlap, actual contrast of system colours) needs the render pass.**

> You can ask me to run these one at a time, all at once, or in any order you prefer. Re-run `/impeccable audit` after fixes to see the score improve.

## Finding counts (computed from the tables above)

| Surface | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| Chat | 0 | 6 | 20 | 1 | 27 |
| Window chrome | 0 | 3 | 22 | 1 | 26 |
| Left panes & rail | 0 | 8 | 17 | 0 | 25 |
| Work surfaces | 0 | 6 | 17 | 3 | 26 |
| **All** | **0** | **23** | **76** | **5** | **104** |

(Systemic patterns S1–S8 are cross-references to these rows, not separate findings.)


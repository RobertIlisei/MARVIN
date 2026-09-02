// LeftPane — five-tool native sidebar: Files | Search | Source
// Control | Skills | Plugins, switched via a VS Code / Cursor /
// Antigravity-style icon rail (narrow, icon-only, tooltip for the
// name) instead of a horizontal segmented control — 2026-08-29
// "Antigravity redesign" pass, roadmap.
//
// The tab state lives in this view, not in either child model,
// because the tab choice is a UI concern that doesn't affect what
// either child fetches — both keep auto-loading on bridge changes
// regardless of which tab is currently selected. That trades a
// tiny bit of background work (the inactive child still polls its
// endpoint) for crisp tab switches with no fetch flash.

import MARVINLogic
import SwiftUI

private enum LeftPaneTab: String, CaseIterable, Identifiable {
    case files
    case search
    case sourceControl
    case skills
    case plugins
    case practice
    var id: String { rawValue }

    var label: String {
        switch self {
        case .files: return "Files"
        case .search: return "Search"
        case .sourceControl: return "Source Control"
        case .skills: return "Skills"
        case .plugins: return "Plugins"
        case .practice: return "Practice"
        }
    }

    var systemImage: String {
        switch self {
        case .files: return "doc.text"
        case .search: return "magnifyingglass"
        case .sourceControl: return "arrow.triangle.branch"
        case .skills: return "sparkle"
        case .plugins: return "puzzlepiece.extension"
        case .practice: return "moon.zzz"
        }
    }
}

/// Width of the left pane, reported from a background measurement layer so the
/// pane keeps its own intrinsic sizing (a root GeometryReader does not) and so
/// a divider drag re-renders only a `Color.clear`. See `LeftPane.body`.
///
/// `-1`, not `0`: the default is what `onPreferenceChange` sees BEFORE the
/// first real layout, and a `0` default silently reads as "narrow enough to
/// collapse". That shipped once and hid the whole sidebar.
private struct LeftPaneWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = -1
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct LeftPane: View {
    /// Picker selection persists across tab switches but not across
    /// app restarts — `@State` is sufficient. Phase 3e doesn't store
    /// it in @AppStorage because the daily-driver expectation is
    /// "files on launch, switch when you want SCM". Promote to
    /// AppStorage if user feedback says otherwise.
    @Environment(MarvinBridge.self) private var bridge
    @State private var tab: LeftPaneTab = .files
    /// Expanded Outline/Timeline/Tasks sections, reported up by the panel.
    @State private var toolsOpenSections = 0

    /// Height the user dragged the tools panel to. Grown, never shrunk, by
    /// `toolsMinHeight` — see below.
    @State private var toolsHeight: CGFloat = 78

    /// Floor for the tools panel: its three headers, plus room for whatever
    /// is open. Capped so opening all three cannot crush the file tree.
    ///
    /// A floor rather than a height, because the two behave differently on
    /// collapse: a floor claims room when a section opens and then simply
    /// stops demanding, leaving a position the user dragged to intact.
    private var toolsMinHeight: CGFloat {
        let headers: CGFloat = 78
        guard toolsOpenSections > 0 else { return headers }
        return headers + min(CGFloat(toolsOpenSections) * 120, 260)
    }

    /// Draggable split between the file tree and the tools panel.
    ///
    /// A plain divider with a drag gesture, NOT a `VSplitView`. The split
    /// view bridges to `NSSplitView`, and its hosted children do not inherit
    /// the window's safe-area inset: probed live, the pane container sat at
    /// y=52 (below the title bar) while the tree inside the split view sat at
    /// y=0, so the tree's own 38pt header rendered entirely above the pane's
    /// top edge and the first row was clipped by the title bar (user,
    /// 2026-08-31: "on top the file explorer, the items are going out of
    /// bounds"). Three fixes before this one reasoned from source about
    /// ScrollView ideal heights and were all wrong; the frames settled it in
    /// one launch.
    ///
    /// Losing the bridge also removes the ideal-size guessing it forced, and
    /// `_NSSplitViewItemViewWrapper` was among the constraint-storm triggers.
    private var toolsDivider: some View {
        MarvinDivider()
            // A 1px hairline is not a drag target. The padding widens the hit
            // area without moving anything, which is what AppKit's own split
            // dividers do.
            .padding(.vertical, 2)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        // Dragging UP grows the panel, so the translation is
                        // subtracted. Clamped to a sane band rather than
                        // measured against the pane: measuring would need a
                        // GeometryReader, and inserting views into this
                        // hierarchy is what made AppKit's runaway-pass breaker
                        // fatal in v0.1.93.
                        let next = toolsHeight - value.translation.height
                        toolsHeight = min(max(next, 78), 520)
                    }
            )
    }

    // The collapse thresholds and the deadband between them live in
    // `MARVINLogic.SidebarCollapse`, where they are tested.

    /// Latched from the width measurement below. Kept as state, not derived
    /// inline, so the pane re-renders when the collapse decision *changes* —
    /// not on every width the divider passes through.
    @State private var collapsed = false

    var body: some View {
        // Width measurement, and why it is `onGeometryChange` rather than a
        // GeometryReader in a `.background`.
        //
        // The background-layer version was itself a fix (2026-08-29) for two
        // real problems: a ROOT GeometryReader is greedy — it swallows the
        // proposal, so the hosting view exposes no intrinsic width for the
        // enclosing NSSplitView and dragging the divider went sluggish — and
        // `pane()` must depend on a latched Bool, not a raw width, or every
        // frame of a drag re-evaluates a subtree that keeps all five panes
        // mounted to preserve their @State.
        //
        // What it did NOT fix is that a preference is read and a state is
        // written DURING the update pass. Collapsing changes what the pane
        // renders, which changes the width that gets measured, which — with
        // one threshold used in both directions — can cross back and expand
        // it again. Every cycle is a fresh SwiftUI update, and a split view
        // re-forms its panes and re-sets each hosting view's root on every
        // one, which is the constraint storm this repo has been chasing
        // since 2026-08-29. Usually ~5 a session; with two sessions running,
        // updates arrived twice as fast and it stopped converging at all —
        // 100 % CPU on the main thread, the app unresponsive (user,
        // 2026-08-31: "i just started 2 sessions and marvin and it seems now
        // it's stuck"). The stack named the loop precisely:
        // `SystemSplitView.updateNSViewController` →
        // `SplitViewCoordinator.formCurrentItems` → `updateRootViewForItem`
        // → `NSHostingView.setRootView` → `setNeedsUpdate`.
        //
        // Two changes, and both are needed:
        //
        //   1. `onGeometryChange` reports geometry WITHOUT inserting a view.
        //      This is what `WidthReporter` was reaching for in v0.1.93 —
        //      that experiment did eliminate the storm, proved by stack diff,
        //      and then crashed because it added subviews in three places and
        //      AppKit counts update passes against the view count. This is
        //      the same fix without the extra views.
        //   2. `SidebarCollapse` supplies a DEADBAND. A single threshold with
        //      a state write on either side is an oscillator; the width that
        //      collapsing produces must not by itself satisfy the expand
        //      test. Pinned by tests, since it is exactly the logic a running
        //      app cannot demonstrate.
        //
        // macOS 14 keeps the old path — `onGeometryChange` is 15+, and the
        // deployment target is 14.0 (`macos/project.yml`). It still gets the
        // deadband, which is the half that matters most.
        Group {
            if #available(macOS 15.0, *) {
                pane(collapsed: collapsed)
                    .frame(minWidth: 45)
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.width
                    } action: { width in
                        updateCollapsed(paneWidth: width)
                    }
            } else {
                pane(collapsed: collapsed)
                    .frame(minWidth: 45)
                    .background {
                        GeometryReader { geo in
                            Color.clear.preference(
                                key: LeftPaneWidthKey.self,
                                value: geo.size.width,
                            )
                        }
                    }
                    .onPreferenceChange(LeftPaneWidthKey.self) { width in
                        updateCollapsed(paneWidth: width)
                    }
            }
        }
    }

    /// Latch the collapse decision, with the deadband doing the deciding.
    ///
    /// The `next != collapsed` guard is not decoration: without it every
    /// measurement writes state, and a state write per layout is the loop
    /// this is here to break.
    private func updateCollapsed(paneWidth: CGFloat) {
        // A pane that has not been measured is never a collapsed pane — the
        // PreferenceKey's -1 sentinel and this guard both exist because the
        // obvious version latched `collapsed = true` from a default of 0
        // before any real layout, and rendered rail-only at full width.
        guard paneWidth > 0 else { return }
        let next = SidebarCollapse.next(paneWidth: paneWidth, collapsed: collapsed)
        if next != collapsed { collapsed = next }
    }

    private func pane(collapsed: Bool) -> some View {
        HStack(spacing: 0) {
            activityBar
            Rectangle()
                .fill(MarvinTheme.border)
                .frame(width: 1)
                // Collapsed = rail only. The border would otherwise draw a
                // stray hairline against the pane the sidebar is now hiding
                // behind, one pixel from the split divider.
                .opacity(collapsed ? 0 : 1)
            // Both views are kept in the tree (just one is hidden)
            // so child @State (e.g. selectedPath, fetched response)
            // survives a tab switch. The opacity-based toggle is
            // 60fps-cheap; the alternative — `if/else` swapping —
            // would re-create the view on every flip and lose state.
            ZStack {
                // Files = the tree PLUS the Outline / Timeline / Tasks
                // sections beneath it, which is where VS Code and Antigravity
                // put them. A VSplitView so the user can decide how much room
                // the sections get — they are collapsed by default, so the
                // tree keeps the whole pane until someone opens one.
                paneSlot(
                    VStack(spacing: 0) {
                        FileTreeView()
                            .frame(maxHeight: .infinity)
                        toolsDivider
                        ProjectToolsPanel(openSections: $toolsOpenSections)
                            .frame(height: max(toolsHeight, toolsMinHeight))
                    },
                    active: tab == .files
                )
                paneSlot(FindInFilesView(), active: tab == .search)
                paneSlot(SourceControlView(), active: tab == .sourceControl)
                paneSlot(SkillsPane(), active: tab == .skills)
                paneSlot(PluginsPane(), active: tab == .plugins)
                paneSlot(PracticePane(), active: tab == .practice)
            }
            // `minWidth: 0` is load-bearing, not defensive. All five panes stay
            // mounted, so the ZStack's minimum width is the WIDEST of their
            // intrinsic minimums — and once the user drags the split narrower
            // than that, the HStack overflows and pushes the 44pt rail off the
            // left edge. That is the "icons disappear / go out of bounds on
            // resize" report (2026-08-29): the rail was still drawing, just
            // outside the pane. Letting the content absorb the compression and
            // clipping what doesn't fit keeps the rail pinned.
            .frame(minWidth: 0, maxWidth: .infinity)
            .clipped()
            .background(MarvinTheme.background)
            // No animation on `tab`.
            //
            // `paneSlot` switches a pane between `frame(0x0)` and its real
            // size, so animating on `tab` made SwiftUI INTERPOLATE that frame
            // over 180 ms — re-laying out the whole incoming pane on every
            // frame of the transition. On SkillsPane (45+ rows) that is the
            // "sluggish, not fluid" the user reported. A tab switch should be
            // instant; the crossfade is already carried by each slot's own
            // `opacity`, which animates without touching layout.
            // Hidden rather than removed: the five panes keep their @State
            // (scroll offset, expanded folders, in-flight fetches) across a
            // collapse, so dragging back open restores what was there instead
            // of re-fetching into an empty tree.
            .opacity(collapsed ? 0 : 1)
            .allowsHitTesting(!collapsed)
        }
        .clipped()
        // A View-menu item or a Command Palette entry asks for a tab by
        // name; the pane owns which one is showing, so the request arrives
        // as bridge state and is cleared once honoured. A raw string rather
        // than the enum because `LeftPaneTab` is private to this file and
        // deliberately stays that way — the pane's tab set is not API.
        .onChange(of: bridge.requestedLeftTab) { _, requested in
            guard let requested, let want = LeftPaneTab(rawValue: requested) else { return }
            tab = want
            bridge.requestedLeftTab = nil
        }
    }

    /// One tab's pane. Every pane stays MOUNTED so its @State (fetched tree,
    /// expanded folders, search text) survives a tab switch — but an inactive
    /// one is taken out of layout and out of focus, not merely faded.
    ///
    /// The old `opacity(0)` left four hidden panes fully laid out and fully
    /// focusable. That is what made dragging this split sluggish while the
    /// right split stayed fluid: the ADR-0062 storm monitor logged 150
    /// constraint invalidations per 0.5 s on THIS hosting view during a drag,
    /// and the stack is SwiftUI rebuilding the key-view loop —
    /// `SplitViewContentProvider → _recursiveSetDefaultKeyViewLoop →
    /// FocusNavigator.allItems → NSHostingView.updateSize` — over every
    /// focusable item in all five panes, then re-sizing, then rebuilding
    /// again. A 0×0 disabled pane contributes no focus items and no layout.
    private func paneSlot<V: View>(_ view: V, active: Bool) -> some View {
        view
            .opacity(active ? 1 : 0)
            .allowsHitTesting(active)
            .frame(width: active ? nil : 0, height: active ? nil : 0)
            .clipped()
            .disabled(!active)
            // `.focusable(false)` unconditionally, not `.focusable(active)`.
            //
            // Marking the ACTIVE pane focusable makes the whole pane a focus
            // target, so macOS draws its focus ring around the entire pane —
            // the blue outline the user reported (2026-08-31: "sometimes I can
            // see the blue lines of the pane, this is not very professional").
            // The pane's CONTENTS are focusable on their own; the container
            // never needed to be.
            //
            // The load-bearing half is unchanged: inactive panes stay out of
            // the focus key-view loop via `disabled(!active)` plus the zero
            // frame. `false` keeps that and is strictly stronger.
            .focusable(false)
            .accessibilityHidden(!active)
    }

    /// Narrow icon-only rail — VS Code / Cursor / Antigravity convention.
    /// Lives inside `LeftPane` (not a separate `HSplitView` column in
    /// `ContentView`) so it comes for free without touching the window's
    /// split layout, drag regions, or toolbar; visually indistinguishable
    /// from a dedicated activity-bar column since it never resizes.
    private var activityBar: some View {
        VStack(spacing: 2) {
            ForEach(LeftPaneTab.allCases) { t in
                activityBarButton(t)
            }
            Spacer(minLength: 0)
        }
        // First icon centred on the pane header row — the rail and the
        // "project name" strip read as one bar, as in VS Code / Antigravity.
        .padding(.top, (MarvinTheme.paneHeaderHeight - 34) / 2)
        // Fixed, and told so — without `fixedSize` the rail is a candidate for
        // compression when the split gets tight, and a half-width rail is
        // worse than a clipped pane.
        .frame(width: 44)
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxHeight: .infinity)
        .background(MarvinTheme.background)
    }

    private func activityBarButton(_ t: LeftPaneTab) -> some View {
        ActivityBarButton(tab: t, selected: tab == t) { view in
            tab = t
            // Collapsed sidebar + a rail click means "show me this pane", not
            // "switch the tab hiding behind a zero-width pane" (user,
            // 2026-08-29). No-op when the pane is already open.
            SplitPaneResizer.expandIfCollapsed(
                from: view,
                restoreTo: Self.restoreWidth,
                threshold: SidebarCollapse.collapseBelow + SidebarCollapse.railWidth
            )
        }
    }

    /// Width the sidebar re-opens to when you click the rail. Matches
    /// `ContentView`'s `idealWidth` so a collapse/expand round-trip lands
    /// where the pane started.
    private static let restoreWidth: CGFloat = 260
}

/// One rail icon. Split out so it can own its hover state — `.help()`
/// on a `.plain` Button nested in overlays never surfaced a tooltip
/// (2026-08-29 "no hover tooltips" finding); attaching it to the icon
/// itself, with an explicit hover fill, matches how VS Code's rail feels.
private struct ActivityBarButton: View {
    let tab: LeftPaneTab
    let selected: Bool
    /// Receives the AppKit hit view so the click can reach the enclosing
    /// `NSSplitView` and re-open a collapsed sidebar.
    let action: (NSView) -> Void
    @State private var hovered = false

    var body: some View {
        Image(systemName: tab.systemImage)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(
                selected || hovered ? MarvinTheme.textPrimary : MarvinTheme.textMuted
            )
            .frame(width: 44, height: 34)
            .background(
                selected ? MarvinTheme.rowSelected
                    : hovered ? MarvinTheme.rowHover : Color.clear
            )
            .overlay(alignment: .leading) {
                if selected {
                    Rectangle().fill(Color.accentColor).frame(width: 2)
                }
            }
            // AppKit-backed hit layer: owns the click, the hover state AND
            // the tooltip. SwiftUI's `.help()` never surfaced on these rail
            // icons in practice (2026-08-29, twice), so the tooltip goes
            // through NSView.toolTip, which AppKit shows unconditionally.
            .overlay(TooltipHitLayer(tooltip: tab.label, hovered: $hovered, onClick: action))
            .animation(MarvinTheme.transition, value: hovered)
            .accessibilityLabel(tab.label)
            .accessibilityAddTraits(.isButton)
    }
}

/// Transparent NSView that provides a native tooltip, hover tracking and a
/// click callback for whatever SwiftUI content it's overlaid on.
struct TooltipHitLayer: NSViewRepresentable {
    let tooltip: String
    @Binding var hovered: Bool
    /// Passed the hit view itself — callers that need to reach AppKit (the
    /// activity rail re-opening a collapsed split pane) have no other handle
    /// on a real `NSView` from inside SwiftUI.
    let onClick: (NSView) -> Void

    func makeNSView(context: Context) -> HitView {
        let v = HitView()
        v.tooltip = tooltip
        v.onClick = onClick
        v.onHover = { hovered = $0 }
        return v
    }

    func updateNSView(_ v: HitView, context: Context) {
        // The tooltip text is plain state on the view now, not AppKit's
        // `toolTip` property — writing that one reset AppKit's internal timer,
        // and SwiftUI calls updateNSView on every hover-state change, so the
        // tooltip was being cancelled by the very hover that should show it
        // ("sometimes I see them, sometimes I don't", 2026-08-29). HoverTooltip
        // owns the timing; assigning text mid-hover is harmless.
        v.tooltip = tooltip
        v.onClick = onClick
        v.onHover = { hovered = $0 }
    }

    final class HitView: NSView {
        // `onClick` takes the view so a caller can walk the AppKit hierarchy.
        /// Tooltip text. Deliberately NOT `NSView.toolTip`: AppKit holds the
        /// first tooltip of a session for ~1.5-2s and offers no supported way
        /// to shorten it (registering `NSInitialToolTipDelay` was tried and
        /// did not change the first hover). `HoverTooltip` draws it instead.
        var tooltip: String = ""
        var onClick: (NSView) -> Void = { _ in }
        var onHover: (Bool) -> Void = { _ in }
        private var tracking: NSTrackingArea?

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let tracking { removeTrackingArea(tracking) }
            let t = NSTrackingArea(
                rect: bounds,
                options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                owner: self, userInfo: nil
            )
            addTrackingArea(t)
            tracking = t
        }

        override func mouseEntered(with event: NSEvent) {
            onHover(true)
            HoverTooltip.shared.show(tooltip, for: self)
        }

        override func mouseExited(with event: NSEvent) {
            onHover(false)
            HoverTooltip.shared.cancel()
        }

        override func mouseDown(with event: NSEvent) {
            // Clicking answers the question the tooltip was going to answer —
            // leaving it up over the pane you just opened is pure noise.
            HoverTooltip.shared.cancel()
            onClick(self)
        }

        /// A view torn out of the hierarchy mid-hover never gets `mouseExited`,
        /// which would strand a visible tooltip over the new content.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { HoverTooltip.shared.cancel() }
        }
        override var acceptsFirstResponder: Bool { false }
    }
}

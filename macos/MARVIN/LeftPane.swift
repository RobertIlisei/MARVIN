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

import SwiftUI

private enum LeftPaneTab: String, CaseIterable, Identifiable {
    case files
    case search
    case sourceControl
    case skills
    case plugins
    var id: String { rawValue }

    var label: String {
        switch self {
        case .files: return "Files"
        case .search: return "Search"
        case .sourceControl: return "Source Control"
        case .skills: return "Skills"
        case .plugins: return "Plugins"
        }
    }

    var systemImage: String {
        switch self {
        case .files: return "doc.text"
        case .search: return "magnifyingglass"
        case .sourceControl: return "arrow.triangle.branch"
        case .skills: return "sparkle"
        case .plugins: return "puzzlepiece.extension"
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
    @State private var tab: LeftPaneTab = .files

    /// Width below which the content half of the pane is dropped and only the
    /// rail remains — VS Code / Antigravity collapse the sidebar when you drag
    /// it narrow instead of clamping it at a minimum (user, 2026-08-29: "the
    /// pane gets hidden, but in marvin it remains at an exact size"). Measured
    /// on the content, not the whole pane, so the rail's 44pt never counts.
    private static let collapseBelow: CGFloat = 110

    /// Latched from the width measurement below. Kept as state, not derived
    /// inline, so the pane re-renders when the collapse decision *changes* —
    /// not on every width the divider passes through.
    @State private var collapsed = false

    var body: some View {
        // Measurement is a `.background` layer, NOT a root GeometryReader.
        //
        // Two separate problems, fixed in two passes on 2026-08-29:
        //
        // 1. PERFORMANCE. A root GeometryReader is greedy — it swallows the
        //    proposal and reports it, so the SwiftUI hosting view exposes no
        //    intrinsic width for the enclosing NSSplitView to size against.
        //    Dragging the divider was visibly sluggish while the right pane's
        //    VSplitView, whose children have natural intrinsic sizes, stayed
        //    fluid. Measuring from a background layer leaves the pane's own
        //    sizing intact.
        //
        // 2. CORRECTNESS. `pane()` must depend on a latched Bool, not on the
        //    raw width, or every frame of a drag re-evaluates a subtree that
        //    keeps all five panes mounted (files, search, SCM, skills,
        //    plugins) to preserve their @State.
        //
        // The obvious version of this is a bug, and shipped as one: with a
        // PreferenceKey defaultValue of 0, `onPreferenceChange` fires once
        // BEFORE any real layout, `0 - 45 < 110` latches `collapsed = true`,
        // and the sidebar renders rail-only at full width. Hence the sentinel
        // default of -1 and the `width > 0` guard below — an unmeasured pane
        // is never a collapsed pane.
        //
        // `onGeometryChange(for:)` expresses all of this directly but is
        // macOS 15+; the deployment target is 14.0 (`macos/project.yml`).
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
                // The sentinel: -1 means "not measured yet". Only a real
                // layout gets to decide whether the pane is collapsed.
                guard width > 0 else { return }
                // Measured on the content, not the whole pane, so the rail's
                // 45pt never counts toward the threshold.
                let next = width - 45 < Self.collapseBelow
                if next != collapsed { collapsed = next }
            }
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
                paneSlot(FileTreeView(), active: tab == .files)
                paneSlot(FindInFilesView(), active: tab == .search)
                paneSlot(SourceControlView(), active: tab == .sourceControl)
                paneSlot(SkillsPane(), active: tab == .skills)
                paneSlot(PluginsPane(), active: tab == .plugins)
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
            .animation(MarvinTheme.transition, value: tab)
            // Hidden rather than removed: the five panes keep their @State
            // (scroll offset, expanded folders, in-flight fetches) across a
            // collapse, so dragging back open restores what was there instead
            // of re-fetching into an empty tree.
            .opacity(collapsed ? 0 : 1)
            .allowsHitTesting(!collapsed)
        }
        .clipped()
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
            .focusable(active)
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
                threshold: Self.collapseBelow + 45
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

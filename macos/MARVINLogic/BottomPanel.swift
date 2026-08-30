// BottomPanel — which bottom tab is showing, as a pure value (plan §D).
//
// The bottom area used to be N independent Bools rendered side by side in an
// `HSplitView` when 2+ were on and a bare `if/else` chain when 1 was. Two
// consequences: toggling 1→2 swapped view identity and destroyed each pane's
// `@State`, and Problems was effectively unreachable — its only affordance
// was a status-bar pill that renders only when the counts are non-zero.
//
// A tab strip is the IDE convention (VS Code, Antigravity) and collapses all
// of it: one visible tab, panes kept mounted so scrollback and scroll offset
// survive a switch.
//
// Two transitions, deliberately different:
//   • `activating` — what a toolbar button or ⌘-shortcut does. Clicking the
//     open tab closes the panel (VS Code semantics).
//   • `revealing`  — what a build task or the diagnostics pill does. NEVER
//     closes: a task must not be able to hide its own output by firing twice.
//
// Pure (ADR-0022) so both rules are test-pinned without a running app.

import Foundation

public enum BottomPanelTab: String, CaseIterable, Sendable, Codable {
    case problems
    case terminal
    case preview
    case graph

    public var title: String {
        switch self {
        case .problems: return "Problems"
        case .terminal: return "Terminal"
        case .preview:  return "Preview"
        case .graph:    return "Graph"
        }
    }

    /// SF Symbol for the tab strip.
    public var symbol: String {
        switch self {
        case .problems: return "exclamationmark.triangle"
        case .terminal: return "terminal"
        case .preview:  return "eye"
        case .graph:    return "point.3.connected.trianglepath.dotted"
        }
    }
}

public struct BottomPanelState: Equatable, Sendable {
    public var isOpen: Bool
    public var activeTab: BottomPanelTab

    public init(isOpen: Bool = false, activeTab: BottomPanelTab = .terminal) {
        self.isOpen = isOpen
        self.activeTab = activeTab
    }

    /// Toolbar / shortcut semantics: select the tab, or close the panel when
    /// it is already the visible one.
    public func activating(_ tab: BottomPanelTab) -> BottomPanelState {
        if isOpen && activeTab == tab { return BottomPanelState(isOpen: false, activeTab: tab) }
        return BottomPanelState(isOpen: true, activeTab: tab)
    }

    /// Producer semantics: show this tab. Never closes.
    public func revealing(_ tab: BottomPanelTab) -> BottomPanelState {
        BottomPanelState(isOpen: true, activeTab: tab)
    }

    /// ⌘J — open/close without changing which tab is selected.
    public func toggled() -> BottomPanelState {
        BottomPanelState(isOpen: !isOpen, activeTab: activeTab)
    }
}

/// Which bottom tabs have earned a mount.
///
/// The panes are mounted lazily — an unopened Graph tab should never pay for
/// a `WKWebView` it may never show — and stay mounted once activated, so
/// terminal scrollback and scroll offsets survive a tab switch. The set of
/// tabs that have been activated is the whole rule.
///
/// It was previously maintained by a single `onChange(of: activeTab,
/// initial: true)` guarded on `isOpen`, and that misses the most ordinary
/// case there is. `bottomPanesArea` stays in the view hierarchy even when
/// the panel is shut (it collapses to zero height, so the `VSplitView` keeps
/// its divider position) — so the observer fires ONCE at launch, with the
/// panel closed, and mounts nothing. Opening the panel does not change
/// `activeTab`, so it never fired again: the panel opened onto an empty
/// ZStack. A Terminal tab with no header and no shell, no error anywhere,
/// because nothing had been asked to run. Clicking any other tab and back
/// fixed it, which is exactly why it read as intermittent (2026-08-30).
///
/// Pure (ADR-0022) so the open-transition case is pinned without a running
/// app — a view-local `onChange` is precisely what could not be tested.
public enum BottomPanelMounting {
    /// The mounted set after observing `state`. Monotonic: tabs are never
    /// unmounted, and a closed panel mounts nothing new.
    public static func mounted(
        _ current: Set<BottomPanelTab>,
        after state: BottomPanelState
    ) -> Set<BottomPanelTab> {
        guard state.isOpen else { return current }
        return current.union([state.activeTab])
    }
}

/// Reading the persisted `marvin.panes` payload, old shape or new.
///
/// An existing user has `{files, brain, graph, preview, terminal, problems}`
/// with any combination on. Rather than a one-shot migration flag (which
/// misfires if the user rolls back and forward again), this is a pure
/// function of the payload: it runs every load and is idempotent.
public enum BottomPanelMigration {
    /// Precedence when several bottom panes were on: the one the user was
    /// most likely looking at. Terminal first — it is the one with running
    /// state; Graph last, it is the most incidental.
    public static let precedence: [BottomPanelTab] = [.terminal, .problems, .preview, .graph]

    /// Resolve the panel state from the legacy per-pane booleans.
    public static func resolve(
        terminal: Bool,
        problems: Bool,
        preview: Bool,
        graph: Bool,
        stored: BottomPanelTab? = nil
    ) -> BottomPanelState {
        let on: [BottomPanelTab: Bool] = [.terminal: terminal, .problems: problems, .preview: preview, .graph: graph]
        // A stored tab from the new shape wins, provided it was actually on.
        if let stored, on[stored] == true { return BottomPanelState(isOpen: true, activeTab: stored) }
        if let first = precedence.first(where: { on[$0] == true }) {
            return BottomPanelState(isOpen: true, activeTab: first)
        }
        // Nothing was on: keep the stored tab as the selection for next time.
        return BottomPanelState(isOpen: false, activeTab: stored ?? .terminal)
    }

    /// The legacy booleans to WRITE alongside the new shape, so rolling back
    /// to an older build lands on a sane layout instead of an empty panel.
    public static func project(_ state: BottomPanelState) -> (terminal: Bool, problems: Bool, preview: Bool, graph: Bool) {
        (
            terminal: state.isOpen && state.activeTab == .terminal,
            problems: state.isOpen && state.activeTab == .problems,
            preview: state.isOpen && state.activeTab == .preview,
            graph: state.isOpen && state.activeTab == .graph
        )
    }
}

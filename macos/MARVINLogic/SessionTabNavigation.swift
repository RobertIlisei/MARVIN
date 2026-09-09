// SessionTabNavigation — moving between OPEN chat tabs (2026-09-09).
//
// The tab strip could only be navigated by clicking a tab, and once tabs
// overflowed the strip there was no way to reach the ones past the edge
// (user: "we do not have a nav bar through the sessions, the opened ones").
// The editor's file tabs solved the same problem on 2026-08-31; the chat
// strip never got it.
//
// The step rule is the part worth pinning, because the interesting cases are
// all the degenerate ones: an id that is not in the list (a draft the strip
// has not adopted yet), an empty list, and a single tab where every step is a
// no-op. Pure, so tests can state them.

import Foundation

public enum SessionTabNavigation {
    public enum Direction {
        case previous
        case next
    }

    /// The tab a step lands on, or nil when there is nowhere to go.
    ///
    /// Wraps at both ends: with the last tab selected, "next" is the first.
    /// Tab strips wrap everywhere else in macOS, and the alternative — a step
    /// that silently does nothing at the edge — reads as a broken key.
    ///
    /// `current` not being in `tabs` is not an error. A freshly minted draft
    /// is selected before it joins the strip, and a session can be closed from
    /// the Sessions pane while it is on screen. Either way the sensible
    /// landing spot is an end of the list, so stepping still goes somewhere.
    public static func step(
        from current: String?,
        in tabs: [String],
        _ direction: Direction
    ) -> String? {
        guard !tabs.isEmpty else { return nil }
        guard let current, let idx = tabs.firstIndex(of: current) else {
            return direction == .next ? tabs.first : tabs.last
        }
        guard tabs.count > 1 else { return nil }
        let next = direction == .next ? idx + 1 : idx - 1
        if next >= tabs.count { return tabs.first }
        if next < 0 { return tabs.last }
        return tabs[next]
    }
}

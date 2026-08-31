// SidebarCollapse — should the sidebar's content half be showing, given a
// measured width and what it is doing now?
//
// The decision needs HYSTERESIS, and its absence is a real bug rather than a
// polish item. Collapsing changes what the pane renders (rail only), which
// changes the width that gets measured, which can push the measurement back
// across a single threshold and expand it again — which changes the content
// back. One threshold plus a state write on either side of it is a latch
// with no deadband: an oscillator. Every cycle is a fresh SwiftUI update,
// and a split view re-forms its panes and re-sets each hosting view's root
// on every one of those, which is the constraint storm this repo has been
// chasing since 2026-08-29 (~5 per session, and continuous — 100% CPU on the
// main thread — once two sessions were running and updates arrived twice as
// fast).
//
// The deadband is what makes it converge: a width inside [collapse, expand)
// changes nothing, so the measurement that COLLAPSING produces can never by
// itself trigger an expand.
//
// Pure (ADR-0022): this is exactly the logic a unit test can pin and a
// running app cannot.

import CoreGraphics

public enum SidebarCollapse {
    /// Content narrower than this collapses the pane to its rail.
    public static let collapseBelow: CGFloat = 110
    /// Content must reach this much wider before it expands again. The gap
    /// is the deadband; it must exceed any width change that collapsing
    /// itself causes, or the oscillation comes straight back.
    public static let expandAbove: CGFloat = 150
    /// Width of the activity rail, which never counts toward the decision —
    /// the threshold is about how much room the CONTENT has.
    public static let railWidth: CGFloat = 45

    /// The next collapsed state. Returns `collapsed` unchanged inside the
    /// deadband, and for a non-positive width (an unmeasured layout must not
    /// get a vote).
    public static func next(paneWidth: CGFloat, collapsed: Bool) -> Bool {
        guard paneWidth > 0 else { return collapsed }
        let content = paneWidth - railWidth
        if collapsed { return content < expandAbove }
        return content < collapseBelow
    }
}

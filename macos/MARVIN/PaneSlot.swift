// PaneSlot — keep a pane mounted while hiding it.
//
// Extracted verbatim from `LeftPane` (plan §D) so the bottom panel's tabs
// get the same treatment. The comment below is the reason this is not
// `opacity(0)` or an `if/else`, and it is load-bearing — do not "simplify"
// it away:
//
//   Both views are kept in the tree (just one is hidden) so child @State
//   (e.g. selectedPath, fetched response) survives a tab switch. The
//   opacity-based toggle is 60fps-cheap; the alternative — `if/else`
//   swapping — would re-create the view on every flip and lose state.
//
// The zero-frame + `focusable(false)` on the inactive slots is the other
// half, added after a measured regression: with five panes mounted, AppKit's
// focus key-view loop walked every one of them on each layout pass — 150
// invalidations per 0.5 s while dragging the splitter, which is what made
// the resize sluggish. A hidden pane must be zero-sized and out of the focus
// chain, not merely transparent.

import SwiftUI

extension View {
    /// Keep this view mounted (state preserved) but inert and invisible when
    /// `active` is false.
    func keptMounted(active: Bool) -> some View {
        self
            .opacity(active ? 1 : 0)
            .allowsHitTesting(active)
            .frame(width: active ? nil : 0, height: active ? nil : 0)
            .clipped()
            .disabled(!active)
            // `.focusable(false)` unconditionally, not `.focusable(active)`.
            //
            // Two reasons, and the first is visible. Marking the ACTIVE pane
            // focusable makes the whole pane a focus target, so macOS draws
            // its focus ring around the entire pane — the blue outline the
            // user reported (2026-08-31: "sometimes I can see the blue lines
            // of the pane, this is not very professional"). The pane's
            // CONTENTS are focusable on their own; the container never needed
            // to be.
            //
            // The load-bearing half is unchanged: inactive panes must stay out
            // of the focus key-view loop, which is what `disabled(!active)`
            // plus the zero frame achieve. `false` here keeps that and is
            // strictly stronger than the old `active` value.
            .focusable(false)
            .accessibilityHidden(!active)
    }
}

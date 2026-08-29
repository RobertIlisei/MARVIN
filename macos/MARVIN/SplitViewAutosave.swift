// SplitViewAutosave — persist NSSplitView divider positions across
// launches, and ask for the thin divider style.
//
// SwiftUI's HSplitView / VSplitView give no API for either. Both are
// backed by an NSSplitView somewhere up the AppKit hierarchy of any
// child view, so a zero-size NSViewRepresentable placed in a pane's
// `.background` can walk `superview` until it finds it and configure
// it directly. The walk is deferred one runloop tick because the
// hierarchy isn't attached at makeNSView time.
//
// ## What NOT to do here (2026-08-29)
//
// A first attempt at a themed 1pt divider re-classed the live split view
// at runtime (`objc_allocateClassPair` subclass of SwiftUI's private
// NSSplitView subclass, overriding `dividerThickness` / `drawDivider`).
// It crashed the app at launch: the change tripped AppKit's
// update-constraints-loop breaker, and the ADR-0062 crash logger then
// segfaulted in `_typeName` on the re-classed view, which has no Swift
// type metadata. Don't re-class SwiftUI's views. If the system divider
// still looks wrong, the fix is a custom split container, not this.

import AppKit
import SwiftUI

struct SplitViewAutosave: NSViewRepresentable {
    /// NSUserDefaults key under "NSSplitView Subview Frames <name>".
    /// Bump when the split's pane order or count changes — old
    /// frames don't apply to a new layout.
    let name: String

    /// One bit of state per instance: has the walk already found its split
    /// view? Without it `updateNSView` queues a main-queue block on EVERY
    /// SwiftUI update, and a live pane drag produces one update per frame —
    /// hundreds of superview walks that can only ever reach the same answer.
    final class Coordinator {
        var attached = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        let coordinator = context.coordinator
        DispatchQueue.main.async {
            if attach(from: v, name: name) { coordinator.attached = true }
        }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Some SwiftUI redraws rebuild the host views, so the tag can drop off
        // and the walk has to be repeatable — but only until it succeeds.
        guard !context.coordinator.attached else { return }
        let coordinator = context.coordinator
        DispatchQueue.main.async {
            if attach(from: nsView, name: name) { coordinator.attached = true }
        }
    }

    /// Returns `true` once an enclosing `NSSplitView` was found and tagged.
    @discardableResult
    private func attach(from anchor: NSView, name: String) -> Bool {
        var current: NSView? = anchor.superview
        while let view = current {
            if let split = view as? NSSplitView {
                let target = NSSplitView.AutosaveName(name)
                if split.autosaveName != target {
                    split.autosaveName = target
                }
                // Do NOT touch `dividerStyle` here. SwiftUI's split view
                // re-applies its own style on every layout pass; writing
                // `.thin` from this hook (which runs on every SwiftUI
                // update) made the two reset each other — a relayout
                // ping-pong the ADR-0062 storm monitor caught at 150
                // invalidations / 0.5 s in the left pane on every launch
                // (2026-08-29, stack: SplitViewContentProvider →
                // _setDefaultKeyViewLoop → NSHostingView.updateSize →
                // setNeedsUpdate), and which tips AppKit's
                // update-constraints breaker on larger windows. The
                // divider stays whatever SwiftUI draws.
                return true
            }
            current = view.superview
        }
        return false
    }
}

/// Reach the enclosing `NSSplitView` from a SwiftUI subtree and re-open a pane
/// that has been dragged shut.
///
/// The activity rail survives a collapse (that is the point — it is the thing
/// you click to come back), but clicking it only changed the selected tab: the
/// tab was switching behind a zero-width pane. Antigravity re-opens the sidebar
/// on that click, so MARVIN does too.
///
/// SwiftUI exposes no handle on the `NSSplitView` its `HSplitView` is built
/// from, so this walks up from any `NSView` in the pane — the rail's own hit
/// layer, which is already an `NSView` — exactly like `SplitViewAutosave`
/// finds the split view it tags.
enum SplitPaneResizer {
    /// Re-open the pane containing `anchor` if it is currently narrower than
    /// `threshold`. No-op when the pane is already open, so the rail's click
    /// stays a plain tab switch in the normal case.
    static func expandIfCollapsed(
        from anchor: NSView,
        restoreTo width: CGFloat,
        threshold: CGFloat
    ) {
        // The arranged subview is the child of the split view, several hosting
        // layers above the anchor.
        var pane: NSView = anchor
        while let parent = pane.superview {
            if let split = parent as? NSSplitView {
                guard let index = split.arrangedSubviews.firstIndex(of: pane) else { return }
                guard pane.frame.width < threshold else { return }
                // Divider N sits after arranged subview N, so its position IS
                // the trailing edge of that pane — for pane 0 that's its width.
                split.setPosition(width, ofDividerAt: index)
                return
            }
            pane = parent
        }
    }
}

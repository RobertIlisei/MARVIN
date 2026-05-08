// SplitViewAutosave — Phase 5f. Persists SwiftUI HSplitView /
// VSplitView divider positions across launches.
//
// SwiftUI's HSplitView / VSplitView wrap an AppKit `NSSplitView`
// internally, but the public SwiftUI API doesn't expose its
// `autosaveName` — so divider positions reset to the `idealWidth /
// idealHeight` hints on every launch. NSSplitView itself fully
// supports autosave: setting `.autosaveName` writes
// "NSSplitView Subview Frames <name>" to NSUserDefaults on every
// drag, and the next instantiation rehydrates from there.
//
// This helper walks up the AppKit view hierarchy at first paint
// looking for the nearest enclosing NSSplitView and tags it. Drop
// it as a `.background(SplitViewAutosave(...))` on any SwiftUI
// child of the split view; the search hops up through SwiftUI's
// host-view chain until it finds the NSSplitView that owns the
// divider you wanted to persist.
//
// Why a background-injected NSViewRepresentable rather than wrapping
// NSSplitView ourselves: SwiftUI's HSplitView already participates
// in the SwiftUI layout system (Spacer / .frame / .layoutPriority
// all work). Re-implementing in NSViewRepresentable would mean
// shipping a new layout protocol implementation for marginal gain.
//
// One caveat: AppStorage / NSUserDefaults stores per autosave name,
// so changing pane order or count under the same name confuses the
// autosaver — it'll try to apply old subview frames to a new layout
// and silently no-op. Bump the autosave name when you reshape a
// split.

import AppKit
import SwiftUI

struct SplitViewAutosave: NSViewRepresentable {
    /// NSUserDefaults key under "NSSplitView Subview Frames <name>".
    /// Bump when the split's pane order or count changes — old
    /// frames don't apply to a new layout.
    let name: String

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        // Hierarchy isn't attached at makeNSView time; wait one
        // runloop tick so the view is in the SwiftUI host chain
        // and has a `.superview`.
        DispatchQueue.main.async {
            attach(from: v, name: name)
        }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Some SwiftUI redraws rebuild the host views; idempotently
        // re-tag if the autosave name dropped off.
        DispatchQueue.main.async {
            attach(from: nsView, name: name)
        }
    }

    private func attach(from anchor: NSView, name: String) {
        var current: NSView? = anchor.superview
        while let view = current {
            if let split = view as? NSSplitView {
                let target = NSSplitView.AutosaveName(name)
                if split.autosaveName != target {
                    split.autosaveName = target
                }
                return
            }
            current = view.superview
        }
    }
}

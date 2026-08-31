// WidthReporter — measure a view's width without a SwiftUI preference.
//
// ## The loop this exists to break
//
// Measuring with `.background { GeometryReader { …preference… } }` is the
// idiomatic SwiftUI answer and it is a **constraint-storm generator** for
// any view hosted inside an `NSSplitView` pane. The captured stack
// (ADR-0062 monitor, 2026-08-31, 150 invalidations in <0.5 s):
//
//     -[NSView _updateConstraintsForSubtreeIfNeeded…]
//       → NSHostingView._willUpdateConstraintsForSubtree
//         → SizeConstraints.update(from:) → minSize → _sizeThatFits
//           → ViewGraph.sizeThatFits → GraphHost.instantiateIfNeeded
//             → instantiateOutputs → makePreferenceOutlets
//               → PreferenceBridge.addValue → GraphHost.graphInvalidation
//                 → NSHostingView.requestUpdate → setNeedsUpdateConstraints
//
// Read it bottom-up: AppKit asks the hosting view for its minimum size
// during the constraints pass. SwiftUI has to instantiate the view graph to
// answer. **Instantiating creates the preference outlets, and creating them
// invalidates the graph** — which calls `setNeedsUpdateConstraints` on the
// hosting view, re-arming the very pass that asked. It never settles on its
// own; it settles when the invalidation budget runs out.
//
// Note this is a DIFFERENT loop from the one fixed on 2026-08-29, which ran
// through `_recursiveSetDefaultKeyViewLoop` (the focus key-view walk) and
// was fixed by taking inactive panes out of layout. Same symptom, same
// monitor, unrelated cause — which is why that fix did not stop these.
//
// ## Why AppKit instead
//
// An `NSView` knows its own width in `layout()` with no view graph and no
// preferences, so nothing invalidates anything. This is the same "drop to
// AppKit for the thing SwiftUI models badly" move already used by
// `SplitViewAutosave`, `SplitDividerTheme` and `HoverTooltip`.
//
// `onGeometryChange(for:)` expresses this natively and without preferences —
// but it is macOS 15+, and the deployment target is 14.0
// (`macos/project.yml`). Revisit when that floor moves.

import AppKit
import SwiftUI

/// Reports its own width whenever it changes. Place in a `.background`;
/// it draws nothing and imposes no size of its own.
struct WidthReporter: NSViewRepresentable {
    let onChange: (CGFloat) -> Void

    func makeNSView(context: Context) -> WidthReporterView {
        let v = WidthReporterView()
        v.onChange = onChange
        return v
    }

    func updateNSView(_ nsView: WidthReporterView, context: Context) {
        nsView.onChange = onChange
    }
}

final class WidthReporterView: NSView {
    var onChange: ((CGFloat) -> Void)?
    private var lastReported: CGFloat = -1

    override var isFlipped: Bool { true }
    /// Nothing to draw, and nothing for the focus machinery to walk.
    override var acceptsFirstResponder: Bool { false }
    override var isOpaque: Bool { false }

    override func layout() {
        super.layout()
        let width = bounds.width
        // Sub-pixel jitter during a live drag would otherwise publish a new
        // value every frame for a width that has not meaningfully moved.
        guard abs(width - lastReported) > 0.5 else { return }
        lastReported = width

        // Deferred, NOT called inline. `layout()` runs inside AppKit's
        // layout pass; driving SwiftUI @State from there mutates state
        // mid-layout, which is the same class of problem this file exists
        // to remove. One runloop hop puts the state change safely after the
        // pass that produced it.
        let callback = onChange
        DispatchQueue.main.async { callback?(width) }
    }
}

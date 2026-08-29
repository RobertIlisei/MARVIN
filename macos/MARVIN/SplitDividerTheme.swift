// SplitDividerTheme — paint every split-view divider in MarvinTheme.border so
// a drag handle and a hand-drawn hairline are the SAME colour.
//
// ## Three attempts; the first two were guesses, this one is evidence
//
//  1. **Re-class the live split view** (`objc_allocateClassPair` +
//     `object_setClass`, overriding `dividerThickness` / `drawDivider(in:)`).
//     Crashed the app at launch: the synthesised class has no Swift metadata,
//     so the crash logger segfaulted describing it, and re-classing mid-flight
//     tripped AppKit's update-constraints loop breaker.
//  2. **Swizzle `-[NSSplitView drawDivider:]`** on the base class. Safe, but
//     inert — the seams stayed black. A one-shot probe counted the calls:
//     **zero**. Modern AppKit does not draw dividers there at all.
//  3. This. The same probe dumped the hierarchy: each divider is an
//     `NSSplitDividerView` subview (5pt wide for the hit area, `thickness`
//     1.0 painted), and runtime introspection of that class shows it is
//     layer-backed — `wantsUpdateLayer` / `updateLayer` / `_backgroundLayer`
//     — and owns a **`backgroundColor` property** with an ordinary
//     `setBackgroundColor:` setter. So there is nothing to re-draw and nothing
//     to intercept: set the colour AppKit is already going to paint.
//
// `_backgroundLayerFrame` is why this yields a 1pt hairline and not a 5pt
// band — the view is fat so it can be grabbed, but its background layer is
// inset to `effectiveThickness`.
//
// ## Why hook `layout`
//
// `-[NSSplitView _updateDividerViews]` DESTROYS AND REBUILDS its divider views
// (visible in the ADR-0062 constraint-storm stack: `_didAddArrangedSubview:` →
// `_updateDividerViews` → `initWithStyle:orientation:`), so colouring the ones
// that exist at startup would last until the first pane toggle. `layout` is a
// public `NSView` method that `NSSplitDividerView` implements itself, so the
// exchange lands on that class and nowhere else, and it runs for every
// generation of divider view for free. The hook only writes a property — it
// never draws and never invalidates geometry, so it cannot feed the
// constraint loop that attempt 1 tripped.

import AppKit

enum SplitDividerTheme {
    /// Install once, from `applicationDidFinishLaunching`. Guarded rather than
    /// trusted to be called once — a second exchange would undo the first.
    private static var installed = false

    @discardableResult
    static func install() -> Bool {
        guard !installed else { return true }
        guard let dividerClass = NSClassFromString("NSSplitDividerView") else { return false }
        // `layout` must be implemented BY NSSplitDividerView, not inherited:
        // `class_getInstanceMethod` walks the superclass chain, and exchanging
        // an inherited `NSView.layout` would repoint layout for every view in
        // the app. Verified against the class's own method list.
        guard implementsItself(dividerClass, #selector(NSView.layout)),
              let original = class_getInstanceMethod(dividerClass, #selector(NSView.layout)),
              let replacement = class_getInstanceMethod(
                  NSView.self, #selector(NSView.marvin_dividerLayout)
              )
        else { return false }
        method_exchangeImplementations(original, replacement)
        installed = true
        return true
    }

    /// True when `cls` defines `sel` itself rather than inheriting it.
    private static func implementsItself(_ cls: AnyClass, _ sel: Selector) -> Bool {
        var count: UInt32 = 0
        guard let list = class_copyMethodList(cls, &count) else { return false }
        defer { free(list) }
        for i in 0..<Int(count) where method_getName(list[i]) == sel { return true }
        return false
    }
}

extension NSView {
    /// Swizzled counterpart of `-[NSSplitDividerView layout]`.
    ///
    /// Declared on `NSView` because Swift can't extend a private class, and
    /// exchanged against `NSSplitDividerView`'s own `layout` — so this body
    /// only ever runs with `self` being a divider view, and the seemingly
    /// recursive call below is AppKit's original implementation.
    ///
    /// Nothing here touches state that isn't plain `NSView` or KVC, which is
    /// what makes borrowing an `NSView` method slot safe.
    @objc func marvin_dividerLayout() {
        marvin_dividerLayout()  // → the original NSSplitDividerView.layout

        // Write only on a real change: the setter marks the divider for
        // display, and re-marking on every layout pass is how a redraw loop
        // starts.
        let target = MarvinTheme.borderNSColor
        let current = value(forKey: "backgroundColor") as? NSColor
        if current != target {
            setValue(target, forKey: "backgroundColor")
        }
    }
}

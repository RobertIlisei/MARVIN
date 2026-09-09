// ConstraintPassBudget — how many "needs another Update Constraints pass"
// requests one window may make inside a single pass before MARVIN stops
// forwarding them synchronously and defers the rest to the next run-loop turn.
//
// AppKit's own breaker (`-[NSWindow _postWindowNeedsUpdateConstraints]`) raises
// `NSGenericException` once a window has had "more Update Constraints in Window
// passes than there are views in the window", and on the layout path it goes
// straight to `+[NSApplication _crashOnException:]` — fatal, and NOT covered by
// `NSApplicationCrashOnExceptions = NO` (ADR-0062). Every request for another
// pass funnels through `-[NSView setNeedsUpdateConstraints:]`, which MARVIN
// already swizzles, so the count can be capped BELOW AppKit's limit and the
// overflow re-requested a turn later, when the counter has reset.
//
// The allowance sits a margin under the view count because a pass may be
// requested by several transitions at once (passes ≤ transitions) and the
// exact point AppKit counts from is not documented. The floor keeps a tiny
// window from deferring its first few legitimate requests.
//
// Pure (ADR-0022): the policy is the part a test can pin; the swizzle that
// applies it lives in `CrashDiagnostics.swift`.

public enum ConstraintPassBudget {
    /// Headroom kept under AppKit's "one pass per view" limit.
    public static let margin = 16
    /// Never defer inside this many transitions, however small the window.
    public static let floor = 16

    /// Transitions to "needs update" that one window may make inside a pass
    /// before further ones are deferred.
    public static func allowance(viewsInWindow: Int) -> Int {
        max(floor, viewsInWindow - margin)
    }

    /// True when the `transitionsInPass`-th transition should be deferred.
    public static func shouldDefer(transitionsInPass: Int, viewsInWindow: Int) -> Bool {
        transitionsInPass > allowance(viewsInWindow: viewsInWindow)
    }
}

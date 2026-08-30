// BenignCancellation — "the request was cancelled" is not an error to show.
//
// `Task.cancel()` on a URLSession call surfaces as `URLError(.cancelled)`
// (NSURLErrorDomain −999), NOT as Swift's `CancellationError`. Views that
// caught only the latter rendered a red banner full of NSError internals
// whenever a refresh raced a previous request — which the ADR-0077 file-tree
// auto-refresh made routine: FSEvents fires, the in-flight tree fetch is
// cancelled, and the user sees "Fetch error … Code=-999 'cancelled'" for
// something that worked (user, 2026-08-30).
//
// Pure (ADR-0022) so the classification is test-pinned rather than repeated
// as an ad-hoc `catch` in every service.

import Foundation

public enum BenignCancellation {
    /// How many wrapper layers to descend before giving up. Errors nest two
    /// deep in practice (`FilesServiceError.transport(underlying:)` holding a
    /// `URLError`); the cap only exists so a pathological payload can't walk
    /// an unbounded object graph.
    private static let maxDepth = 4

    /// True when `error` means "this work was deliberately abandoned" rather
    /// than "this work failed". Callers should stay silent on these.
    public static func matches(_ error: Error) -> Bool {
        matches(error, depth: 0)
    }

    private static func matches(_ error: Error, depth: Int) -> Bool {
        if error is CancellationError { return true }
        if let url = error as? URLError { return url.code == .cancelled }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return true }
        if ns.domain == NSCocoaErrorDomain, ns.code == NSUserCancelledError { return true }
        // Foundation's own nesting: URLSession puts the real NSError under
        // NSUnderlyingError when it wraps one.
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            return matches(underlying, depth: depth + 1)
        }
        guard depth < maxDepth else { return false }
        // Our nesting: the services throw Swift enums that carry the transport
        // failure as an associated value — `FilesServiceError.transport(
        // underlying:)`, `ChatServiceError.transport(underlying:)`. Bridging one
        // of those to NSError gives an EMPTY userInfo, so the NSUnderlyingError
        // hop above cannot see the −999 inside it. That is exactly how the
        // banner survived the first version of this guard (user, 2026-08-30):
        // the fix was written against a hand-built NSError, a shape the app
        // never produces. Reflection reads the real one.
        return containsBenignError(in: error, depth: depth)
    }

    /// Walk associated values looking for a nested benign error.
    ///
    /// `Mirror` on `case transport(underlying: Error)` does NOT hand back the
    /// Error directly — the enum's single child is the *payload tuple*
    /// `(underlying: Error)`, and the Error sits one level inside that. So a
    /// non-Error child is descended into rather than skipped.
    private static func containsBenignError(in subject: Any, depth: Int) -> Bool {
        guard depth < maxDepth else { return false }
        for child in Mirror(reflecting: subject).children {
            if let inner = child.value as? Error {
                if matches(inner, depth: depth + 1) { return true }
            } else if containsBenignError(in: child.value, depth: depth + 1) {
                return true
            }
        }
        return false
    }
}

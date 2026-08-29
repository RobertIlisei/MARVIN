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
    /// True when `error` means "this work was deliberately abandoned" rather
    /// than "this work failed". Callers should stay silent on these.
    public static func matches(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let url = error as? URLError { return url.code == .cancelled }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return true }
        if ns.domain == "NSCocoaErrorDomain", ns.code == NSUserCancelledError { return true }
        // A wrapped transport failure: URLSession nests the real NSError under
        // NSUnderlyingError, which is how the −999 above reached the UI as a
        // `transport(underlying:)` case rather than a bare URLError.
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            return matches(underlying)
        }
        return false
    }
}

// ReplayBanner — which turn error, if any, a hydrated session should still
// show in its error banner (ADR-0107 addendum 4).
//
// `replay(record:)` walks a transcript in order and used to assign the
// banner from EVERY `turn.error` it passed, with nothing clearing it: a
// failure from hours ago re-appeared on every switch into that session,
// including while a newer turn was streaming underneath it. Only an error
// that is still the LAST terminal event is true; a later start or
// completion supersedes it.
//
// An INTERRUPTED turn is excluded on purpose: it has its own affordance
// (the "cut off before it finished" chip with Resume), and two banners
// saying the same thing in different words is what the user saw.

import Foundation

public enum ReplayBanner {
    /// The terminal events of a replayed transcript, in order.
    public enum Terminal: Equatable, Sendable {
        case started
        case completed
        /// `interrupted` marks a turn the sidecar cut off (app quit / restart).
        case error(message: String, interrupted: Bool)
    }

    /// The banner text a hydrate should leave behind, or nil for none.
    public static func trailing(_ events: [Terminal]) -> String? {
        var banner: String?
        for e in events {
            switch e {
            case .started, .completed:
                banner = nil
            case let .error(message, interrupted):
                banner = interrupted ? nil : message
            }
        }
        return banner
    }
}

// SessionFinishedReview — "finished, not yet reviewed" (UX review W-08).
//
// A tab whose turn ended used to fold into the idle group 30 seconds later,
// so the moment the owner has to act (review, merge) was the quietest event
// in the app. A turn that ended is "unreviewed" until the person has looked at
// the tab, and only then does it follow the ordinary idle/collapse rules.

import Foundation

public enum FinishedReview {
    /// True when the last turn ended after the person last looked at the tab
    /// AND after `baseline`.
    ///
    /// `baseline` is when this rule first ran for the project. Without it the
    /// first launch of the build that introduced the rule would put every tab
    /// that ever finished into "Finished" at once, asking for fourteen reviews
    /// of work the owner already dealt with. A turn with no end time makes no
    /// claim either way.
    public static func isUnreviewed(lastTurnAt: Date?, reviewedAt: Date?, baseline: Date) -> Bool {
        guard let ended = lastTurnAt, ended > baseline else { return false }
        guard let reviewed = reviewedAt else { return true }
        return ended > reviewed
    }
}

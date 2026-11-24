// SessionDisplayName — the ONE name a session has, on every surface that
// prints one (UX review round 2, R2-02).
//
// On 2026-11-24 the same tab was "B53A" in the tab strip, "briefs/v31/b53a-
// security-hardening-lef…" in the Sessions pane and "B53a B53a: v3.1 batch from
// the backlog…" in the overflow list, because three places each derived a name
// from a different field. The tab strip's name is the one the owner already
// says out loud ("the B53 tab"), so it is the rule: what the tab was opened
// with, run through `SessionTabTitle.display`. The sidecar's `title` is only
// the fallback (it is often the path of the brief the tab was started from),
// then the branch, then the first characters of the id.
//
// Every caller passes what it has; none of them re-implements the order.

import Foundation

public enum SessionDisplayName {
    /// The longest a name is before it is cut. Matches the tab strip's own cut,
    /// so a name cut in one place is cut at the same word in another.
    public static let maxLength = 40

    public static func make(id: String, isDraft: Bool, firstMessage: String?, title: String?, branch: String?) -> String {
        if isDraft { return "New chat" }
        for source in [firstMessage, title] {
            guard let raw = source else { continue }
            // The same preparation the tab strip applies: lines joined, `@/path`
            // attachment mentions dropped, then the short title.
            let flat = SessionTitle.stripAttachmentMentions(raw.replacingOccurrences(of: "\n", with: " "))
            let short = SessionTabTitle.display(flat, maxLength: maxLength)
            if !short.isEmpty { return short }
        }
        if let branch, branch.hasPrefix("marvin/tab/") { return SessionTitle.humanised(branch: branch) }
        return String(id.prefix(8))
    }
}

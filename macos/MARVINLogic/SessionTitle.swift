// SessionTitle — how a tab is named from what was typed (ADR-0111).
//
// A tab that opened with an attachment used to be titled by the attachment's
// path (`@/Users/…/attachments/6B57DF3`), which names nothing. The words
// after the mention are the title; when there are none, the caller falls
// back to the branch name, which after ADR-0111 is the first commit subject.

import Foundation

public enum SessionTitle {
    /// Drop `@/abs/path` and `@~/path` attachment mentions.
    public static func stripAttachmentMentions(_ text: String) -> String {
        text.split(separator: " ")
            .filter { !$0.hasPrefix("@/") && !$0.hasPrefix("@~/") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    /// `marvin/tab/fix-the-thing` → "fix the thing"; any other branch unchanged.
    public static func humanised(branch: String) -> String {
        let prefix = "marvin/tab/"
        guard branch.hasPrefix(prefix) else { return branch }
        return String(branch.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: " ")
    }
}

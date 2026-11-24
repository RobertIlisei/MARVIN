// ConfirmSheetText — what a tool-confirm surface says about WHO is asking
// (UX review N-02).
//
// With many tabs on many branches, a prompt that said only "MARVIN wants to use
// a tool" and "Bash" gave no hint which worktree the command would run in. The
// other half of N-02, "Return means Allow", was already fixed for the tray card
// (audit C8, ADR-0112 amendment: Allow is ⌘⏎); this change brings the older
// sheet in line with it.

import Foundation

public enum ConfirmSheetText {
    /// "Tab “fix login” · marvin/tab/fix-login", or just one half, or nil.
    public static func askedBy(tabTitle: String?, branch: String?) -> String? {
        let title = tabTitle?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) ?? ""
        let branch = branch?.trimmingCharacters(in: .whitespaces) ?? ""
        let shownTitle = title.count > 60 ? String(title.prefix(59)) + "\u{2026}" : title
        switch (shownTitle.isEmpty, branch.isEmpty) {
        case (true, true): return nil
        case (true, false): return "Branch \(branch)"
        case (false, true): return "Tab \u{201C}\(shownTitle)\u{201D}"
        case (false, false): return "Tab \u{201C}\(shownTitle)\u{201D} \u{B7} \(branch)"
        }
    }
}

// SourceControlConfirmText — what the pane says before it does something it
// cannot take back, or something that touches every tab.
//
// Every one of these names WHERE it acts and WHAT cannot be undone, because the
// pane can now show a tab's own tree while the project-level actions act on the
// project: "Discard 3 files" alone would no longer say which tree loses them.
// The same sentence is used by the pane's own dialogs (merge all, sweep, drop)
// and handed to the git confirm sheet for the guarded mutations (discard,
// force-push), so one act reads the same wherever the person is asked.
//
// Pure (ADR-0022).

import Foundation

public struct SourceControlConfirmText: Equatable, Sendable {
    public let title: String
    public let message: String
    public let confirmLabel: String

    private static func files(_ n: Int) -> String { n == 1 ? "1 file" : "\(n) files" }

    /// - Parameter target: `SourceControlTarget.actionPhrase` — "in tab X (branch)".
    public static func discard(count: Int, untracked: Bool, target: String) -> SourceControlConfirmText {
        if untracked {
            return SourceControlConfirmText(
                title: "Delete \(count == 1 ? "1 untracked file" : "\(count) untracked files") \(target)?",
                message: "They were never committed, so git has no copy anywhere. This cannot be undone.",
                confirmLabel: "Delete \(files(count))")
        }
        return SourceControlConfirmText(
            title: "Discard \(files(count)) \(target)?",
            message: "\(count == 1 ? "The file goes" : "The files go") back to the last commit or the staged version. This cannot be undone.",
            confirmLabel: "Discard \(files(count))")
    }

    public static func mergeAll(readyCount: Int, targetBranch: String?) -> SourceControlConfirmText {
        let into = targetBranch ?? "the current branch"
        return SourceControlConfirmText(
            title: "Merge \(readyCount) finished branches into \(into)?",
            message: "Nothing is pushed. The branches are folded into \(into) in the project checkout, oldest first, and it stops at the first conflict. Undoing a merge means resetting that branch yourself.",
            confirmLabel: "Merge \(readyCount) branches")
    }

    public static func sweep(spentCount: Int) -> SourceControlConfirmText {
        let one = spentCount == 1
        return SourceControlConfirmText(
            title: "Remove \(spentCount) spent checkout\(one ? "" : "s") and \(one ? "its" : "their") branch\(one ? "" : "es")?",
            message: "Only branches that are empty or already merged, with nothing uncommitted. Unmerged work and uncommitted changes are never touched. A removed branch cannot be brought back from this app.",
            confirmLabel: "Remove \(spentCount) checkout\(one ? "" : "s")")
    }

    public static func dropCheckout(branch: String) -> SourceControlConfirmText {
        SourceControlConfirmText(
            title: "Remove the checkout of \(branch)?",
            message: "The branch stays, so no commit is lost; only the folder on disk is removed. It is offered only when the folder holds no uncommitted work.",
            confirmLabel: "Remove checkout")
    }
}

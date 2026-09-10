// TabCloseDecision — what closing a tab should do with its worktree
// (ADR-0107, remade under ADR-0111).
//
// Pure. The principle: nothing survives a tab unless it holds a commit. A
// tree with nothing in it is discarded without asking — Anthropic's own rule
// for an unnamed worktree session, and ADR-0103's for an empty implementer
// tree. A tree that holds work is never touched without an explicit choice,
// and a running turn is stopped before any of that is even asked.
//
// The inputs are the sidecar's DERIVED state (`SessionWatchRowWire.Worktree`),
// fetched at the moment of closing. Before ADR-0111 the decision was made
// from files-changed and untracked-count standing in for commits and dirty,
// with the state unknown — so a merged tree was never recognised as one and
// the silent path sent `keep`, which is exactly how sixteen closed tabs left
// sixteen checkouts on disk.

import Foundation

public enum TabCloseDecision {
    public enum Action: String, Equatable, Sendable {
        /// Keep the branch for integration (Merge all / Prepare MR). On a
        /// dirty tree the work is committed first, so nothing kept is lost.
        case keepBranch = "keep"
        /// Fold the branch into the NAMED current branch of the main checkout, locally.
        case merge
        /// Remove checkout and branch.
        case discard
    }

    public enum Outcome: Equatable, Sendable {
        /// Shared tab, draft, or no worktree: just close.
        case closeNow
        /// Isolated and holding nothing (no commits and clean, or already
        /// merged and clean): discard without asking.
        case reclaimSilently
        /// A turn is running: ask to stop it before anything else.
        case stopTurnFirst
        /// Offer these actions in this order (first is the default); `note` names what is at stake.
        case offer([Action], note: String)
    }

    /// - Parameters:
    ///   - isLive: the tab has a turn in flight.
    ///   - mode: the tab's tree mode.
    ///   - worktree: the sidecar's derived state, when known. nil with `mode == .worktree`
    ///     means the tab has no tree yet (no first message) — nothing to decide.
    ///   - target: the main checkout's current branch, named in the merge option.
    public static func decide(
        isLive: Bool,
        mode: SessionMode,
        worktree: SessionWatchRowWire.Worktree?,
        target: String?
    ) -> Outcome {
        if isLive { return .stopTurnFirst }
        guard mode == .worktree, let w = worktree else { return .closeNow }
        let name = w.branch
        let onto = target ?? "your current branch"
        let hasCommits = w.commits > 0

        if w.state == "merged" {
            if w.dirty {
                return .offer([.keepBranch, .discard],
                              note: "\(name) is already merged into \(w.mergedInto ?? onto) but has uncommitted changes. Keep commits them onto the branch; discard throws them away.")
            }
            return .reclaimSilently
        }
        if !hasCommits && !w.dirty {
            return .reclaimSilently
        }
        if !hasCommits {
            return .offer([.keepBranch, .discard],
                          note: "\(name) has uncommitted changes and no commits yet. Keep commits them as work in progress; discard throws them away.")
        }
        if w.dirty {
            return .offer([.keepBranch, .merge, .discard],
                          note: "\(name) has \(w.commits) commit\(w.commits == 1 ? "" : "s") and uncommitted changes. Keep commits everything for integration later; merge folds it into \(onto) locally; discard deletes the branch.")
        }
        return .offer([.keepBranch, .merge, .discard],
                      note: "\(name) has \(w.commits) commit\(w.commits == 1 ? "" : "s"). Keep leaves it for Merge all / Prepare MR; merge folds it into \(onto) locally (never pushed); discard deletes the branch.")
    }
}

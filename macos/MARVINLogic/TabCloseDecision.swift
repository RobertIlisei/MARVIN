// TabCloseDecision — what closing a tab should do with its worktree (ADR-0107).
//
// Pure. The outcomes mirror ADR-0103's reclaim rules: a tree that holds
// nothing is reclaimed silently, a tree that holds work is never touched
// without an explicit choice, and a running turn is stopped before any of
// that is even asked.

public enum TabCloseDecision {
    public enum Action: String, Equatable, Sendable {
        case merge
        case keepBranch = "keep"
        case discard
    }

    public enum Outcome: Equatable, Sendable {
        /// Shared tab, draft, or no worktree: just close.
        case closeNow
        /// Isolated, empty and clean: reclaim without asking (ADR-0103's own rule).
        case reclaimSilently
        /// A turn is running: ask to stop it before anything else.
        case stopTurnFirst
        /// Offer these actions; `note` names what is at stake.
        case offer([Action], note: String)
    }

    /// - Parameters:
    ///   - isLive: the tab has a turn in flight.
    ///   - mode: the tab's tree mode.
    ///   - hasWorktree: a worktree record exists for the tab.
    ///   - worktreeState: the sidecar's derived state (`session`, `ready`, `empty`, `merged`) when known.
    ///   - commits: commits on the branch beyond its base, when known.
    ///   - dirty: uncommitted changes in the worktree, when known.
    ///   - branch: for the note.
    public static func decide(
        isLive: Bool,
        mode: SessionMode,
        hasWorktree: Bool,
        worktreeState: String?,
        commits: Int?,
        dirty: Bool?,
        branch: String?
    ) -> Outcome {
        if isLive { return .stopTurnFirst }
        guard mode == .worktree, hasWorktree else { return .closeNow }
        let name = branch ?? "its branch"
        let hasCommits = (commits ?? 0) > 0
        let isDirty = dirty ?? false
        if worktreeState == "merged" {
            return .offer([.keepBranch, .discard], note: "\(name) is already merged; discard removes the leftover branch.")
        }
        if !hasCommits && !isDirty {
            return .reclaimSilently
        }
        if !hasCommits && isDirty {
            return .offer([.merge, .keepBranch, .discard], note: "\(name) has uncommitted changes and no commits yet. Merge commits them first; discard throws them away.")
        }
        if isDirty {
            return .offer([.merge, .keepBranch, .discard], note: "\(name) has commits and uncommitted changes. Merge commits everything and folds it into your branch; keep leaves the branch for later; discard deletes it.")
        }
        return .offer([.merge, .keepBranch, .discard], note: "\(name) has commits. Merge folds them into your branch locally (never pushed); keep leaves the branch for later; discard deletes it.")
    }
}

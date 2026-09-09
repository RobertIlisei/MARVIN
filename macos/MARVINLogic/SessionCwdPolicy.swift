// SessionCwdPolicy — which directory a tab's turn runs in (ADR-0107).
//
// Pure, because the wrong answer here is the incident this feature exists to
// prevent: a tab that believes it is isolated running in the shared
// checkout. Every branch is a distinct, testable outcome — including the two
// that must never silently fall back to the project root.

public enum SessionCwdPolicy {
    public enum Resolution: Equatable, Sendable {
        /// Run here.
        case cwd(String)
        /// Isolated tab with no worktree yet — create one before sending.
        case needsWorktree
        /// Isolated tab whose checkout is gone — ask, never run in the main tree.
        case worktreeMissing(branch: String)
        /// No project is open.
        case noProject
    }

    /// - Parameters:
    ///   - mode: the tab's tree mode.
    ///   - tree: what the sidecar reported for it (path, branch); nil when unknown.
    ///   - present: whether the worktree checkout exists on disk; nil when unknown.
    ///   - projectWorkDir: the project root.
    ///   - override: an explicit cwd from the caller (an editor action) — wins when non-empty.
    public static func resolve(
        mode: SessionMode,
        tree: SessionTreeWire?,
        present: Bool?,
        projectWorkDir: String?,
        override: String? = nil
    ) -> Resolution {
        if let override, !override.isEmpty { return .cwd(override) }
        guard let root = projectWorkDir, !root.isEmpty else { return .noProject }
        switch mode {
        case .shared:
            return .cwd(root)
        case .worktree:
            guard let tree, tree.mode == .worktree, let path = tree.path, !path.isEmpty else {
                return .needsWorktree
            }
            if present == false { return .worktreeMissing(branch: tree.branch ?? path) }
            return .cwd(path)
        }
    }
}

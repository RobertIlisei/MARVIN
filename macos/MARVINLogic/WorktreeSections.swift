// WorktreeSections — the Source Control pane's project scope: every tab's
// branch, grouped by what a person does next, with the one action each row
// offers and the ones it keeps in a menu.
//
// The states come from the sidecar and are derived from git on every read
// (ADR-0103): running, ready, merged, empty, and `session` while a chat tab
// holds the tree (ADR-0107). This file decides how they are grouped and what
// may be offered — in particular that a checkout is never offered for removal
// while a tab or a build is using it (a `session` tree is decided at tab close,
// ADR-0109) — so those decisions can be asserted.
//
// Pure (ADR-0022).

import Foundation

/// A worktree as this file needs it. The app's `WorktreeEntry` maps onto it.
public struct WorktreeLine: Equatable, Sendable {
    public let slug: String
    public let branch: String
    public let task: String
    public let state: String
    public let commits: Int
    public let filesChanged: Int
    public let dirty: Bool
    public let checkoutPresent: Bool
    public let mergedInto: String?
    public let lastCommitAt: String?
    public let added: Int?
    public let removed: Int?

    public init(
        slug: String, branch: String, task: String, state: String, commits: Int, filesChanged: Int,
        dirty: Bool, checkoutPresent: Bool, mergedInto: String?, lastCommitAt: String?, added: Int?, removed: Int?
    ) {
        self.slug = slug
        self.branch = branch
        self.task = task
        self.state = state
        self.commits = commits
        self.filesChanged = filesChanged
        self.dirty = dirty
        self.checkoutPresent = checkoutPresent
        self.mergedInto = mergedInto
        self.lastCommitAt = lastCommitAt
        self.added = added
        self.removed = removed
    }

    /// Nothing to lose: empty or merged with nothing uncommitted.
    var isSpent: Bool { (state == "empty" || state == "merged") && !dirty }
}

public enum WorktreeRowAction: Equatable, Sendable {
    case none, merge, viewChanges
    case copyBranch, copyReviewCommand, reveal, dropCheckout
}

public struct WorktreeSection: Equatable, Identifiable, Sendable {
    public struct Row: Equatable, Identifiable, Sendable {
        public var id: String { slug }
        public let slug: String
        public let branch: String
        public let title: String
        public let subtitle: String
        public let state: String
        /// The one visible action, or `.none`.
        public let primary: WorktreeRowAction
        /// Everything else, in menu order.
        public let menu: [WorktreeRowAction]
    }

    public let id: String
    public let title: String
    public let rows: [Row]
    public let collapsedByDefault: Bool
    public var count: Int { rows.count }
}

public struct WorktreeIntegration: Equatable, Sendable {
    public let readyCount: Int
    public let spentCount: Int
    /// Merge all is for more than one: a single branch has its own Merge.
    public var canMergeAll: Bool { readyCount > 1 }
    public var canPrepareMR: Bool { readyCount > 0 }
    public var canSweep: Bool { spentCount > 0 }
    public var any: Bool { canMergeAll || canPrepareMR || canSweep }
}

public enum WorktreeSections {
    public static func make(_ lines: [WorktreeLine]) -> [WorktreeSection] {
        func section(_ id: String) -> String {
            switch id {
            case "ready": return "Ready to merge"
            case "building": return "Building"
            case "tabs": return "Open tabs"
            default: return "Merged or empty"
            }
        }
        func bucket(_ l: WorktreeLine) -> String {
            switch l.state {
            case "ready": return "ready"
            case "session": return "tabs"
            case "merged", "empty": return l.isSpent ? "spent" : "building"
            default: return "building"
            }
        }
        var by: [String: [WorktreeLine]] = [:]
        for l in lines { by[bucket(l), default: []].append(l) }
        return ["ready", "building", "tabs", "spent"].compactMap { id in
            guard let group = by[id], !group.isEmpty else { return nil }
            let sorted = group.sorted {
                let a = $0.lastCommitAt ?? "", b = $1.lastCommitAt ?? ""
                return a != b ? a > b : $0.slug < $1.slug
            }
            return WorktreeSection(id: id, title: section(id), rows: sorted.map(row), collapsedByDefault: id == "spent")
        }
    }

    private static func row(_ l: WorktreeLine) -> WorktreeSection.Row {
        let task = l.task.trimmingCharacters(in: .whitespacesAndNewlines)
        let primary: WorktreeRowAction = l.state == "ready" ? .merge
            : ((l.state == "session" || l.state == "running") && l.checkoutPresent ? .viewChanges : .none)
        var menu: [WorktreeRowAction] = []
        if l.checkoutPresent && primary != .viewChanges { menu.append(.viewChanges) }
        menu.append(.copyBranch)
        if l.commits > 0 { menu.append(.copyReviewCommand) }
        if l.checkoutPresent { menu.append(.reveal) }
        // Never while a tab or a build is using the tree, and never with work in it.
        if l.checkoutPresent, l.state != "session", l.state != "running", !l.dirty { menu.append(.dropCheckout) }
        return WorktreeSection.Row(
            slug: l.slug, branch: l.branch, title: task.isEmpty ? l.branch : task,
            subtitle: subtitle(l), state: l.state, primary: primary, menu: menu)
    }

    private static func subtitle(_ l: WorktreeLine) -> String {
        let base: String
        switch l.state {
        case "running": base = "building…"
        case "empty": base = l.dirty ? "no commits, uncommitted work" : "no commits"
        case "merged": base = "merged into \(l.mergedInto ?? "another branch")"
        default: base = "\(plural(l.commits, "commit")), \(plural(l.filesChanged, "file"))"
        }
        if let a = l.added, let r = l.removed, a + r > 0 { return "\(base) · +\(a) \u{2212}\(r)" }
        return base
    }

    private static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

    public static func summary(_ lines: [WorktreeLine]) -> String {
        if lines.isEmpty { return "No worktrees" }
        let s = make(lines)
        func n(_ id: String) -> Int { s.first { $0.id == id }?.count ?? 0 }
        var parts: [String] = []
        if n("ready") > 0 { parts.append("\(n("ready")) ready") }
        if n("building") > 0 { parts.append("\(n("building")) building") }
        if n("tabs") > 0 { parts.append("\(n("tabs")) open tab\(n("tabs") == 1 ? "" : "s")") }
        if n("spent") > 0 { parts.append("\(n("spent")) spent") }
        return parts.joined(separator: " · ")
    }

    public static func integration(_ lines: [WorktreeLine]) -> WorktreeIntegration {
        WorktreeIntegration(
            readyCount: lines.filter { $0.state == "ready" }.count,
            spentCount: lines.filter(\.isSpent).count)
    }
}

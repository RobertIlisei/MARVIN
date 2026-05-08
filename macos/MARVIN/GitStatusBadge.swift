// GitStatusBadge — translate `git status --porcelain=v1` codes into
// FileTreeView badges. The bridge holds the raw `[absPath: code]`
// map (populated by BranchService); this enum collapses the set of
// codes into a small palette of categories the UI cares about:
//
//   • Modified — yellow "M" badge
//   • Added — green "A" badge
//   • Deleted — red "D" badge (file may not be visible in the tree
//     anymore but if a row references it, mark it)
//   • Untracked — green "U" badge
//   • Renamed — purple "R" badge
//   • Conflicted — red "!" badge
//   • Other — neutral "·" dot for any unrecognised code
//
// Directory rows show a tint dot (no letter) when any descendant
// path matches an entry in dirtyStatus. The colour is the highest-
// severity category found among descendants — modified beats
// untracked, conflicted beats both. This mirrors VS Code / Cursor's
// "any dirty descendant" indicator.

import SwiftUI

indirect enum GitStatusBadge: Equatable {
    case modified
    case added
    case deleted
    case untracked
    case renamed
    case conflicted
    case other
    /// Roll-up dot for a directory whose descendant has the given
    /// status. The associated payload is the most-severe category
    /// found below this directory.
    case directoryRollup(GitStatusBadge)

    var label: String {
        switch self {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        case .untracked: return "U"
        case .renamed: return "R"
        case .conflicted: return "!"
        case .other: return "·"
        case .directoryRollup: return "•"
        }
    }

    var colour: Color {
        switch self {
        case .modified, .renamed: return .orange
        case .added, .untracked: return .green
        case .deleted, .conflicted: return .red
        case .other: return .gray
        case .directoryRollup(let inner): return inner.colour
        }
    }

    var tooltip: String {
        switch self {
        case .modified: return "Modified"
        case .added: return "Added"
        case .deleted: return "Deleted"
        case .untracked: return "Untracked"
        case .renamed: return "Renamed"
        case .conflicted: return "Conflicted — resolve before committing"
        case .other: return "Changed"
        case .directoryRollup(let inner): return "Contains \(inner.tooltip.lowercased()) files"
        }
    }

    /// Severity ordering for directory roll-up (higher wins).
    /// Conflicted is the highest because the user MUST act on it
    /// before any commit can land; deleted is next; modified above
    /// untracked because changes to tracked files matter more than
    /// new noise; added/renamed roughly mid-tier; "other" lowest.
    private var severity: Int {
        switch self {
        case .conflicted: return 6
        case .deleted: return 5
        case .modified, .renamed: return 4
        case .added: return 3
        case .untracked: return 2
        case .other: return 1
        case .directoryRollup(let inner): return inner.severity
        }
    }

    /// Map a porcelain code (XY pair, trimmed by the server, e.g.
    /// "M", " M", "MM", "??", "A ", "R ", " D", "AA", "UU", etc.)
    /// to a category. The decision is "what's the most useful
    /// thing to show in the badge"; we collapse staged/unstaged/
    /// both-modified into a single "modified" category to keep the
    /// palette small.
    static func category(forCode code: String) -> GitStatusBadge {
        let trimmed = code.trimmingCharacters(in: .whitespaces)
        if trimmed == "??" { return .untracked }
        // Conflicted: any of the AA / DD / UU pairs, or any "U" in
        // either column (UD, DU, AU, UA — unmerged paths).
        if trimmed == "AA" || trimmed == "DD" || trimmed == "UU" { return .conflicted }
        if trimmed.contains("U") { return .conflicted }
        // Renamed: R appears in either column.
        if trimmed.contains("R") { return .renamed }
        // Deleted: D in either column.
        if trimmed.contains("D") { return .deleted }
        // Added: A in either column (and not already classified
        // above as renamed/deleted).
        if trimmed.contains("A") { return .added }
        // Modified: M in either column.
        if trimmed.contains("M") { return .modified }
        return .other
    }

    /// Resolve the badge for a tree node. Files: direct lookup in
    /// `dirtyStatus`. Directories: scan the map for any descendant.
    @MainActor
    static func resolve(for node: FileNode, bridge: MarvinBridge) -> GitStatusBadge? {
        let map = bridge.dirtyStatus
        if map.isEmpty { return nil }
        if !node.isDirectory {
            if let code = map[node.path] {
                return category(forCode: code)
            }
            return nil
        }
        // Directory: scan for any descendant. Use the absolute path
        // prefix with a trailing slash so a directory `/foo/bar`
        // doesn't match a sibling file `/foo/barbaz.txt`.
        let prefix = node.path.hasSuffix("/") ? node.path : node.path + "/"
        var bestSeverity = -1
        var best: GitStatusBadge = .other
        for (path, code) in map {
            guard path.hasPrefix(prefix) else { continue }
            let cat = category(forCode: code)
            if cat.severity > bestSeverity {
                bestSeverity = cat.severity
                best = cat
            }
        }
        return bestSeverity >= 0 ? .directoryRollup(best) : nil
    }
}

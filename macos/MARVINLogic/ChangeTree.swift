// ChangeTree — the Source Control pane's list of changed files, as a tree.
//
// A hundred changed files in one flat list was the complaint ("Commit 100"
// over a scroll of rows). What a person needs at that size is the shape of the
// change — which directories, how many files each — and the ability to open one
// directory, filter to a name, and walk the list with the arrow keys. This is
// that, as values: the view draws it and holds no rule of its own.
//
// Rules worth knowing:
//   - Four groups, in the order work flows: merge conflicts (nothing commits
//     until they are resolved), staged, changes, untracked. A half-staged file
//     is in both Staged and Changes — that is `git status`'s two-column truth.
//   - A group of more than `autoCollapseAbove` files opens with its directories
//     closed (counts only); a smaller one opens fully. A person's own toggle
//     (`overrides`) beats the default in both directions.
//   - A directory chain with no files of its own and one child is one row
//     (`Sources/App/Services`), the way a source list reads.
//   - A filter wins over every collapse: what matches is shown.
//
// Pure (ADR-0022).

import Foundation

public enum ChangeGroup: String, CaseIterable, Sendable {
    case conflicts, staged, changes, untracked

    public var title: String {
        switch self {
        case .conflicts: return "Merge conflicts"
        case .staged: return "Staged"
        case .changes: return "Changes"
        case .untracked: return "Untracked"
        }
    }
}

/// One line of porcelain status, as the git route returns it.
public struct RawChange: Equatable, Sendable {
    public let path: String
    public let indexStatus: String
    public let workingStatus: String
    public let entryType: String
    public let renamedFrom: String?

    public init(path: String, indexStatus: String, workingStatus: String, entryType: String, renamedFrom: String?) {
        self.path = path
        self.indexStatus = indexStatus
        self.workingStatus = workingStatus
        self.entryType = entryType
        self.renamedFrom = renamedFrom
    }
}

public struct ChangeItem: Equatable, Hashable, Sendable {
    /// Relative to the tree's root.
    public let path: String
    public let group: ChangeGroup
    /// The status letter this group cares about: the index column for Staged,
    /// the working column for Changes.
    public let code: String
    public let entryType: String
    public let renamedFrom: String?

    public init(path: String, group: ChangeGroup, code: String, entryType: String, renamedFrom: String?) {
        self.path = path
        self.group = group
        self.code = code
        self.entryType = entryType
        self.renamedFrom = renamedFrom
    }
}

public struct ChangeTreeRow: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable { case group, directory, file }

    public let id: String
    public let kind: Kind
    public let group: ChangeGroup
    /// The full relative path of a directory or file; "" for a group.
    public let path: String
    /// What the row prints: the joined chain for a directory, the file name for
    /// a file, the title for a group.
    public let name: String
    public let depth: Int
    /// Files under a directory or in a group.
    public let count: Int
    public let collapsed: Bool
    public let item: ChangeItem?
}

public enum ChangeTreeKey: Equatable, Sendable { case up, down, left, right, home, end }

public enum ChangeTreeMove: Equatable, Sendable {
    case select(String)
    case toggle(id: String, collapse: Bool)
    case none
}

public enum ChangeTree {
    /// More files than this in one group and its directories open closed.
    public static let autoCollapseAbove = 24

    // MARK: Grouping

    public static func partition(_ raw: [RawChange]) -> [ChangeGroup: [ChangeItem]] {
        var out: [ChangeGroup: [ChangeItem]] = [:]
        for r in raw {
            func add(_ g: ChangeGroup, _ code: String) {
                out[g, default: []].append(ChangeItem(path: r.path, group: g, code: code, entryType: r.entryType, renamedFrom: r.renamedFrom))
            }
            if r.entryType == "unmerged" { add(.conflicts, "U"); continue }
            if r.entryType == "untracked" { add(.untracked, "?"); continue }
            if r.indexStatus != "." { add(.staged, r.indexStatus) }
            if r.workingStatus != "." { add(.changes, r.workingStatus) }
        }
        return out
    }

    // MARK: Filter

    /// Every whitespace-separated token must appear in the path, in any order.
    public static func filter(_ items: [ChangeItem], query: String) -> [ChangeItem] {
        let tokens = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !tokens.isEmpty else { return items }
        return items.filter { item in
            let p = item.path.lowercased()
            return tokens.allSatisfy { p.contains($0) }
        }
    }

    // MARK: Rows

    private final class Node {
        let name: String
        let path: String
        var children: [String: Node] = [:]
        var files: [ChangeItem] = []
        init(name: String, path: String) { self.name = name; self.path = path }
        var total: Int { files.count + children.values.reduce(0) { $0 + $1.total } }
    }

    /// The tree for ONE group, depth from 0.
    public static func rows(
        items: [ChangeItem], group: ChangeGroup, filter query: String,
        overrides: [String: Bool], autoCollapseAbove limit: Int = ChangeTree.autoCollapseAbove
    ) -> [ChangeTreeRow] {
        let filtering = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let shown = filter(items, query: query)
        let root = Node(name: "", path: "")
        for item in shown {
            let parts = item.path.split(separator: "/").map(String.init)
            guard !parts.isEmpty else { continue }
            var node = root
            var acc = ""
            for dir in parts.dropLast() {
                acc = acc.isEmpty ? dir : acc + "/" + dir
                if let next = node.children[dir] { node = next } else {
                    let n = Node(name: dir, path: acc)
                    node.children[dir] = n
                    node = n
                }
            }
            node.files.append(item)
        }
        let defaultClosed = !filtering && shown.count > limit
        var out: [ChangeTreeRow] = []

        func sortedChildren(_ n: Node) -> [Node] {
            n.children.values.sorted { $0.name.lowercased() < $1.name.lowercased() }
        }

        func emit(_ node: Node, depth: Int) {
            for child in sortedChildren(node) {
                // Join a chain of directories that hold nothing of their own.
                var name = child.name
                var cur = child
                while cur.files.isEmpty, cur.children.count == 1, let only = cur.children.values.first {
                    name += "/" + only.name
                    cur = only
                }
                let id = "\(group.rawValue)|d|\(cur.path)"
                let closed = filtering ? false : (overrides[id] ?? defaultClosed)
                out.append(ChangeTreeRow(
                    id: id, kind: .directory, group: group, path: cur.path, name: name,
                    depth: depth, count: cur.total, collapsed: closed, item: nil))
                if !closed { emit(cur, depth: depth + 1) }
            }
            let files = node.files.sorted { fileName($0.path).lowercased() < fileName($1.path).lowercased() }
            for f in files {
                out.append(ChangeTreeRow(
                    id: "\(group.rawValue)|f|\(f.path)", kind: .file, group: group, path: f.path,
                    name: fileName(f.path), depth: depth, count: 1, collapsed: false, item: f))
            }
        }
        emit(root, depth: 0)
        return out
    }

    /// Every group's header and, for the open ones, its tree — the one flat list
    /// the pane scrolls and the keyboard walks. Empty groups are omitted.
    public static func flatten(
        groups: [(ChangeGroup, [ChangeItem])], filter query: String,
        collapsedGroups: Set<String>, overrides: [String: Bool]
    ) -> [ChangeTreeRow] {
        let filtering = !query.trimmingCharacters(in: .whitespaces).isEmpty
        var out: [ChangeTreeRow] = []
        for (group, all) in groups {
            let shown = filter(all, query: query)
            guard !shown.isEmpty else { continue }
            let closed = !filtering && collapsedGroups.contains(group.rawValue)
            out.append(ChangeTreeRow(
                id: "g|\(group.rawValue)", kind: .group, group: group, path: "", name: group.title,
                depth: 0, count: shown.count, collapsed: closed, item: nil))
            if closed { continue }
            for r in rows(items: all, group: group, filter: query, overrides: overrides) {
                out.append(ChangeTreeRow(
                    id: r.id, kind: r.kind, group: r.group, path: r.path, name: r.name,
                    depth: r.depth + 1, count: r.count, collapsed: r.collapsed, item: r.item))
            }
        }
        return out
    }

    /// The files an action on a directory covers: its subtree, not a sibling
    /// that merely shares the prefix (`a/` is not `app/`).
    public static func paths(under directory: String, in items: [ChangeItem]) -> [String] {
        let prefix = directory.hasSuffix("/") ? directory : directory + "/"
        return items.filter { $0.path.hasPrefix(prefix) }.map(\.path)
    }

    // MARK: Keyboard

    public static func move(_ key: ChangeTreeKey, from id: String?, rows: [ChangeTreeRow]) -> ChangeTreeMove {
        guard let first = rows.first, let last = rows.last else { return .none }
        guard let id, let idx = rows.firstIndex(where: { $0.id == id }) else {
            switch key {
            case .down, .right, .home: return .select(first.id)
            case .up, .end: return .select(last.id)
            case .left: return .none
            }
        }
        let row = rows[idx]
        switch key {
        case .home: return .select(first.id)
        case .end: return .select(last.id)
        case .up: return .select(rows[max(0, idx - 1)].id)
        case .down: return .select(rows[min(rows.count - 1, idx + 1)].id)
        case .right:
            guard row.kind != .file else { return .none }
            if row.collapsed { return .toggle(id: row.id, collapse: false) }
            if idx + 1 < rows.count, rows[idx + 1].depth > row.depth { return .select(rows[idx + 1].id) }
            return .none
        case .left:
            if row.kind != .file, !row.collapsed { return .toggle(id: row.id, collapse: true) }
            if let parent = rows[..<idx].last(where: { $0.depth < row.depth }) { return .select(parent.id) }
            return .none
        }
    }

    private static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

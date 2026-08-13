// FileTree — the file-tree model + its flattening, with no UI attached.
//
// Lives in MARVINLogic (no SwiftUI, no @MainActor) so `swift run MARVINTests`
// can pin it. That matters more here than for most models: this type has
// crashed the app four times, always through SwiftUI's outline coordinator
// mishandling a shape it can't take, and every previous fix was verified only
// by running the app and waiting to see if it died again.
//
// ## Why the tree is flattened here instead of rendered by OutlineGroup
//
// ADR-0018 §5 deferred the OutlineGroup-vs-NSOutlineView call. Four crashes
// settled it. `List` + `OutlineGroup` drives AppKit's `NSOutlineView` through
// SwiftUI's `OutlineListCoordinator`, which keeps its own lazily-loaded row
// entries alongside the SwiftUI view list. Whenever the two disagree it traps
// (`ViewListTree.visitItem` → `_assertionFailure`, SIGTRAP, whole app down):
//
//   - a duplicate id anywhere in the tree                        (2026-07-xx)
//   - a directory whose children keypath returns a non-nil `[]`  (2026-07-xx)
//   - a duplicate id across the WHOLE tree, not just siblings    (ADR-0056)
//   - a directory flipping branch→leaf under a stable id         (2026-08-03)
//
// Each fix removed one way to disagree. None removed the disagreement itself,
// because the coordinator's state is not ours to keep consistent — an agent
// mutating files mid-session plus a 15s refresh poll will keep finding new
// ways to reshape the tree between diffs.
//
// So the tree is flattened to a plain row list here, and the view renders it
// with an ordinary `List`+`ForEach`. Expansion state is a `Set<String>` we own.
// There is no outline coordinator, so the entire failure mode is gone rather
// than narrowed — and flattening is a pure function, so it is unit-testable.

import Foundation

/// One node in the file tree returned by GET /api/files/tree. Recursive — a
/// `dir` node carries its children inline.
public struct FileNode: Codable, Identifiable, Equatable {
    /// Last path segment ("README.md", "src", …). Used as the row label; the
    /// full path lives in `path` for ops.
    public let name: String
    /// Absolute path on disk. Sandbox-checked by the sidecar before emission,
    /// so any path the Swift side sees has already passed the symlink / escape
    /// policies in `packages/runtime/src/fs-sandbox.ts`.
    public let path: String
    /// Discriminator — "file" or "dir". The wire today doesn't carry other
    /// types (symlinks are rejected upstream); we keep the raw String rather
    /// than mapping to a Swift enum so a future "submodule" or "lfs" type
    /// doesn't need a Swift release to surface.
    public let type: String
    /// Children for `dir` nodes; nil / empty for `file` nodes. The sidecar
    /// walks to its configured depth cap (default 10) and emits the full
    /// subtree inline; lazy-load-on-expand is a future change per ADR-0018 §4.
    public let children: [FileNode]?

    public init(name: String, path: String, type: String, children: [FileNode]?) {
        self.name = name
        self.path = path
        self.type = type
        self.children = children
    }

    public var isDirectory: Bool { type == "dir" }

    /// True when this node renders with a disclosure triangle: a directory that
    /// actually has children. An empty directory is deliberately a LEAF — it
    /// would expand into nothing, and the folder icon still comes from
    /// `isDirectory`, so it reads correctly either way.
    public var isOutlineBranch: Bool { isDirectory && !(children?.isEmpty ?? true) }

    /// Row identity — the absolute path, qualified by branch-ness.
    ///
    /// Identity is no longer load-bearing against an outline coordinator (the
    /// flat list diffs a plain array), but branch-ness stays encoded so a
    /// directory crossing the empty/non-empty boundary is a row REPLACEMENT
    /// rather than a row whose disclosure state silently contradicts its shape.
    /// Expansion is keyed on `path`, not `id`, so toggling survives the flip.
    public var id: String { isOutlineBranch ? path + "/" : path }

    /// Rebuild this node with its subtree filtered so no `path` repeats
    /// anywhere. The caller inserts THIS node's path before calling.
    public func deduplicated(into seen: inout Set<String>) -> FileNode {
        guard let kids = children else { return self }
        var kept: [FileNode] = []
        kept.reserveCapacity(kids.count)
        for child in kids where seen.insert(child.path).inserted {
            kept.append(child.deduplicated(into: &seen))
        }
        return FileNode(name: name, path: path, type: type, children: kept)
    }
}

extension Array where Element == FileNode {
    /// Guarantee `path` is unique across the WHOLE tree, pruning any node whose
    /// path was already seen elsewhere (ADR-0056).
    ///
    /// A symlink loop or a case-folding collision can emit the same path twice.
    /// The flat list no longer *crashes* on that, but duplicate rows are still
    /// wrong — the same file would appear twice and toggling one would toggle
    /// both, since expansion is path-keyed. So the sanitiser stays.
    public func deduplicatedTreeWide() -> [FileNode] {
        var seen = Set<String>()
        var out: [FileNode] = []
        out.reserveCapacity(count)
        for node in self where seen.insert(node.path).inserted {
            out.append(node.deduplicated(into: &seen))
        }
        return out
    }
}

// MARK: - Flattening

/// One visible row: a node, how deep it sits, and whether it's open.
public struct FileTreeDisplayRow: Identifiable, Equatable {
    public let node: FileNode
    /// 0 for a root entry; each level of nesting adds 1. The view multiplies
    /// this by its indent step — the tree's shape is decided here, not in the
    /// layout, so indentation is testable.
    public let depth: Int
    /// True when this row has a disclosure triangle (i.e. `isOutlineBranch`).
    public let isExpandable: Bool
    /// True when an expandable row is currently open. Always false for leaves.
    public let isExpanded: Bool

    public var id: String { node.id }

    public init(node: FileNode, depth: Int, isExpandable: Bool, isExpanded: Bool) {
        self.node = node
        self.depth = depth
        self.isExpandable = isExpandable
        self.isExpanded = isExpanded
    }
}

/// Depth-first flatten of `roots` into the rows that should be visible, given
/// the set of expanded PATHS.
///
/// Pure and total: it cannot trap on any tree shape. An empty directory, a
/// duplicate path, a node that changed shape since the last call — all of them
/// produce a row list, which is the whole point of moving off `OutlineGroup`.
///
/// Expansion is keyed on `path` rather than `id` so a directory that gains or
/// loses its last child stays open across the change (its `id` moves, its path
/// doesn't).
public func flattenFileTree(
    _ roots: [FileNode],
    expanded: Set<String>,
) -> [FileTreeDisplayRow] {
    var out: [FileTreeDisplayRow] = []
    // Guards against a cyclic tree (a symlink loop the sidecar didn't reject):
    // a path already emitted is never descended into again, so recursion is
    // bounded by the number of distinct paths rather than by the tree's shape.
    var visited = Set<String>()

    func walk(_ nodes: [FileNode], depth: Int) {
        for node in nodes {
            guard visited.insert(node.path).inserted else { continue }
            let expandable = node.isOutlineBranch
            let isOpen = expandable && expanded.contains(node.path)
            out.append(
                FileTreeDisplayRow(
                    node: node,
                    depth: depth,
                    isExpandable: expandable,
                    isExpanded: isOpen
                )
            )
            if isOpen, let kids = node.children {
                walk(kids, depth: depth + 1)
            }
        }
    }

    walk(roots, depth: 0)
    return out
}

/// Every directory path in the tree — the target set for "expand all", and the
/// seed for the default-expanded roots.
public func allDirectoryPaths(_ roots: [FileNode]) -> Set<String> {
    var out = Set<String>()
    func walk(_ nodes: [FileNode]) {
        for node in nodes where node.isOutlineBranch {
            guard out.insert(node.path).inserted else { continue }
            walk(node.children ?? [])
        }
    }
    walk(roots)
    return out
}

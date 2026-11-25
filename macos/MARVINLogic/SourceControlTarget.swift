// SourceControlTarget — which working tree the Source Control pane is looking
// at, and how it says so (owner, 25.11.2026: "Source Control needs a better
// implementation").
//
// The pane used to read the project's shared checkout whichever tab was
// selected, while a worktree tab works in its own checkout on its own branch
// (ADR-0107). A strip said so; the pane still could not show the tab's tree,
// because it held ONE `cwd` for everything and a single switch would have
// pointed discard and force-push at a tree chosen by tab selection.
//
// The design that follows from that: the pane has two scopes. This type is the
// first one — the tree whose status, stage, commit and push the pane shows. It
// is resolved from three things and nothing else: the pin the person set, the
// selected tab, and the project root. The project-level work (worktree list,
// merge all, sweep, Prepare MR) never reads it and always runs on the root.
//
// Pure (ADR-0022): every branch of this decision is an outcome a person would
// otherwise find out the hard way — most of all the two that must NOT quietly
// fall back to the project checkout.

import Foundation

/// What the person asked the pane to show.
public enum SourceControlPin: Equatable, Sendable {
    /// The selected tab's own tree (the default).
    case followTab
    /// The project checkout, whichever tab is selected.
    case project
    /// One specific worktree, chosen from the project list.
    case worktree(path: String, branch: String?, name: String)
}

public struct SourceControlTargetInput: Equatable, Sendable {
    public let projectRoot: String?
    public let projectName: String?
    /// The branch the project checkout is on, nil when detached or unknown.
    public let projectBranch: String?
    public let tabName: String?
    public let tabMode: SessionMode?
    public let tabTree: SessionTreeWire?
    /// Whether the tab's checkout exists on disk; nil when unknown.
    public let tabTreePresent: Bool?
    /// For `~` in a displayed path.
    public let home: String?

    public init(
        projectRoot: String?, projectName: String?, projectBranch: String?,
        tabName: String?, tabMode: SessionMode?, tabTree: SessionTreeWire?,
        tabTreePresent: Bool?, home: String?
    ) {
        self.projectRoot = projectRoot
        self.projectName = projectName
        self.projectBranch = projectBranch
        self.tabName = tabName
        self.tabMode = tabMode
        self.tabTree = tabTree
        self.tabTreePresent = tabTreePresent
        self.home = home
    }
}

public struct SourceControlTarget: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case project, tab, worktree }

    public let kind: Kind
    /// The directory every request in the first scope uses as `cwd`.
    public let path: String
    public let branch: String?
    /// "This tab", "Project checkout" or "Worktree" — the scope's name.
    public let scopeTitle: String
    /// The same, short enough for a segmented control.
    public let segmentTitle: String
    /// `Viewing: <name> · <branch> · <path>`.
    public let viewingLine: String
    /// What a confirmation says about where it acts: "in tab X (branch)".
    public let actionPhrase: String
    /// Something the person should know about this view: the tab's tree is
    /// gone, or the view is pinned away from the tab.
    public let notice: String?
    public let isPinned: Bool
    /// The tree on screen is not the selected tab's own tree.
    public let differsFromTab: Bool
    /// Whether the pin control has anything to do.
    public let canPin: Bool

    public static func resolve(pin: SourceControlPin, _ input: SourceControlTargetInput) -> SourceControlTarget? {
        guard let root = input.projectRoot, !root.isEmpty else { return nil }
        let tabName = clean(input.tabName)
        let tabLabel = tabName ?? "The selected tab"
        let ownPath: String? = {
            guard input.tabMode == .worktree, let tree = input.tabTree, tree.mode == .worktree,
                  let p = tree.path, !p.isEmpty, p != root else { return nil }
            return p
        }()
        let hasOwnTree = ownPath != nil && input.tabTreePresent != false
        let projectBranch = input.projectBranch

        func project(notice: String?, pinned: Bool, differs: Bool) -> SourceControlTarget {
            let b = projectBranch ?? "(detached)"
            return SourceControlTarget(
                kind: .project, path: root, branch: projectBranch,
                scopeTitle: "Project checkout", segmentTitle: "Checkout",
                viewingLine: "Viewing: Project checkout · \(b) · \(displayPath(root, root: root, home: input.home))",
                actionPhrase: "in the project checkout (\(b))",
                notice: notice, isPinned: pinned, differsFromTab: differs,
                canPin: hasOwnTree || pinned)
        }

        switch pin {
        case .project:
            let differs = hasOwnTree
            let note = differs ? "Pinned to the project checkout. \(tabLabel) works in its own worktree, which is not shown here." : nil
            return project(notice: note, pinned: true, differs: differs)

        case .worktree(let path, let branch, let name):
            let b = branch ?? "(detached)"
            return SourceControlTarget(
                kind: .worktree, path: path, branch: branch,
                scopeTitle: "Worktree", segmentTitle: "Worktree",
                viewingLine: "Viewing: \(name) · \(b) · \(displayPath(path, root: root, home: input.home))",
                actionPhrase: "in worktree \(name) (\(b))",
                notice: path == ownPath ? nil : "Pinned to a worktree that is not the selected tab's.",
                isPinned: true, differsFromTab: path != ownPath, canPin: true)

        case .followTab:
            if input.tabMode == .worktree {
                guard let ownPath else {
                    // Isolated tab with no worktree yet — or one whose path IS the root.
                    if let tree = input.tabTree, tree.path == root {
                        return project(notice: nil, pinned: false, differs: false)
                    }
                    return project(notice: "\(tabLabel) has no worktree yet — showing the project checkout.", pinned: false, differs: true)
                }
                if input.tabTreePresent == false {
                    return project(notice: "\(tabLabel)'s worktree is not on disk any more — showing the project checkout.", pinned: false, differs: true)
                }
                let branch = input.tabTree?.branch
                let b = branch ?? "(detached)"
                let name = tabName ?? "selected tab"
                return SourceControlTarget(
                    kind: .tab, path: ownPath, branch: branch,
                    scopeTitle: "This tab", segmentTitle: "This tab",
                    viewingLine: "Viewing: \(name) · \(b) · \(displayPath(ownPath, root: root, home: input.home))",
                    actionPhrase: "in tab \(name) (\(b))",
                    notice: nil, isPinned: false, differsFromTab: false, canPin: true)
            }
            return project(notice: nil, pinned: false, differs: false)
        }
    }

    /// A path as a person reads it: relative to the project root when inside
    /// it, `~/…` under the home folder, else as is.
    public static func displayPath(_ path: String, root: String, home: String?) -> String {
        let r = root.hasSuffix("/") ? String(root.dropLast()) : root
        if path.hasPrefix(r + "/") { return String(path.dropFirst(r.count + 1)) }
        if let home, !home.isEmpty {
            let h = home.hasSuffix("/") ? String(home.dropLast()) : home
            if path == h { return "~" }
            if path.hasPrefix(h + "/") { return "~" + String(path.dropFirst(h.count)) }
        }
        return path
    }

    private static func clean(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}

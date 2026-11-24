// ShellLayout — the window shell's decisions as values (UX review round 2,
// group E): where the chat sits, which menu an app-level command lives in, and
// which tree the Source control pane names. `MARVINTests` links `MARVINLogic`
// and nothing else, so a rule that lives in a SwiftUI view cannot be asserted
// (ADR-0114); the views read these and hold no rule of their own.

import Foundation

// MARK: - The work area (W-11)

/// What fills the middle of the window.
///
/// The window is three columns: the left pane, the editor area, and the chat
/// column. On a 2560-wide window with no file open the editor area is 1000 pt
/// of "No file open" while the chat, where the work happens, is a 770 pt column
/// at the right edge (UX review W-11, `a-full.png`).
///
/// The rule is a function of **what the editor area has to show**, never of a
/// measured width. A width-driven rule feeds geometry back into the structure
/// that produces the geometry — the shape of every layout storm this app has had
/// (ADR-0062, the 2026-09-01 runaway-pass crash). With a state-driven rule the
/// layout changes only when the user opens or closes something, once.
public enum WorkAreaLayout {
    /// What the editor column would hold. Any one of these needs the column.
    public struct Content: Equatable, Sendable {
        public var hasOpenFile: Bool
        /// The browser preview (ADR-0045 area) is a surface of the editor column.
        public var previewOpen: Bool
        /// The Supervisor workspace lives in the centre column (brief §13.2).
        public var supervisorWorkspaceOpen: Bool
        /// The bottom panel (terminal / problems / graph) is the editor column's lower half.
        public var bottomPanelOpen: Bool

        public init(hasOpenFile: Bool, previewOpen: Bool, supervisorWorkspaceOpen: Bool, bottomPanelOpen: Bool) {
            self.hasOpenFile = hasOpenFile
            self.previewOpen = previewOpen
            self.supervisorWorkspaceOpen = supervisorWorkspaceOpen
            self.bottomPanelOpen = bottomPanelOpen
        }

        public var needsEditorColumn: Bool {
            hasOpenFile || previewOpen || supervisorWorkspaceOpen || bottomPanelOpen
        }
    }

    public enum Mode: Equatable, Sendable {
        /// Three columns: the chat is the side column and the editor area is beside it.
        case split
        /// Nothing to show in the editor area: it is not drawn, and the chat takes the
        /// width, held to a reading measure and centred.
        case chatFills
    }

    public static func mode(_ content: Content) -> Mode {
        content.needsEditorColumn ? .split : .chatFills
    }

    /// The widest the chat column gets when it fills the window, in points.
    ///
    /// A message list is read, not scanned, so its line length matters more than
    /// the room available: the transcript at 770 pt already runs about 110
    /// characters a line, past the 60-90 a reader tracks comfortably. 900 pt keeps
    /// code blocks, tables and diffs from wrapping (they are most of a coding
    /// chat) while stopping prose from stretching across a 2200 pt area, which
    /// is what a fully filling column would do on this display. The brain pane and
    /// the composer share the column, so they stay one figure with the transcript.
    /// Centred, not left-aligned: a left-aligned 900 pt column beside the left
    /// pane leaves a dead strip on the right and reads as unfinished.
    public static let readingWidth: Double = 900

    /// `nil` = take whatever the split gives it.
    public static func chatMaxWidth(_ mode: Mode) -> Double? {
        switch mode {
        case .split: return nil
        case .chatFills: return readingWidth
        }
    }

    /// The chat column's tab strip is 32 pt plus a 1 pt hairline, at the top of
    /// `ChatPreviewView`. The Supervisor inspector is drawn below it, not over
    /// it (R2-13), so the strip's states stay visible and a tab is one click away.
    /// This must follow `sessionTabs`' `.frame(height: 32)` and the divider; the
    /// snapshot harness shows the seam if it drifts.
    public static let chatTabStripInset: Double = 33

    /// R2-13 — a click in the strip's band returns the user to the tab chat.
    public static func isInTabStrip(y: Double) -> Bool { y >= 0 && y < chatTabStripInset }
}

// MARK: - Menus (R2-17)

/// Where each app-level command sits in the menu bar, by Mac convention.
///
/// The registry (`CommandRegistry`) files each command under a slot and prints
/// its shortcut; before this table the update check, the shortcuts sheet and the
/// diagnostics copy all sat in **Window**, session stepping in **File** and
/// "Next Tab That Needs Me" in **Go**, which is otherwise code navigation.
/// macOS puts "Check for Updates…" in the app menu, shortcuts and support items in
/// Help, and "Show Previous / Next Tab" in Window. The registry reads its slot
/// and key from here, so the placement is one reviewable table.
public enum MenuPlacement {
    public struct Item: Equatable, Sendable {
        public let id: String
        /// The menu's title as the registry's slot spells it.
        public let menu: String
        /// Display form (`⇧⌘P`); nil = no key equivalent.
        public let shortcut: String?
        /// Where it was before (for the review of what moved); nil = newly placed.
        public let previousMenu: String?
    }

    public static let table: [Item] = [
        Item(id: "help.checkUpdates", menu: "MARVIN", shortcut: nil, previousMenu: "Window"),
        Item(id: "help.shortcuts", menu: "Help", shortcut: "⌘/", previousMenu: "Window"),
        Item(id: "help.copyDiagnostics", menu: "Help", shortcut: nil, previousMenu: "Window"),
        Item(id: "file.previousSession", menu: "Window", shortcut: "⇧⌘[", previousMenu: "File"),
        Item(id: "file.nextSession", menu: "Window", shortcut: "⇧⌘]", previousMenu: "File"),
        Item(id: "go.nextTabNeedingMe", menu: "Window", shortcut: "⌥⌘]", previousMenu: "Go"),
        // "Show MARVIN" was added to Window with no key. ⌘0 is the Mail convention
        // for bringing the main window back; nothing in MARVIN binds it.
        Item(id: "window.showMarvin", menu: "Window", shortcut: "⌘0", previousMenu: "Window"),
    ]

    public static func item(_ id: String) -> Item? { table.first { $0.id == id } }
}

// MARK: - Source control (R2-12)

/// What the Source control pane says about the tree it shows.
///
/// The pane reads the project's shared checkout (`bridge.projectWorkDir`) whichever
/// chat tab is selected, while a worktree tab works in its own checkout on its own
/// branch. The "Commit 100" button over staged work that belongs to the project, not
/// to the tab the user is looking at, is the risk the review named. The label says
/// which tree this is, so a click is never a guess.
public struct SourceControlTreeLabel: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// The selected tab works in this same checkout (or there is no tab): nothing to warn about.
        case sameTree
        /// The selected tab has its own worktree: what the pane shows is NOT its work.
        case otherTree
    }

    public let kind: Kind
    public let headline: String
    public let detail: String?
    /// The commit button's help text: names the branch and the tree it commits on.
    public let commitHelp: String

    /// - Parameters:
    ///   - projectBranch: the branch the pane is on (the project checkout's HEAD), nil if detached/unknown.
    ///   - tabTitle: the selected tab's title, if it has one.
    ///   - tabMode: the selected tab's tree mode, nil when there is no selected tab.
    ///   - tabBranch: the selected worktree tab's branch.
    public static func make(
        projectBranch: String?,
        tabTitle: String?,
        tabIsWorktree: Bool,
        tabBranch: String?
    ) -> SourceControlTreeLabel {
        let onBranch = projectBranch.map { "on \($0)" } ?? "(detached)"
        let help = "Commits in the project checkout, \(onBranch)"
        guard tabIsWorktree else {
            return SourceControlTreeLabel(
                kind: .sameTree,
                headline: "Project checkout",
                detail: tabTitle == nil ? nil : "The selected tab works in this checkout.",
                commitHelp: help
            )
        }
        let who = clean(tabTitle) ?? "The selected tab"
        let own = tabBranch.map { "its own worktree on \($0)" } ?? "its own worktree"
        return SourceControlTreeLabel(
            kind: .otherTree,
            headline: "Project checkout, not the selected tab",
            detail: "\(who) works in \(own). The changes here belong to the project's checkout \(onBranch).",
            commitHelp: help + ", not in the selected tab's worktree"
        )
    }

    private static func clean(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}

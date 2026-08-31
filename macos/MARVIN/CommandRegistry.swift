// CommandRegistry — every app command, declared once.
//
// Antigravity's menu bar (File / Edit / Selection / View / Go / Run /
// Terminal / Window / Help) plus its **Command Palette** (⇧⌘P, "Show All
// Commands") are two renderings of one list. MARVIN had neither: commands
// were `Button`s inline in `MARVINApp.commands`, reachable only by knowing
// which menu they were filed under.
//
// Declaring them as values buys three things at once:
//
//   1. The **palette** exists at all — it is a filter over this array.
//   2. The **menus** stop being the source of truth, so a command can move
//      between menus without its action moving with it.
//   3. The **shortcut audit** becomes mechanical: one array to scan for
//      collisions instead of 40 call sites. Two keys were double-bound
//      before this existed (⌘G, ⇧⌘B), and nothing caught it.
//
// A command is *not* here if it belongs to the responder chain (Undo, Cut,
// Copy, Paste, Find) — those are AppKit's, they act on whatever has focus,
// and re-declaring them would shadow the system behaviour with a worse one.

import AppKit
import MARVINLogic
import SwiftUI

/// Which menu a command files under. Mirrors the reference's menu bar so
/// the mapping is obvious; `.none` means palette-only.
enum CommandMenuSlot: String, CaseIterable {
    case file = "File"
    case edit = "Edit"
    case selection = "Selection"
    case view = "View"
    case go = "Go"
    case run = "Run"
    case terminal = "Terminal"
    case help = "Help"
    case none = ""
}

struct AppCommand: Identifiable {
    let id: String
    let title: String
    let slot: CommandMenuSlot
    /// Display form, e.g. `⇧⌘P`. Purely for the palette and the help sheet;
    /// the real binding lives on the menu item.
    let shortcut: String?
    /// Extra words the palette matches on — "problems" should find
    /// "Toggle Problems Panel" even though the title says Toggle first.
    let keywords: [String]
    let isEnabled: @MainActor () -> Bool
    let run: @MainActor () -> Void

    init(
        id: String,
        title: String,
        slot: CommandMenuSlot = .none,
        shortcut: String? = nil,
        keywords: [String] = [],
        isEnabled: @escaping @MainActor () -> Bool = { true },
        run: @escaping @MainActor () -> Void
    ) {
        self.id = id
        self.title = title
        self.slot = slot
        self.shortcut = shortcut
        self.keywords = keywords
        self.isEnabled = isEnabled
        self.run = run
    }
}

@MainActor
enum CommandRegistry {
    /// True when a project is open — the precondition for most commands.
    private static var hasProject: Bool {
        MarvinBridge.shared.projectWorkDir?.isEmpty == false
    }

    private static var workDir: String? {
        let w = MarvinBridge.shared.projectWorkDir
        return (w?.isEmpty == false) ? w : nil
    }

    static var all: [AppCommand] {
        var c: [AppCommand] = []

        // ── File ────────────────────────────────────────────────────────
        c.append(AppCommand(
            id: "file.newSession", title: "New Session",
            slot: .file, shortcut: "⇧⌘N", keywords: ["chat", "clear"]
        ) {
            NotificationCenter.default.post(name: .marvinRequestNewSession, object: nil)
        })
        c.append(AppCommand(
            id: "file.openProject", title: "Open Project…",
            slot: .file, shortcut: "⌘O", keywords: ["folder", "workspace"]
        ) { MarvinBridge.shared.triggerOpenProject() })
        c.append(AppCommand(
            id: "file.newTextFile", title: "New Text File…",
            slot: .file, shortcut: "⌘N", keywords: ["create", "add file"],
            isEnabled: { hasProject }
        ) {
            // The naming sheet and the create flow live in `FileTreeView`;
            // duplicating them here is how two "New File" dialogs that
            // behave slightly differently get born.
            MarvinBridge.shared.revealLeftTab("files")
            NotificationCenter.default.post(name: .marvinRequestNewFile, object: nil)
        })
        c.append(AppCommand(
            id: "file.saveAll", title: "Save All",
            slot: .file, shortcut: "⌥⌘S", keywords: ["write", "flush"],
            isEnabled: { !MarvinBridge.shared.openFiles.isEmpty }
        ) { FileCommand.saveAll.post() })
        c.append(AppCommand(
            id: "file.revert", title: "Revert File",
            slot: .file, keywords: ["discard", "reload from disk", "undo changes"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { FileCommand.revert.post() })
        c.append(AppCommand(
            id: "file.autoSave",
            title: NativePrefs.shared.autoSave ? "Turn Auto Save Off" : "Turn Auto Save On",
            slot: .file, keywords: ["auto save", "autosave"]
        ) { NativePrefs.shared.setAutoSave(!NativePrefs.shared.autoSave) })
        c.append(AppCommand(
            id: "file.closeAllEditors", title: "Close All Editors",
            slot: .file, keywords: ["tabs"],
            isEnabled: { !MarvinBridge.shared.openFiles.isEmpty }
        ) {
            for path in MarvinBridge.shared.openFiles {
                LSPService.shared.didClose(path: path)
                MarvinBridge.shared.closeFile(path)
            }
        })
        c.append(AppCommand(
            id: "file.reveal", title: "Reveal Project in Finder",
            slot: .file, shortcut: "⌥⌘R", isEnabled: { hasProject }
        ) {
            guard let w = workDir else { return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: w)])
        })
        c.append(AppCommand(
            id: "file.copyPath", title: "Copy Path of Active File",
            slot: .file, keywords: ["clipboard"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) {
            guard let p = MarvinBridge.shared.selectedFilePath else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(p, forType: .string)
        })

        // ── Edit / Selection ────────────────────────────────────────────
        // Undo, Redo, Cut, Copy, Paste and the Find family are AppKit's —
        // they act on whatever has focus, in any text view, and
        // redeclaring them would shadow the system behaviour with a worse
        // one. What IS here is the line-level editing every editor has and
        // MARVIN did not.
        c.append(AppCommand(
            id: "edit.toggleLineComment", title: "Toggle Line Comment",
            slot: .edit, shortcut: "⌘'", keywords: ["//", "#", "comment out"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.toggleLineComment) })
        c.append(AppCommand(
            id: "edit.toggleBlockComment", title: "Toggle Block Comment",
            slot: .edit, shortcut: "⌥⇧A", keywords: ["/*", "<!--", "comment out"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.toggleBlockComment) })
        c.append(AppCommand(
            id: "selection.moveLineUp", title: "Move Line Up",
            slot: .selection, shortcut: "⌥↑",
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.moveLineUp) })
        c.append(AppCommand(
            id: "selection.moveLineDown", title: "Move Line Down",
            slot: .selection, shortcut: "⌥↓",
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.moveLineDown) })
        c.append(AppCommand(
            id: "selection.copyLineUp", title: "Copy Line Up",
            slot: .selection, shortcut: "⌥⇧↑",
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.copyLineUp) })
        c.append(AppCommand(
            id: "selection.copyLineDown", title: "Copy Line Down",
            slot: .selection, shortcut: "⌥⇧↓",
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.copyLineDown) })
        c.append(AppCommand(
            id: "selection.duplicate", title: "Duplicate Selection",
            slot: .selection, shortcut: "⇧⌘D", keywords: ["copy"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.duplicate) })
        c.append(AppCommand(
            id: "selection.expand", title: "Expand Selection",
            slot: .selection, shortcut: "^⇧⌘→", keywords: ["grow", "smart select"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.expandSelection) })
        c.append(AppCommand(
            id: "selection.shrink", title: "Shrink Selection",
            slot: .selection, shortcut: "^⇧⌘←", keywords: ["contract", "smart select"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.shrinkSelection) })

        // ── View ────────────────────────────────────────────────────────
        c.append(AppCommand(
            id: "view.commandPalette", title: "Command Palette…",
            slot: .view, shortcut: "⇧⌘P", keywords: ["show all commands"]
        ) { MarvinBridge.shared.triggerCommandPalette() })
        c.append(AppCommand(
            id: "view.fileTree", title: "Toggle File Tree",
            slot: .view, shortcut: "⌘B", keywords: ["explorer", "sidebar"]
        ) { NativePrefs.shared.togglePane("files") })
        c.append(AppCommand(
            id: "view.search", title: "Search",
            slot: .view, shortcut: "⇧⌘F", keywords: ["find in files", "grep"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.revealLeftTab("search") })
        c.append(AppCommand(
            id: "view.wordWrap",
            title: NativePrefs.shared.wordWrap ? "Turn Word Wrap Off" : "Turn Word Wrap On",
            slot: .view, shortcut: "⌥Z", keywords: ["word wrap", "soft wrap", "lines"]
        ) { NativePrefs.shared.setWordWrap(!NativePrefs.shared.wordWrap) })
        c.append(AppCommand(
            id: "view.sourceControl", title: "Source Control",
            slot: .view, shortcut: "^⇧S", keywords: ["git", "scm", "commit", "branch"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.revealLeftTab("sourceControl") })
        c.append(AppCommand(
            id: "view.skills", title: "Skills",
            slot: .view, keywords: ["catalog"], isEnabled: { hasProject }
        ) { MarvinBridge.shared.revealLeftTab("skills") })
        c.append(AppCommand(
            id: "view.plugins", title: "Plugins",
            slot: .view, keywords: ["extensions", "marketplace"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.revealLeftTab("plugins") })
        c.append(AppCommand(
            id: "view.backlog", title: "Backlog",
            slot: .view, shortcut: "⇧⌘K", keywords: ["todo", "parked"]
        ) {
            NotificationCenter.default.post(name: .marvinRequestBacklogPanel, object: nil)
        })
        c.append(AppCommand(
            id: "view.bottomPanel", title: "Toggle Bottom Panel",
            slot: .view, shortcut: "⌘J", isEnabled: { hasProject }
        ) { NativePrefs.shared.toggleBottomPanel() })
        for tab in BottomPanelTab.allCases {
            c.append(AppCommand(
                id: "view.\(tab.rawValue)", title: tab.title,
                slot: .view, shortcut: Self.shortcutLabel(for: tab),
                keywords: ["panel", "bottom"], isEnabled: { hasProject }
            ) { NativePrefs.shared.togglePane(tab.rawValue) })
        }
        c.append(AppCommand(
            id: "view.preview", title: "Browser Preview",
            slot: .view, shortcut: "^⇧P",
            keywords: ["browser", "web", "localhost", "open in browser"],
            isEnabled: { hasProject }
        ) { NativePrefs.shared.togglePreview() })
        c.append(AppCommand(
            id: "view.theme", title: "Toggle Theme",
            slot: .view, shortcut: "⇧⌘T", keywords: ["dark", "light", "appearance"]
        ) {
            NativePrefs.shared.setTheme(
                NativePrefs.shared.themeName == "dark" ? "light" : "dark"
            )
        })

        // ── Go ──────────────────────────────────────────────────────────
        c.append(AppCommand(
            id: "go.file", title: "Go to File…",
            slot: .go, shortcut: "⌘P", keywords: ["quick open"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.triggerQuickOpen() })
        c.append(AppCommand(
            id: "go.symbol", title: "Go to Symbol in Workspace…",
            slot: .go, shortcut: "⌘T", keywords: ["function", "class", "definition"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.triggerSymbolSearch() })
        c.append(AppCommand(
            id: "go.definition", title: "Go to Definition",
            slot: .go, shortcut: "F12", keywords: ["jump to", "declaration", "lsp"],
            isEnabled: {
                guard let p = MarvinBridge.shared.selectedFilePath else { return false }
                return LSPService.shared.hasReadyServer(for: p)
            }
        ) {
            guard let path = MarvinBridge.shared.selectedFilePath else { return }
            let b = MarvinBridge.shared
            LSPService.shared.definition(
                path: path, line: b.cursorRow, column: b.cursorCol
            ) { target, line in
                b.openFileFromChat(path: target, line: line)
            }
        })
        c.append(AppCommand(
            id: "go.line", title: "Go to Line/Column…",
            slot: .go, shortcut: "^G", keywords: ["jump", "line number"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { MarvinBridge.shared.triggerGoToLine() })
        c.append(AppCommand(
            id: "go.nextProblem", title: "Next Problem",
            slot: .go, shortcut: "F8", keywords: ["error", "warning", "diagnostic"],
            isEnabled: { !MarvinBridge.shared.diagnosticItems.isEmpty }
        ) { ProblemNavigator.go(.next) })
        c.append(AppCommand(
            id: "go.previousProblem", title: "Previous Problem",
            slot: .go, shortcut: "⇧F8", keywords: ["error", "warning", "diagnostic"],
            isEnabled: { !MarvinBridge.shared.diagnosticItems.isEmpty }
        ) { ProblemNavigator.go(.previous) })
        c.append(AppCommand(
            id: "go.back", title: "Back",
            slot: .go, shortcut: "^-", keywords: ["navigate", "history", "previous file"],
            isEnabled: { MarvinBridge.shared.canNavigateBack }
        ) { MarvinBridge.shared.navigateBack() })
        c.append(AppCommand(
            id: "go.forward", title: "Forward",
            slot: .go, shortcut: "^⇧-", keywords: ["navigate", "history"],
            isEnabled: { MarvinBridge.shared.canNavigateForward }
        ) { MarvinBridge.shared.navigateForward() })
        c.append(AppCommand(
            id: "go.bracket", title: "Go to Bracket",
            slot: .go, shortcut: "⇧⌘\\", keywords: ["matching", "paren", "brace"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { EditorCommands.perform(.goToBracket) })
        c.append(AppCommand(
            id: "go.nextChange", title: "Next Change",
            slot: .go, shortcut: "⌥⌘↓", keywords: ["diff", "hunk", "modified"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { FileCommand.nextChange.post() })
        c.append(AppCommand(
            id: "go.previousChange", title: "Previous Change",
            slot: .go, shortcut: "⌥⌘↑", keywords: ["diff", "hunk", "modified"],
            isEnabled: { MarvinBridge.shared.selectedFilePath != nil }
        ) { FileCommand.previousChange.post() })

        // ── Run / Terminal ──────────────────────────────────────────────
        c.append(AppCommand(
            id: "run.buildTask", title: "Run Build Task…",
            slot: .run, shortcut: "⇧⌘B", keywords: ["make", "npm", "task"],
            isEnabled: { hasProject }
        ) { MarvinBridge.shared.triggerBuildTask() })
        c.append(AppCommand(
            id: "run.diagnostics", title: "Run Diagnostics",
            slot: .run, keywords: ["lint", "tsc", "problems", "check"],
            isEnabled: { hasProject }
        ) {
            guard let w = workDir else { return }
            NativePrefs.shared.revealPane(.problems)
            DiagnosticsService.shared.runAll(workDir: w)
        })
        c.append(AppCommand(
            id: "run.activeFile", title: "Run Active File",
            slot: .run, keywords: ["execute", "python", "node", "script"],
            isEnabled: {
                guard let p = MarvinBridge.shared.selectedFilePath else { return false }
                // Disabled rather than failing in the terminal: a language
                // with no single-file run has no honest command to send.
                return hasProject && RunFileCommand.command(forPath: p) != nil
            }
        ) {
            guard let workDir = workDir,
                  let path = MarvinBridge.shared.selectedFilePath,
                  let command = RunFileCommand.command(forPath: path) else { return }
            NativePrefs.shared.revealPane(.terminal)
            TerminalSessionStore.shared.session(for: workDir).run(command: command)
        })
        c.append(AppCommand(
            id: "run.auditSession", title: "Audit Session…",
            slot: .run, keywords: ["review", "drift"], isEnabled: { hasProject }
        ) { MarvinBridge.shared.triggerSessionAudit() })
        // No separate Terminal command: the bottom-tab loop above already
        // emits one for `.terminal` with the same action and the same ^`
        // binding. Two menu items running one action is how ⇧⌘B ended up
        // bound twice before the registry existed.

        // ── Help ────────────────────────────────────────────────────────
        c.append(AppCommand(
            id: "help.shortcuts", title: "Keyboard Shortcuts",
            slot: .help, shortcut: "⌘/", keywords: ["keys", "bindings"]
        ) { MarvinBridge.shared.triggerShortcutsHelp() })
        c.append(AppCommand(
            id: "help.checkUpdates", title: "Check for Updates…",
            slot: .help, keywords: ["version", "upgrade"]
        ) { Task { await UpdateService.shared.check(userInitiated: true) } })
        c.append(AppCommand(
            id: "help.copyDiagnostics", title: "Copy App Diagnostics",
            slot: .help, keywords: ["support", "bug report", "logs", "version"]
        ) { AppDiagnosticsReport.copyToPasteboard() })

        return c
    }

    private static func shortcutLabel(for tab: BottomPanelTab) -> String {
        switch tab {
        case .terminal: return "^`"
        case .problems: return "⇧⌘M"
        case .graph: return "^⇧G"
        }
    }

    static func commands(in slot: CommandMenuSlot) -> [AppCommand] {
        all.filter { $0.slot == slot }
    }

    /// Subsequence match, the way every palette works: `gtl` finds "Go to
    /// Line". Falls back to substring on the keywords.
    static func filter(_ query: String) -> [AppCommand] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all }
        return all.compactMap { cmd -> (AppCommand, Int)? in
            let hay = cmd.title.lowercased()
            if let score = subsequenceScore(q, in: hay) { return (cmd, score) }
            if cmd.keywords.contains(where: { $0.lowercased().contains(q) }) {
                return (cmd, 500)
            }
            if cmd.slot.rawValue.lowercased().hasPrefix(q) { return (cmd, 900) }
            return nil
        }
        .sorted { $0.1 < $1.1 }
        .map(\.0)
    }

    /// Lower is better: a contiguous prefix match beats letters scattered
    /// across the string, which is what makes `git` rank "Source Control"
    /// below a command actually called Git.
    private static func subsequenceScore(_ needle: String, in hay: String) -> Int? {
        var idx = hay.startIndex
        var score = 0
        var lastHit: String.Index?
        for ch in needle {
            guard let hit = hay[idx...].firstIndex(of: ch) else { return nil }
            if let last = lastHit, hay.index(after: last) != hit { score += 10 }
            score += hay.distance(from: hay.startIndex, to: hit)
            lastHit = hit
            idx = hay.index(after: hit)
        }
        return score
    }
}

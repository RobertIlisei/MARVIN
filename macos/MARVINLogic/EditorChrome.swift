// EditorChrome — the editor area's decisions as values (owner, 25.11.2026: "we've
// lost features: the Markdown preview, the navigation bar through the open files,
// the preview button acting wrong").
//
// Nothing was deleted from the file viewer. The W-11 work-area change put a clip
// on the editor column, and clipping an AppKit-backed view (the `VSplitView`
// inside it) drops the safe area SwiftUI hands its content: the tab bar and the
// file header (path, the Markdown toggle, find, history, save, close) were laid
// out under the title bar. The standalone `file-viewer` snapshot never showed it,
// because it renders the viewer outside the window. So the rules live here, the
// views read them, and `EditorSourceGuard` fails the build if the shape that lost
// them comes back.

import Foundation

// MARK: - Markdown preview toggle

/// The Markdown preview of a file in the editor (⇧⌘V). It REPLACES the editor
/// rather than splitting it (the pane is one column of a three-pane window), is
/// per file, and a Markdown file opens as source.
public enum MarkdownPreviewToggle {
    public enum Mode: Equatable, Sendable { case source, preview }

    /// What the toggle's button shows and says. It names the action the click
    /// performs, never the state the file is in.
    public struct Control: Equatable, Sendable {
        public let title: String
        public let systemImage: String
        public let help: String
        public let accessibilityLabel: String
    }

    /// Files worth a rendered view. Markdown only: the renderer is a Markdown
    /// parser, and pointing it at anything else would render garbage confidently.
    public static func isPreviewable(_ path: String) -> Bool {
        ["md", "markdown", "mdx"].contains((path as NSString).pathExtension.lowercased())
    }

    /// A file with no preview is always source, whatever the set holds.
    public static func mode(for path: String, previewing: Set<String>) -> Mode {
        isPreviewable(path) && previewing.contains(path) ? .preview : .source
    }

    public static func toggle(_ path: String, in previewing: inout Set<String>) {
        guard isPreviewable(path) else { return }
        if previewing.contains(path) { previewing.remove(path) } else { previewing.insert(path) }
    }

    public static func control(for mode: Mode) -> Control {
        switch mode {
        case .preview:
            return Control(
                title: "Show Source",
                systemImage: "chevron.left.forwardslash.chevron.right",
                help: "Show the Markdown source (⇧⌘V)",
                accessibilityLabel: "Show Markdown source")
        case .source:
            return Control(
                title: "Preview",
                systemImage: "doc.richtext",
                help: "Preview the rendered Markdown (⇧⌘V)",
                accessibilityLabel: "Preview rendered Markdown")
        }
    }
}

// MARK: - Open-file tabs

public enum EditorTabs {
    /// The tab selected after `closing` leaves `tabs`. The one that took its
    /// place; the one before when the last tab closed; nil when none is left.
    /// Closing a tab that is not selected keeps the selection.
    public static func selectionAfterClosing(_ closing: String, in tabs: [String], selected: String?) -> String? {
        guard let index = tabs.firstIndex(of: closing), selected == closing else { return selected }
        var rest = tabs
        rest.remove(at: index)
        if index < rest.count { return rest[index] }
        return rest.last
    }
}

// MARK: - Source guard

/// Fails on the shapes that lost the editor chrome. A source scan on purpose, like
/// `PaneSourceScan`: it fails in CI on the commit that drops the tab bar, not three
/// weeks later in a screenshot. The snapshot harness (`window-editor`) is the
/// measurement; this is what keeps it from being the only guard.
public enum EditorSourceGuard {
    public static func violations(fileViewer: String, contentView: String) -> [String] {
        var out: [String] = []

        // 1. The viewer builds the tab bar, then the header, then the content.
        let body = viewerBodyLines(fileViewer)
        let order = ["tabBar", "header", "content"].map { name in body.firstIndex { $0 == name } }
        if order.contains(where: { $0 == nil }) {
            out.append("FileViewerView.body does not build tabBar, header and content")
        } else if let a = order[0], let b = order[1], let c = order[2], !(a < b && b < c) {
            out.append("FileViewerView.body builds tabBar, header and content out of order")
        }
        if !fileViewer.contains("private var tabBar: some View") || !fileViewer.contains("ForEach(bridge.openFiles") {
            out.append("FileViewerView has no tab bar over bridge.openFiles")
        }

        // 2. The content has the Markdown preview branch; the header has the toggle built from the rule.
        if !fileViewer.contains("MarkdownFilePreview(") {
            out.append("FileViewerView never builds MarkdownFilePreview")
        }
        if !fileViewer.contains("MarkdownPreviewToggle.control(") || !fileViewer.contains("togglePreview(") {
            out.append("FileViewerView's Markdown toggle is not built from MarkdownPreviewToggle")
        }
        if !fileViewer.contains(#".keyboardShortcut("v", modifiers: [.command, .shift])"#) {
            out.append("the Markdown toggle lost its ⇧⌘V shortcut")
        }

        // 3. The editor area builds the viewer.
        if !contentView.contains("FileViewerView()") {
            out.append("ContentView never builds FileViewerView")
        }

        // 4. Nothing clips the editor column. A clip on a view that holds an AppKit split
        // view removes its safe area, which put the tab bar and the file header (61 pt)
        // under the 52 pt title bar (W-11, measured 25.11.2026). Hide it with opacity.
        let work = workAreaLines(contentView)
        if work.isEmpty {
            out.append("ContentView has no workArea to check")
        }
        let clips = [".clipped(", ".clipShape(", ".mask(", ".cornerRadius("]
        for (i, line) in work.enumerated() where !line.hasPrefix("//") && clips.contains(where: { line.contains($0) }) {
            out.append("ContentView.workArea clips its content (line \(i + 1) of workArea): \(line)")
        }
        return out
    }

    /// The trimmed lines of `FileViewerView.body`.
    private static func viewerBodyLines(_ text: String) -> [String] {
        let lines = text.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains("var body: some View") }) else { return [] }
        return block(lines, from: start)
    }

    /// The trimmed lines of `workArea`, from its declaration to its closing brace.
    private static func workAreaLines(_ text: String) -> [String] {
        let lines = text.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains("var workArea: some View") }) else { return [] }
        return block(lines, from: start)
    }

    private static func block(_ lines: [String], from start: Int) -> [String] {
        var depth = 0
        var started = false
        var out: [String] = []
        for line in lines[start...] {
            out.append(line.trimmingCharacters(in: .whitespaces))
            for ch in line {
                if ch == "{" { depth += 1; started = true } else if ch == "}" { depth -= 1 }
            }
            if started && depth <= 0 { break }
        }
        return out
    }
}

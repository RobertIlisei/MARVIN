// PaneSourceScan — the guard that keeps the pane standard a standard.
//
// A pane file that defines its own header, row or section header, or sets text
// below 11 pt, is how the app got "each thing has its own design". This scans
// the Swift source (a test reads the files and hands the text here, so the rule
// is a pure function with fixtures) and names every offence as `File.swift:42`.
//
// It is a SOURCE scan on purpose, not a runtime check: it fails in CI on the
// commit that adds `private func skillRow(...)`, not three weeks later in a
// review of screenshots.
//
// The allowlist is the panes that are NOT on the kit yet, each with who is
// moving them today. Entries leave as those branches merge; nothing joins it.

import Foundation

public enum PaneSourceScan {
    /// File name -> who is migrating it. A pane here is skipped by both guards.
    public static let migrating: [String: String] = [
        // The four being rebuilt in parallel on 2026-11-25.
        "SessionsPane.swift": "sessions agent (finished-sessions groups)",
        "BacklogPanel.swift": "backlog + plans agent",
        "PlansPanel.swift": "backlog + plans agent",
        "PlanCardView.swift": "backlog + plans agent",
        "SourceControlView.swift": "source control agent",
        // Not assigned to anyone yet: found by the inventory in
        // docs/design/pane-standard.md. Each is a candidate for the next pass.
        "FileTreeView.swift": "unassigned (inventory, pane-standard.md)",
        "FindInFilesView.swift": "unassigned (inventory, pane-standard.md)",
        "SupervisorWorkspaceView.swift": "unassigned (inventory, pane-standard.md)",
        "SupervisorViews.swift": "unassigned (inventory, pane-standard.md)",
        "SupervisorInboxViews.swift": "unassigned (inventory, pane-standard.md)",
        "SupervisorQueueViews.swift": "unassigned (inventory, pane-standard.md)",
        "SupervisorMergeViews.swift": "unassigned (inventory, pane-standard.md)",
        "ProjectToolsPanel.swift": "unassigned (inventory, pane-standard.md)",
        "DiagnosticsPanelView.swift": "unassigned (inventory, pane-standard.md)",
        "TodoListView.swift": "unassigned (inventory, pane-standard.md)",
        "TerminalPaneView.swift": "unassigned (inventory, pane-standard.md)",
        "PreviewPaneView.swift": "unassigned (inventory, pane-standard.md)",
        "GraphPaneView.swift": "unassigned (inventory, pane-standard.md)",
        // The activity rail's badge is a 9 pt count in a 44 pt column; it is
        // chrome of the window, not a pane (documented exception in the standard).
        "LeftPane.swift": "not a pane: the rail container (documented exception)",
    ]

    /// Files that are panes or panels by name, plus every kit file. A new
    /// `FooPane.swift` / `FooPanel.swift` is scanned the day it appears.
    public static let namedPaneFiles: [String] = [
        "FileTreeView.swift", "FindInFilesView.swift", "SourceControlView.swift",
        "SupervisorWorkspaceView.swift", "SupervisorViews.swift", "SupervisorInboxViews.swift",
        "SupervisorQueueViews.swift", "SupervisorMergeViews.swift", "PlanCardView.swift",
        "DiagnosticsPanelView.swift", "TodoListView.swift",
    ]

    public static func isPaneFile(_ name: String) -> Bool {
        guard name.hasSuffix(".swift") else { return false }
        let stem = String(name.dropLast(6))
        if stem.hasPrefix("Pane") { return true }
        if stem.hasSuffix("Pane") || stem.hasSuffix("Panel") || stem.hasSuffix("PaneView") || stem.hasSuffix("PanelView") { return true }
        return namedPaneFiles.contains(name)
    }

    /// The kit's own files: they define the chrome, so they may.
    public static func isKitFile(_ name: String) -> Bool { name.hasPrefix("Pane") }

    public static func loadPaneSources(macosDir: String) -> [String: String] {
        let dir = macosDir + "/MARVIN"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        var out: [String: String] = [:]
        for n in names where isPaneFile(n) {
            if let text = try? String(contentsOfFile: dir + "/" + n, encoding: .utf8) { out[n] = text }
        }
        return out
    }

    // MARK: Private chrome

    /// What counts as "using the kit" inside a header or row builder.
    static let kitTokens = ["PaneListRow(", ".paneRow(", "PaneHeader(", "PaneSectionHeader(", "PaneGroup(", "PaneFilterField("]

    private static let chromeName = try! NSRegularExpression(
        pattern: #"(^|[a-z0-9])(Row|Header)([A-Z0-9]|$)|^(row|header)([A-Z0-9]|$)"#)
    private static let funcOrVar = try! NSRegularExpression(
        pattern: #"\b(?:func|var)\s+([A-Za-z_][A-Za-z0-9_]*)"#)
    private static let structView = try! NSRegularExpression(
        pattern: #"\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*:\s*[^{]*\bView\b"#)

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func capture(_ re: NSRegularExpression, _ s: String) -> String? {
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }

    /// A header or row builder that does not build from the kit.
    public static func privateChromeViolations(in files: [String: String], allowlist: [String: String]) -> [String] {
        var out: [String] = []
        for name in files.keys.sorted() where !isKitFile(name) && allowlist[name] == nil {
            let lines = files[name]!.components(separatedBy: "\n")
            for (i, line) in lines.enumerated() {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("//") { continue }
                var declared: String?
                if t.contains("some View"), let n = capture(funcOrVar, t), t.contains("func ") || t.contains("var ") {
                    declared = n
                } else if let n = capture(structView, t) {
                    declared = n
                }
                guard let d = declared, matches(chromeName, d) else { continue }
                let body = bodyText(lines: lines, from: i)
                if kitTokens.contains(where: { body.contains($0) }) { continue }
                out.append("\(name):\(i + 1) \(d)")
            }
        }
        return out
    }

    /// Text from `lines[from]` to the brace that closes the first `{` at or after it.
    private static func bodyText(lines: [String], from: Int) -> String {
        var depth = 0
        var started = false
        var collected: [String] = []
        for j in from..<lines.count {
            collected.append(lines[j])
            for ch in lines[j] {
                if ch == "{" { depth += 1; started = true }
                else if ch == "}" { depth -= 1 }
            }
            if started && depth <= 0 { break }
            if j - from > 400 { break }
        }
        return collected.joined(separator: "\n")
    }

    // MARK: Small text

    private static let systemSize = try! NSRegularExpression(pattern: #"\.font\(\s*\.system\(\s*size:\s*([0-9]+(?:\.[0-9]+)?)"#)
    private static let smallStyle = try! NSRegularExpression(pattern: #"\.font\(\s*\.(?:system\(\s*\.)?(?:caption2?|footnote)\b"#)

    /// `.font(.system(size: N))` with N < 11 on text, or a 10 pt text style
    /// (`.caption`, `.caption2`, `.footnote`). A glyph is exempt: an `Image` on
    /// the same or the two preceding lines, or a `// glyph` note.
    public static func smallTextViolations(in files: [String: String], allowlist: [String: String]) -> [String] {
        var out: [String] = []
        for name in files.keys.sorted() where allowlist[name] == nil {
            let lines = files[name]!.components(separatedBy: "\n")
            for (i, line) in lines.enumerated() {
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { continue }
                if line.contains("// glyph") { continue }
                var small = false
                if let s = capture(systemSize, line), let n = Double(s), n < PaneTypeScale.minimumPoints { small = true }
                if matches(smallStyle, line) { small = true }
                guard small else { continue }
                let context = lines[max(0, i - 2)...i].joined(separator: "\n")
                if context.contains("Image(") || context.contains("systemName") || context.contains("Label(") { continue }
                out.append("\(name):\(i + 1)")
            }
        }
        return out
    }
}

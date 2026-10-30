// UnifiedDiff — `git diff` text, parsed once, for the one diff renderer both
// surfaces share (critique U16).
//
// The Source Control diff sheet used to colour raw text line by line and show
// git's own header (`diff --git`, `index`, `---`, `+++`) as content, while
// Review Changes rendered hunks it had been handed already parsed. This is the
// parse the sheet was missing. It is deliberately a state machine, not a
// per-line classifier: `--- a/x` is a header only BEFORE the first hunk, and a
// removed line whose text starts with dashes (`-- a SQL comment` becomes
// `--- a SQL comment`) is a removed line, not a file marker.
//
// `parse` returns nil for anything that is not one file's diff, and the caller
// then shows the raw text. A parser that returned a partial diff for text it
// did not understand would show the user less than git said.

import Foundation

public struct UnifiedDiffLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case context, added, removed, noNewline }
    public let kind: Kind
    public let text: String
    /// Line number in the old file; nil for an added line and for a marker.
    public let oldNumber: Int?
    /// Line number in the new file; nil for a removed line and for a marker.
    public let newNumber: Int?
}

public struct UnifiedDiffHunk: Equatable, Sendable {
    public let header: String
    public let lines: [UnifiedDiffLine]
}

public struct UnifiedDiff: Equatable, Sendable {
    public var oldPath: String? = nil
    public var newPath: String? = nil
    public var renamedFrom: String? = nil
    public var renamedTo: String? = nil
    public var oldMode: String? = nil
    public var newMode: String? = nil
    public var isNewFile = false
    public var isDeletedFile = false
    public var isBinary = false
    public var hunks: [UnifiedDiffHunk] = []

    public var additions: Int { count(.added) }
    public var deletions: Int { count(.removed) }

    private func count(_ kind: UnifiedDiffLine.Kind) -> Int {
        hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == kind }.count }
    }

    /// One line saying what changed: the strip that replaces git's four header
    /// lines. Empty when there is nothing to say.
    public var summary: String {
        if additions + deletions > 0 { return "+\(additions) \u{2212}\(deletions)" }
        if let from = renamedFrom { return "renamed from \(from)" }
        if let old = oldMode, let new = newMode { return "mode \(old) \u{2192} \(new)" }
        if isBinary { return "binary file" }
        return ""
    }

    /// nil when `text` is not one file's unified diff.
    public static func parse(_ text: String) -> UnifiedDiff? {
        var rows = text.components(separatedBy: "\n")
        if rows.last == "" { rows.removeLast() }
        if rows.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) { return UnifiedDiff() }

        var diff = UnifiedDiff()
        var seenFileHeader = false
        var seenHunk = false
        var header: String? = nil
        var lines: [UnifiedDiffLine] = []
        var oldNo = 0, newNo = 0

        func closeHunk() {
            if let header { diff.hunks.append(UnifiedDiffHunk(header: header, lines: lines)) }
            header = nil
            lines = []
        }

        for row in rows {
            if row.hasPrefix("diff --git ") {
                if seenFileHeader { return nil }
                seenFileHeader = true
                continue
            }
            if row.hasPrefix("@@") {
                guard let (o, n) = hunkStarts(row) else { return nil }
                closeHunk()
                header = row
                oldNo = o
                newNo = n
                seenHunk = true
                continue
            }
            if header == nil {
                // Before the first hunk, and between a hunk and a following
                // header block: git's own bookkeeping.
                if row.hasPrefix("--- ") { diff.oldPath = path(row.dropFirst(4)); continue }
                if row.hasPrefix("+++ ") { diff.newPath = path(row.dropFirst(4)); continue }
                if row.hasPrefix("old mode ") { diff.oldMode = String(row.dropFirst(9)); continue }
                if row.hasPrefix("new mode ") { diff.newMode = String(row.dropFirst(9)); continue }
                if row.hasPrefix("new file mode") { diff.isNewFile = true; continue }
                if row.hasPrefix("deleted file mode") { diff.isDeletedFile = true; continue }
                if row.hasPrefix("rename from ") { diff.renamedFrom = String(row.dropFirst(12)); continue }
                if row.hasPrefix("rename to ") { diff.renamedTo = String(row.dropFirst(10)); continue }
                if row.hasPrefix("Binary files ") || row.hasPrefix("GIT binary patch") { diff.isBinary = true; continue }
                if seenFileHeader { continue }   // index, similarity index, copy from, …
                return nil                        // text before any header: not a diff
            }
            switch row.first {
            case " ":
                lines.append(.init(kind: .context, text: String(row.dropFirst()), oldNumber: oldNo, newNumber: newNo))
                oldNo += 1; newNo += 1
            case nil:
                // A blank context line whose single space was stripped.
                lines.append(.init(kind: .context, text: "", oldNumber: oldNo, newNumber: newNo))
                oldNo += 1; newNo += 1
            case "+":
                lines.append(.init(kind: .added, text: String(row.dropFirst()), oldNumber: nil, newNumber: newNo))
                newNo += 1
            case "-":
                lines.append(.init(kind: .removed, text: String(row.dropFirst()), oldNumber: oldNo, newNumber: nil))
                oldNo += 1
            case "\\":
                lines.append(.init(kind: .noNewline, text: String(row.dropFirst(2)), oldNumber: nil, newNumber: nil))
            default:
                return nil
            }
        }
        closeHunk()
        if !seenFileHeader && !seenHunk { return nil }
        // `diff --git a/x b/y` with a rename and no ---/+++ names the files only there.
        if diff.newPath == nil, !diff.isDeletedFile { diff.newPath = diff.renamedTo }
        if diff.oldPath == nil, !diff.isNewFile { diff.oldPath = diff.renamedFrom }
        return diff
    }

    /// `/dev/null` is "no file"; `a/` and `b/` are git's prefixes, not the path.
    private static func path(_ raw: Substring) -> String? {
        let p = raw.split(separator: "\t", maxSplits: 1).first.map(String.init) ?? String(raw)
        if p == "/dev/null" { return nil }
        if p.hasPrefix("a/") || p.hasPrefix("b/") { return String(p.dropFirst(2)) }
        return p
    }

    private static func hunkStarts(_ header: String) -> (Int, Int)? {
        guard let re = try? NSRegularExpression(pattern: #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#),
              let m = re.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
              let a = Range(m.range(at: 1), in: header), let b = Range(m.range(at: 2), in: header),
              let old = Int(header[a]), let new = Int(header[b]) else { return nil }
        return (old, new)
    }
}

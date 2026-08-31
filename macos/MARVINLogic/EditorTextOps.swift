// EditorTextOps — line-level editor commands, as pure functions.
//
// Move Line Up/Down, Copy Line Up/Down, Duplicate Selection and Toggle
// Line Comment are the commands people reach for constantly and notice
// instantly when they are missing. Every one of them is the same shape:
// given the text and a selection, produce new text and a new selection.
//
// Pure (ADR-0022) because the fiddly parts are all off-by-one:
//
//   • A selection that ENDS at a line start must not drag the next line in
//     — `⌥↓` on a fully-selected line would otherwise move two.
//   • A file with no trailing newline behaves differently at the last line
//     than everywhere else.
//   • The selection has to FOLLOW the text, or the second `⌥↓` operates on
//     something other than what is highlighted.
//
// None of that is observable from a screenshot, so it is pinned by tests
// instead.

import Foundation

public struct TextEdit: Equatable, Sendable {
    public let text: String
    public let selection: NSRange

    public init(text: String, selection: NSRange) {
        self.text = text
        self.selection = selection
    }
}

public enum EditorTextOps {
    // MARK: - Line span of a selection

    /// The character range covering every line the selection touches,
    /// EXCLUDING its trailing newline.
    ///
    /// The subtle case: when a selection ends exactly at a line boundary
    /// (the whole line is selected, cursor sitting on the next line's
    /// first column) the user means one line, not two. Treating it
    /// literally makes `⌥↓` on a selected line move two lines.
    public static func lineSpan(in text: String, for selection: NSRange) -> NSRange {
        let ns = text as NSString
        guard ns.length > 0 else { return NSRange(location: 0, length: 0) }
        let loc = min(max(selection.location, 0), ns.length)
        var end = min(loc + max(selection.length, 0), ns.length)
        if end > loc, end > 0, ns.character(at: end - 1) == 10 {
            end -= 1        // selection ends on a newline: don't take the next line
        }
        let startLine = ns.lineRange(for: NSRange(location: loc, length: 0)).location
        let endLineRange = ns.lineRange(for: NSRange(location: end, length: 0))
        var stop = endLineRange.location + endLineRange.length
        if stop > startLine, stop > 0, ns.character(at: stop - 1) == 10 {
            stop -= 1       // exclude the trailing newline itself
        }
        return NSRange(location: startLine, length: max(0, stop - startLine))
    }

    // MARK: - Move

    public enum Direction { case up, down }

    /// Swap the selected line block with its neighbour, carrying the
    /// selection along so a repeated press keeps moving the same text.
    public static func moveLine(
        _ text: String, _ selection: NSRange, _ direction: Direction
    ) -> TextEdit? {
        let ns = text as NSString
        let span = lineSpan(in: text, for: selection)
        let block = ns.substring(with: span)

        switch direction {
        case .up:
            guard span.location > 0 else { return nil }
            let prev = ns.lineRange(for: NSRange(location: span.location - 1, length: 0))
            var prevText = ns.substring(with: prev)
            let hadNewline = prevText.hasSuffix("\n")
            if hadNewline { prevText.removeLast() }
            let combined = NSRange(
                location: prev.location,
                length: span.location + span.length - prev.location
            )
            let replacement = block + "\n" + prevText
            let out = ns.replacingCharacters(in: combined, with: replacement)
            return TextEdit(
                text: out,
                selection: NSRange(location: prev.location, length: span.length)
            )

        case .down:
            let afterBlock = span.location + span.length
            // The neighbour starts AFTER the newline that ends our block,
            // and must begin strictly inside the text. `afterBlock <
            // ns.length` is not enough: on a file ending in a newline the
            // last line leaves exactly that newline behind, which read as
            // "there is more below" and swapped the last line with itself.
            let nextStart = afterBlock + 1
            guard nextStart < ns.length else { return nil }
            let next = ns.lineRange(for: NSRange(location: nextStart, length: 0))
            var nextText = ns.substring(with: next)
            let nextHadNewline = nextText.hasSuffix("\n")
            if nextHadNewline { nextText.removeLast() }
            let combined = NSRange(
                location: span.location,
                length: next.location + next.length - span.location
            )
            var replacement = nextText + "\n" + block
            if nextHadNewline { replacement += "\n" }
            let out = ns.replacingCharacters(in: combined, with: replacement)
            return TextEdit(
                text: out,
                selection: NSRange(
                    location: span.location + (nextText as NSString).length + 1,
                    length: span.length
                )
            )
        }
    }

    // MARK: - Duplicate

    /// Copy the selected lines, inserting the copy above or below.
    /// The selection lands on the COPY, matching VS Code — so ⌥⇧↓ twice
    /// gives you three lines with the newest selected.
    public static func copyLine(
        _ text: String, _ selection: NSRange, _ direction: Direction
    ) -> TextEdit {
        let ns = text as NSString
        let span = lineSpan(in: text, for: selection)
        let block = ns.substring(with: span)
        switch direction {
        case .up:
            let out = ns.replacingCharacters(in: NSRange(location: span.location, length: 0),
                                             with: block + "\n")
            return TextEdit(text: out,
                            selection: NSRange(location: span.location, length: span.length))
        case .down:
            let insertAt = span.location + span.length
            let out = ns.replacingCharacters(in: NSRange(location: insertAt, length: 0),
                                             with: "\n" + block)
            return TextEdit(text: out,
                            selection: NSRange(location: insertAt + 1, length: span.length))
        }
    }

    /// Duplicate the exact selection in place. With an empty selection this
    /// duplicates the line, which is what every editor does with ⇧⌘D.
    public static func duplicate(_ text: String, _ selection: NSRange) -> TextEdit {
        if selection.length == 0 { return copyLine(text, selection, .down) }
        let ns = text as NSString
        let safe = NSRange(
            location: min(selection.location, ns.length),
            length: min(selection.length, ns.length - min(selection.location, ns.length))
        )
        let chunk = ns.substring(with: safe)
        let insertAt = safe.location + safe.length
        let out = ns.replacingCharacters(in: NSRange(location: insertAt, length: 0), with: chunk)
        return TextEdit(text: out, selection: NSRange(location: insertAt, length: safe.length))
    }

    // MARK: - Comments

    /// Line-comment token by file extension. `nil` means "this language has
    /// no line comment we know", and the command becomes a no-op rather
    /// than inserting something wrong into the file.
    public static func lineCommentToken(forExtension ext: String) -> String? {
        switch ext.lowercased() {
        case "swift", "ts", "tsx", "js", "jsx", "mts", "cts", "go", "rs",
             "c", "h", "cc", "cpp", "hpp", "m", "mm", "java", "kt", "scala",
             "cs", "php", "dart", "proto", "gradle":
            return "//"
        case "py", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "tf",
             "dockerfile", "makefile", "mk", "conf", "ini", "r", "pl", "ex", "exs":
            return "#"
        case "sql", "lua", "hs":
            return "--"
        case "vim":
            return "\""
        case "lisp", "clj", "el":
            return ";"
        default:
            return nil
        }
    }

    /// Toggle a line comment across the selected lines.
    ///
    /// Comments out unless EVERY non-blank line is already commented, which
    /// is the rule every editor uses: a mixed block commented-and-not
    /// becomes fully commented, and only a fully commented block
    /// uncomments. Toggling per line instead would scramble a mixed block.
    ///
    /// The token is inserted at the common indent, not at column 0, so
    /// indented code stays aligned.
    public static func toggleLineComment(
        _ text: String, _ selection: NSRange, token: String
    ) -> TextEdit {
        let ns = text as NSString
        let span = lineSpan(in: text, for: selection)
        let block = ns.substring(with: span)
        let lines = block.components(separatedBy: "\n")
        let meaningful = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !meaningful.isEmpty else { return TextEdit(text: text, selection: selection) }

        let allCommented = meaningful.allSatisfy {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix(token)
        }

        let out: [String]
        if allCommented {
            out = lines.map { line -> String in
                guard let r = line.range(of: token) else { return line }
                var stripped = line
                stripped.removeSubrange(r)
                // Also eat the single space we add when commenting.
                if stripped[r.lowerBound...].hasPrefix(" ") {
                    stripped.remove(at: r.lowerBound)
                }
                return stripped
            }
        } else {
            // Common indent = the shallowest non-blank line, so a nested
            // block keeps its shape instead of every token going to col 0.
            let indent = meaningful
                .map { $0.prefix(while: { $0 == " " || $0 == "\t" }).count }
                .min() ?? 0
            out = lines.map { line -> String in
                if line.trimmingCharacters(in: .whitespaces).isEmpty { return line }
                let idx = line.index(line.startIndex, offsetBy: min(indent, line.count))
                return String(line[..<idx]) + token + " " + String(line[idx...])
            }
        }
        let replacement = out.joined(separator: "\n")
        let newText = ns.replacingCharacters(in: span, with: replacement)
        return TextEdit(
            text: newText,
            selection: NSRange(location: span.location, length: (replacement as NSString).length)
        )
    }
}

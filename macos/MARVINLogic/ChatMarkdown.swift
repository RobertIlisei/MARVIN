// ChatMarkdown — block-level markdown parser for assistant chat output.
//
// MARVIN rendered assistant text as a single plain `Text`, so everything the
// model emits as markdown — `## headings`, `**bold**`, fenced code, pipe
// tables, lists — arrived as literal syntax. A findings table read as a wall of
// `|` characters, and code was indistinguishable from prose.
//
// SwiftUI's `AttributedString(markdown:)` handles INLINE markup (bold, italic,
// inline code, links) but deliberately does not do block structure: no
// headings, no fenced code, no tables, no lists. So this splits text into
// blocks; the view layer renders each one and defers inline styling back to
// `AttributedString`.
//
// Deliberately a pragmatic subset — the constructs models actually emit — not
// a CommonMark implementation. Anything unrecognised falls through as a
// paragraph, so unknown syntax degrades to today's behaviour rather than
// vanishing.
//
// Lives in MARVINLogic (no SwiftUI) so `swift run MARVINTests` can pin it.

import Foundation

public enum MarkdownBlock: Equatable {
    /// `#`…`######` — level 1...6.
    case heading(level: Int, text: String)
    /// Ordinary prose. Inline markup is resolved by the renderer.
    case paragraph(String)
    /// Fenced code. `language` is the info string (may be empty).
    case code(language: String, content: String)
    /// Pipe table with a header row and zero or more body rows.
    case table(headers: [String], rows: [[String]])
    /// Bullet or ordered list. Items keep their inline markup.
    case list(items: [String], ordered: Bool)
    /// `>` blockquote, joined across contiguous lines.
    case quote(String)
    /// `---` / `***` horizontal rule.
    case rule
}

public enum ChatMarkdown {
    /// Split raw assistant text into renderable blocks.
    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = text.components(separatedBy: .newlines)
        var i = 0
        var paragraph: [String] = []

        func flushParagraph() {
            let joined = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { blocks.append(.paragraph(joined)) }
            paragraph = []
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // ── Fenced code ──────────────────────────────────────────────
            if trimmed.hasPrefix("```") {
                flushParagraph()
                let language = String(trimmed.dropFirst(3))
                    .trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count {
                    let l = lines[i]
                    if l.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                    body.append(l)
                    i += 1
                }
                i += 1 // consume the closing fence (or run off the end)
                blocks.append(.code(language: language, content: body.joined(separator: "\n")))
                continue
            }

            // ── Heading ──────────────────────────────────────────────────
            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix { $0 == "#" }
                let level = hashes.count
                if level <= 6 {
                    let rest = trimmed.dropFirst(level)
                    // A heading needs whitespace after the hashes; `#tag` is prose.
                    if rest.first == " " || rest.isEmpty {
                        flushParagraph()
                        blocks.append(
                            .heading(
                                level: level,
                                text: rest.trimmingCharacters(in: .whitespaces)
                            )
                        )
                        i += 1
                        continue
                    }
                }
            }

            // ── Horizontal rule ──────────────────────────────────────────
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            // ── Pipe table ───────────────────────────────────────────────
            // Header row + a delimiter row of dashes is the signature; without
            // the delimiter it's just prose containing pipes.
            if trimmed.hasPrefix("|"), i + 1 < lines.count,
               isTableDelimiter(lines[i + 1]) {
                flushParagraph()
                let headers = splitRow(trimmed)
                var rows: [[String]] = []
                i += 2
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard l.hasPrefix("|") else { break }
                    rows.append(splitRow(l))
                    i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            // ── Lists ────────────────────────────────────────────────────
            if let (marker, _) = listMarker(trimmed) {
                flushParagraph()
                let ordered = (marker == .ordered)
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let (m, content) = listMarker(l), m == marker else { break }
                    items.append(content)
                    i += 1
                }
                blocks.append(.list(items: items, ordered: ordered))
                continue
            }

            // ── Blockquote ───────────────────────────────────────────────
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard l.hasPrefix(">") else { break }
                    quoted.append(
                        String(l.dropFirst()).trimmingCharacters(in: .whitespaces)
                    )
                    i += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }

            // ── Blank line closes a paragraph ────────────────────────────
            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            paragraph.append(line)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    // MARK: - Helpers

    private enum ListKind: Equatable { case bullet, ordered }

    /// Returns the list kind + the item's content, or nil when the line isn't
    /// a list item.
    private static func listMarker(_ line: String) -> (ListKind, String)? {
        for bullet in ["- ", "* ", "• "] where line.hasPrefix(bullet) {
            return (.bullet, String(line.dropFirst(bullet.count)))
        }
        // `1. ` / `12) `
        let digits = line.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 3 {
            let rest = line.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
                return (.ordered, String(rest.dropFirst(2)))
            }
        }
        return nil
    }

    /// A table delimiter looks like `|---|:--:|---|` — pipes, dashes, colons,
    /// spaces, and at least one dash.
    static func isTableDelimiter(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("|"), t.contains("-") else { return false }
        return t.allSatisfy { $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " }
    }

    /// Split a `| a | b |` row into trimmed cells, dropping the empty leading
    /// and trailing fields the outer pipes create.
    static func splitRow(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t = String(t.dropFirst()) }
        if t.hasSuffix("|") { t = String(t.dropLast()) }
        return t.components(separatedBy: "|").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    /// Map a fence info string to a file extension the syntax highlighter
    /// understands (it keys off extensions, not language names).
    public static func fileExtension(forLanguage language: String) -> String? {
        let l = language.lowercased().trimmingCharacters(in: .whitespaces)
        switch l {
        case "swift": return "swift"
        case "ts", "typescript": return "ts"
        case "tsx": return "tsx"
        case "js", "javascript": return "js"
        case "jsx": return "jsx"
        case "go": return "go"
        case "rust", "rs": return "rs"
        case "json": return "json"
        case "html": return "html"
        case "c": return "c"
        case "cpp", "c++", "cc": return "cpp"
        case "bash", "sh", "shell", "zsh": return "sh"
        case "yaml", "yml": return "yaml"
        case "markdown", "md": return "md"
        case "python", "py": return "py"
        default: return nil
        }
    }
}

/// One clickable span found in a rendered paragraph.
///
/// Detection is pure string work, so it lives here and gets pinned by tests;
/// the view layer only applies attributes to the ranges this returns. The two
/// kinds are styled differently — a web link gets the accent colour, a file
/// reference keeps its inline-code look and just gains an underline.
public struct MarkdownLinkSpan: Equatable {
    public enum Kind: Equatable { case web, file }
    public let range: NSRange
    public let url: URL
    public let kind: Kind

    public init(range: NSRange, url: URL, kind: Kind) {
        self.range = range
        self.url = url
        self.kind = kind
    }
}

public enum MarkdownLinks {
    /// Private URL scheme for in-app file navigation. `MarkdownView` intercepts
    /// it; every other scheme falls through to the system browser.
    public static let fileScheme = "marvin-file"

    /// Bare `http(s)://…`. Foundation's inline-only markdown parse does NOT
    /// autolink these, so a pasted URL rendered as visible-but-dead text.
    /// Trailing sentence punctuation is excluded from the match.
    public static func webSpans(in text: String) -> [MarkdownLinkSpan] {
        guard text.contains("http") else { return [] }
        let pattern = #"https?://[^\s<>\)\]\"']+"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        var out: [MarkdownLinkSpan] = []
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var raw = ns.substring(with: m.range)
            while let last = raw.last, ".,;:!?".contains(last) { raw.removeLast() }
            guard !raw.isEmpty, let url = URL(string: raw) else { continue }
            out.append(
                MarkdownLinkSpan(
                    range: NSRange(location: m.range.location, length: (raw as NSString).length),
                    url: url,
                    kind: .web
                )
            )
        }
        return out
    }

    /// `path/to/File.swift`, with an optional `:120` or `:120-140` suffix.
    ///
    /// Only paths that actually resolve under `workDir` become links — models
    /// mention filenames constantly, and a link that opens nothing is worse
    /// than plain text. `exists` is injectable so tests don't touch disk.
    public static func fileSpans(
        in text: String,
        workDir: String?,
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> [MarkdownLinkSpan] {
        guard let workDir, !workDir.isEmpty else { return [] }
        let pattern = #"(?<![\w/.-])(/?(?:[\w.-]+/)*[\w.-]+\.[A-Za-z][\w]{0,9})(?::(\d+)(?:-\d+)?)?"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        var out: [MarkdownLinkSpan] = []
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let pathPart = ns.substring(with: m.range(at: 1))
            let abs = pathPart.hasPrefix("/")
                ? pathPart
                : (workDir as NSString).appendingPathComponent(pathPart)
            guard exists(abs) else { continue }
            var comps = URLComponents()
            comps.scheme = fileScheme
            // The path lands in the URL's host+path; force an empty host so
            // `marvin-file:///abs/path` round-trips through URL.path cleanly.
            comps.host = ""
            comps.path = abs
            if m.range(at: 2).location != NSNotFound {
                comps.queryItems = [
                    URLQueryItem(name: "line", value: ns.substring(with: m.range(at: 2)))
                ]
            }
            guard let url = comps.url else { continue }
            out.append(MarkdownLinkSpan(range: m.range, url: url, kind: .file))
        }
        return out
    }
}

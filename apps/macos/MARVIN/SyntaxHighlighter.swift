// SyntaxHighlighter — Phase 5b.2. Wraps SwiftTreeSitter (the
// ChimeHQ Swift binding around tree-sitter's C library) in a small
// surface tailored to what `FileViewerView` needs: detect language
// from a file extension, parse + run the highlight query, return the
// per-byte-range capture name.
//
// The caller (FileViewerNSView) maps capture names to NSColor and
// applies the colour as `.foregroundColor` attributes on the
// STTextView's text storage. Theme decisions live there; this file
// stays language-pure.
//
// ## Why we keep this layer thin
//
// SwiftTreeSitter exposes Parser / Language / Query / QueryCursor
// directly, and the language packages (TreeSitterSwift,
// TreeSitterTypeScript) expose the C `tree_sitter_<lang>()` factory
// via their public headers. The vocabulary the highlighter uses is
// already the right shape; wrapping in a heavier abstraction
// (Highlighter / TreeSitterClient / Neon) buys async re-highlighting
// + edit tracking which we don't need at 5b (read-only viewer).
// 5c may pull Neon in if the editing path needs incremental updates.
//
// ## Cost
//
// Cold parse of a ~1k-line file: <10 ms on Apple Silicon. Query
// execution adds ~5 ms. The highlighter runs once per file load on
// the main actor; for 5b's read-only viewer that's fine. 5c moves
// it to a background actor when editing introduces re-parses on
// every keystroke.

import AppKit
import Foundation
import SwiftTreeSitter
import TreeSitterGo
import TreeSitterRust
import TreeSitterSwift
import TreeSitterTypeScript

/// One highlight span returned by the highlighter. The caller
/// applies a colour to `range` based on `captureName`. Multiple
/// spans can overlap — when that happens the caller decides which
/// wins (later capture wins, in tree-sitter convention).
struct HighlightSpan {
    /// UTF-16-keyed character range, ready to feed into
    /// `addAttributes(_:range:)`. SwiftTreeSitter's
    /// `QueryCapture.range` is already an NSRange.
    let range: NSRange
    /// Tree-sitter capture name, e.g. "keyword", "function.method",
    /// "string.escape". Hierarchical via dots; the theme matcher
    /// can fall back to the prefix ("function.method" → "function")
    /// for captures it doesn't have a specific colour for.
    let captureName: String
}

/// Supported source languages — extend this enum + the
/// `languageFor(extension:)` switch to add a language.
enum HighlightLanguage: String {
    case swift
    case typescript
    case go
    case rust

    /// Pick a language by lowercased file extension (no leading
    /// dot). Returns nil for unsupported extensions; the viewer
    /// falls back to plain text rendering when nil.
    static func forExtension(_ ext: String) -> HighlightLanguage? {
        switch ext.lowercased() {
        case "swift":
            return .swift
        case "ts", "tsx", "js", "jsx", "mjs", "cjs":
            // tree-sitter-typescript's grammar is a superset of
            // JavaScript and accepts both. tsx inherits the same
            // parser at this scope. Treating .js as TS gives us
            // the same keyword/type highlighting at no extra cost.
            return .typescript
        case "go":
            return .go
        case "rs":
            return .rust
        default:
            return nil
        }
    }

    /// Bridge to the C `tree_sitter_<lang>()` factory. SwiftTreeSitter
    /// wraps the OpaquePointer in a Swift `Language` value.
    fileprivate var tsLanguage: Language {
        switch self {
        case .swift:
            return Language(language: tree_sitter_swift())
        case .typescript:
            return Language(language: tree_sitter_typescript())
        case .go:
            return Language(language: tree_sitter_go())
        case .rust:
            return Language(language: tree_sitter_rust())
        }
    }

    /// Resource basename (without extension) for the highlights
    /// query. Files live in MARVIN/Resources/Queries/ and are
    /// copied into the .app's Contents/Resources/Queries/ by the
    /// install script (see bin/marvin's install-macos-app body).
    fileprivate var queryResourceName: String {
        rawValue
    }
}

/// Stateless façade for the highlighter. Caches Language + Query
/// per supported language because both are expensive to build (the
/// query parser walks the .scm DSL on every init) and trivially
/// thread-safe to share read-only.
@MainActor
enum SyntaxHighlighter {
    /// Cache keyed by language. We keep the parser per-language
    /// too because Parser allocates internal buffers on first use.
    private static var cache: [HighlightLanguage: (Parser, Query)] = [:]

    /// Highlight `content` against the language picked from `ext`.
    /// Returns nil when:
    ///   - the extension isn't in `HighlightLanguage.forExtension`
    ///   - the parser fails to produce a tree (corrupt / huge files)
    ///   - the bundled query file is missing or malformed
    /// Errors short-circuit to nil so the viewer falls back to
    /// plain text — broken highlighting must never block the read.
    static func highlight(
        content: String,
        fileExtension ext: String
    ) -> [HighlightSpan]? {
        guard let language = HighlightLanguage.forExtension(ext) else {
            return nil
        }
        guard let (parser, query) = parserAndQuery(for: language) else {
            return nil
        }
        guard let tree = parser.parse(content),
              let root = tree.rootNode else {
            return nil
        }

        // QueryCursor walks the matches; we collect captures into a
        // flat array. tree-sitter-style "later capture wins" is
        // already implicit in the array's order — the caller
        // applies attributes in iteration order, so a later
        // colour overrides an earlier one for the same byte.
        let cursor = query.execute(node: root, in: tree)
        var spans: [HighlightSpan] = []
        spans.reserveCapacity(256)
        while let capture = cursor.nextCapture() {
            guard let name = capture.name else { continue }
            spans.append(HighlightSpan(range: capture.range, captureName: name))
        }
        return spans
    }

    /// Lazily build (and cache) the parser + query for `language`.
    /// Failures (missing query file, query compile error) cache
    /// nothing and return nil so a follow-up install with the
    /// resource present can recover without a process restart.
    private static func parserAndQuery(
        for language: HighlightLanguage
    ) -> (Parser, Query)? {
        if let hit = cache[language] {
            return hit
        }
        let parser = Parser()
        do {
            try parser.setLanguage(language.tsLanguage)
        } catch {
            NSLog("[SyntaxHighlighter] setLanguage(\(language.rawValue)) failed: \(error)")
            return nil
        }
        guard let queryURL = Bundle.main.url(
            forResource: language.queryResourceName,
            withExtension: "scm",
            subdirectory: "Queries"
        ) else {
            NSLog("[SyntaxHighlighter] missing Queries/\(language.queryResourceName).scm in .app bundle")
            return nil
        }
        do {
            let data = try Data(contentsOf: queryURL)
            let query = try Query(language: language.tsLanguage, data: data)
            cache[language] = (parser, query)
            return (parser, query)
        } catch {
            NSLog("[SyntaxHighlighter] query compile failed for \(language.rawValue): \(error)")
            return nil
        }
    }
}

// MARK: - Theme

/// Capture-name → colour mapping. Two flavours, light and dark,
/// chosen to match the WebView's Monaco theme tokens at coarse
/// granularity. We don't try to ship every Monaco token; the
/// goal at 5b is "code reads as code, not as undifferentiated
/// monospace text". Add specific captures here as the highlighting
/// gaps become noticeable in real-world files.
///
/// Hierarchical capture lookup: a capture like `function.method`
/// falls back to `function` if the specific case isn't present.
/// `colorFor` walks the dot-separated prefix until a hit.
enum HighlightTheme {
    static func color(
        forCapture capture: String,
        isDark: Bool
    ) -> NSColor? {
        // Walk dot-separated prefix from longest to shortest.
        // "function.method" tries "function.method" → "function".
        var key = capture
        while !key.isEmpty {
            if let color = direct(key, isDark: isDark) {
                return color
            }
            if let dot = key.lastIndex(of: ".") {
                key = String(key[..<dot])
            } else {
                return nil
            }
        }
        return nil
    }

    private static func direct(_ key: String, isDark: Bool) -> NSColor? {
        switch key {
        case "comment":
            return isDark
                ? NSColor(red: 0.42, green: 0.51, blue: 0.55, alpha: 1)
                : NSColor(red: 0.36, green: 0.43, blue: 0.46, alpha: 1)
        case "keyword", "keyword.return", "keyword.exception":
            return isDark
                ? NSColor(red: 0.78, green: 0.50, blue: 0.85, alpha: 1)
                : NSColor(red: 0.55, green: 0.18, blue: 0.65, alpha: 1)
        case "keyword.function", "keyword.type", "keyword.import",
             "keyword.modifier", "keyword.coroutine", "keyword.directive",
             "keyword.repeat", "keyword.conditional", "keyword.operator":
            return isDark
                ? NSColor(red: 0.74, green: 0.55, blue: 0.91, alpha: 1)
                : NSColor(red: 0.50, green: 0.20, blue: 0.70, alpha: 1)
        case "string", "string.escape", "string.regexp", "escape":
            // `escape` is a tree-sitter capture used by Python /
            // Go highlights to mark escape sequences inside string
            // literals (`\n`, `\t`, `\xff`). Treat it as the same
            // colour family as the surrounding string — the slight
            // alpha shift reads as "this is part of the string but
            // structurally distinct" without adding theme noise.
            return isDark
                ? NSColor(red: 0.72, green: 0.83, blue: 0.55, alpha: 1)
                : NSColor(red: 0.30, green: 0.55, blue: 0.20, alpha: 1)
        case "number", "boolean", "constant", "constant.builtin",
             "constant.macro":
            return isDark
                ? NSColor(red: 0.95, green: 0.69, blue: 0.50, alpha: 1)
                : NSColor(red: 0.65, green: 0.40, blue: 0.10, alpha: 1)
        case "function", "function.call", "function.method",
             "function.macro", "constructor":
            return isDark
                ? NSColor(red: 0.51, green: 0.78, blue: 0.95, alpha: 1)
                : NSColor(red: 0.10, green: 0.40, blue: 0.75, alpha: 1)
        case "type", "type.builtin":
            return isDark
                ? NSColor(red: 0.40, green: 0.85, blue: 0.95, alpha: 1)
                : NSColor(red: 0.05, green: 0.50, blue: 0.65, alpha: 1)
        case "variable.parameter":
            return isDark
                ? NSColor(red: 0.92, green: 0.78, blue: 0.55, alpha: 1)
                : NSColor(red: 0.55, green: 0.35, blue: 0.10, alpha: 1)
        case "variable.builtin", "variable.member", "property":
            // `property` is what Python / Rust / Go highlights use
            // for member-access right-hand sides (`obj.field`).
            // Same colour family as `variable.member` — they're the
            // same concept under different language conventions.
            return isDark
                ? NSColor(red: 0.86, green: 0.68, blue: 0.95, alpha: 1)
                : NSColor(red: 0.45, green: 0.25, blue: 0.55, alpha: 1)
        case "operator", "punctuation.special", "attribute":
            return isDark
                ? NSColor(red: 0.75, green: 0.78, blue: 0.82, alpha: 1)
                : NSColor(red: 0.30, green: 0.32, blue: 0.36, alpha: 1)
        case "punctuation.delimiter", "punctuation.bracket",
             "label", "character.special":
            return isDark
                ? NSColor(red: 0.62, green: 0.65, blue: 0.70, alpha: 1)
                : NSColor(red: 0.40, green: 0.42, blue: 0.45, alpha: 1)
        case "comment.documentation":
            return isDark
                ? NSColor(red: 0.55, green: 0.65, blue: 0.55, alpha: 1)
                : NSColor(red: 0.30, green: 0.45, blue: 0.30, alpha: 1)
        default:
            return nil
        }
    }
}

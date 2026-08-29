// SourceDecorations — pure parsers behind two editor affordances: inline
// colour chips beside hex literals, and the front-matter table at the top of a
// rendered Markdown file.
//
// Lives in MARVINLogic, not the app target, for the ADR-0022 reason: an
// executable target cannot be linked from `MARVINTests`, so anything with edge
// cases worth pinning has to sit in the library. Both parsers here have plenty
// — 3/6/8-digit hex, `rgb()` vs `rgba()`, nested YAML indentation — and none of
// it needs AppKit. The app target adds the colour construction and the drawing.

import Foundation

/// A colour literal found in source text, as channel values in 0...1.
/// Deliberately not an `NSColor`: this type crosses into the pure library,
/// and the caller builds whatever colour type its UI framework wants.
public struct ColorLiteral: Equatable {
    /// Range of the literal in the ORIGINAL string, in UTF-16 units (the unit
    /// AppKit's attributed strings and `NSRange` use).
    public let location: Int
    public let length: Int
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(location: Int, length: Int, red: Double, green: Double, blue: Double, alpha: Double) {
        self.location = location
        self.length = length
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }
}

public enum ColorLiteralScanner {
    // `#` or `0x`, then 3/6/8 hex digits, not glued to another word character
    // — so `#deadbeef` in prose matches but `abc#123def` and an 7-digit run
    // do not.
    private static let hexPattern =
        "(?<![0-9A-Za-z_])(?:#|0[xX])([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})(?![0-9A-Za-z_])"
    private static let rgbPattern =
        "rgba?\\(\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*(?:,\\s*([0-9.]+)\\s*)?\\)"

    private static let hexRE = try? NSRegularExpression(pattern: hexPattern)
    private static let rgbRE = try? NSRegularExpression(pattern: rgbPattern, options: [.caseInsensitive])

    /// Every colour literal in `text`, in source order.
    ///
    /// `limit` caps the result because the chips are decoration: a generated
    /// palette with thousands of entries must not turn a keystroke into a
    /// layout pass.
    public static func scan(_ text: String, limit: Int = 500) -> [ColorLiteral] {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        var out: [ColorLiteral] = []

        hexRE?.enumerateMatches(in: text, range: full) { m, _, stop in
            guard let m, m.numberOfRanges >= 2 else { return }
            guard out.count < limit else { stop.pointee = true; return }
            let digits = ns.substring(with: m.range(at: 1))
            guard let c = channels(fromHex: digits) else { return }
            out.append(ColorLiteral(
                location: m.range.location, length: m.range.length,
                red: c.0, green: c.1, blue: c.2, alpha: c.3
            ))
        }

        rgbRE?.enumerateMatches(in: text, range: full) { m, _, stop in
            guard let m, m.numberOfRanges >= 4 else { return }
            guard out.count < limit else { stop.pointee = true; return }
            func channel(_ i: Int) -> Double? {
                let r = m.range(at: i)
                guard r.location != NSNotFound, let v = Int(ns.substring(with: r)), (0...255).contains(v)
                else { return nil }
                return Double(v) / 255
            }
            guard let r = channel(1), let g = channel(2), let b = channel(3) else { return }
            var a = 1.0
            let alphaRange = m.range(at: 4)
            if alphaRange.location != NSNotFound, let v = Double(ns.substring(with: alphaRange)) {
                a = min(max(v, 0), 1)
            }
            out.append(ColorLiteral(
                location: m.range.location, length: m.range.length,
                red: r, green: g, blue: b, alpha: a
            ))
        }

        return out.sorted { $0.location < $1.location }
    }

    /// 3 / 6 / 8 hex digits → channels. Eight digits are RRGGBB**AA** (the CSS
    /// order), not AARRGGBB — the web spelling is the one design tokens use.
    public static func channels(fromHex digits: String) -> (Double, Double, Double, Double)? {
        var value: UInt64 = 0
        guard Scanner(string: digits).scanHexInt64(&value) else { return nil }
        func f(_ v: UInt64) -> Double { Double(v) / 255 }
        switch digits.count {
        case 3:
            // #abc expands to #aabbcc — each nibble doubled, hence ×17.
            let r = (value >> 8) & 0xF, g = (value >> 4) & 0xF, b = value & 0xF
            return (f(r * 17), f(g * 17), f(b * 17), 1)
        case 6:
            return (f((value >> 16) & 0xFF), f((value >> 8) & 0xFF), f(value & 0xFF), 1)
        case 8:
            return (
                f((value >> 24) & 0xFF), f((value >> 16) & 0xFF),
                f((value >> 8) & 0xFF), f(value & 0xFF)
            )
        default:
            return nil
        }
    }
}

/// A leading `---` YAML block split off a Markdown document.
public enum MarkdownFrontMatterParser {
    /// Returns the flattened front-matter pairs and the remaining body.
    ///
    /// Nested keys are dotted (`colors.primary`) because the point is to SEE
    /// the values; a faithful YAML tree would need a YAML parser, and the
    /// front matter in these files is a flat-ish token map. A line that is not
    /// `key: value` is skipped rather than guessed at, and a document with no
    /// front matter comes back unchanged.
    public static func split(_ text: String) -> (frontMatter: [(key: String, value: String)], body: String) {
        let lines = text.components(separatedBy: "\n")
        guard let first = lines.first, first.trimmingCharacters(in: .whitespaces) == "---" else {
            return ([], text)
        }
        guard let closingOffset = lines.dropFirst().firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces) == "---"
        }) else {
            // An opening fence with no close is not front matter — it is a
            // horizontal rule and the rest of the document.
            return ([], text)
        }

        var pairs: [(key: String, value: String)] = []
        var stack: [(indent: Int, key: String)] = []
        for raw in lines[1..<closingOffset] {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            guard let colon = trimmed.firstIndex(of: ":") else { continue }
            let key = String(trimmed[trimmed.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            var value = String(trimmed[trimmed.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            let indent = raw.prefix(while: { $0 == " " }).count

            while let last = stack.last, last.indent >= indent { stack.removeLast() }
            if value.isEmpty {
                // A parent key (`colors:`) — carries no value of its own.
                stack.append((indent, key))
                continue
            }
            pairs.append((key: (stack.map(\.key) + [key]).joined(separator: "."), value: value))
        }
        let body = lines[(closingOffset + 1)...].joined(separator: "\n")
        return (pairs, body)
    }
}

// SessionTabStrip — what the chat tab strip shows when there are many tabs
// (UX review W-07).
//
// On 2026-11-24 fourteen tabs were open and every title read "# GA…" or
// "# RE…": the titles are the first message, which for a brief starts with a
// markdown heading or a path, and the cut left only the noise. This file is
// the pure part of the fix: a short title that identifies the tab, the width
// rule, which tabs stay pinned when the strip scrolls, and the words and
// symbol the overflow list prints for a tab's state.

import Foundation

public enum SessionTabTitle {
    /// A short, readable title from what was typed: leading markdown marks and
    /// list numbering dropped, emphasis and backticks removed, a file path
    /// reduced to its file name, cut at a word boundary. Empty when the text
    /// holds nothing to name a tab by; the caller then falls back.
    public static func display(_ raw: String, maxLength: Int = 28) -> String {
        for line in raw.split(whereSeparator: \.isNewline) {
            let cleaned = clean(String(line))
            if cleaned.contains(where: { $0.isLetter || $0.isNumber }) {
                return cut(cleaned, to: maxLength)
            }
        }
        return ""
    }

    private static let leadingMarks: Set<Character> = ["#", ">", "*", "-", "+", "_", "=", "`", "\u{2022}", " ", "\t"]

    private static func clean(_ line: String) -> String {
        var text = Substring(line)
        while let first = text.first, leadingMarks.contains(first) { text = text.dropFirst() }
        var s = String(text)
        // "1. " / "2) " list numbers, and "[ ]" / "[x]" checkboxes.
        s = s.replacingOccurrences(of: #"^\d{1,3}[.)]\s+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^\[[ xX]\]\s*"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
        let words = s.split(whereSeparator: { $0 == " " || $0 == "\t" }).map { word -> String in
            looksLikePath(word) ? basename(word) : String(word)
        }
        return words.joined(separator: " ")
    }

    private static func looksLikePath(_ word: Substring) -> Bool {
        guard word.contains("/"), !word.contains("://") else { return false }
        if word.hasPrefix("/") || word.hasPrefix("~/") || word.hasPrefix("./") || word.hasPrefix("../") { return true }
        if word.filter({ $0 == "/" }).count >= 2 { return true }
        // One slash is "and/or" unless the last part is a file name.
        return word.split(separator: "/").last.map { $0.range(of: #"\.[A-Za-z0-9]{1,5}$"#, options: .regularExpression) != nil } ?? false
    }

    /// `briefs/v31/ux-public-pages.md` becomes `ux public pages`.
    private static func basename(_ path: Substring) -> String {
        var last = String(path.split(separator: "/").last ?? path)
        if let dot = last.lastIndex(of: "."), dot != last.startIndex { last = String(last[..<dot]) }
        return last.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
    }

    private static func cut(_ s: String, to maxLength: Int) -> String {
        guard maxLength > 1, s.count > maxLength else { return s }
        let head = String(s.prefix(maxLength))
        var body: String
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > maxLength / 2 {
            body = String(head[..<space])
        } else {
            body = String(s.prefix(maxLength - 1))
        }
        while let last = body.last, " \u{2014}\u{2013}-:,;".contains(last) { body.removeLast() }
        return body + "\u{2026}"
    }
}

public enum TabStripLayout {
    public static let minWidth: CGFloat = 128
    public static let maxWidth: CGFloat = 190
    public static let spacing: CGFloat = 4

    public struct Metrics: Equatable, Sendable {
        public let tabWidth: CGFloat
        /// False when the tabs are at their minimum and some run past the edge.
        public let fitsAll: Bool
        public init(tabWidth: CGFloat, fitsAll: Bool) { self.tabWidth = tabWidth; self.fitsAll = fitsAll }
    }

    public static func metrics(tabCount: Int, available: CGFloat) -> Metrics {
        let share = floor(max(0, available) / CGFloat(max(1, tabCount))) - spacing
        return Metrics(tabWidth: min(maxWidth, max(minWidth, share)), fitsAll: share >= minWidth)
    }

    /// Tabs that need the person stay on screen even when the strip scrolls:
    /// they are repeated, in strip order, next to the overflow list. Nothing is
    /// pinned while every tab fits, and past `limit` the overflow list carries them.
    public static func pinned(_ tabs: [(id: String, state: SessionRowState)], fitsAll: Bool, limit: Int = 3) -> [String] {
        guard !fitsAll else { return [] }
        let ids = tabs.compactMap { tab -> String? in
            if case .needsYou = tab.state { return tab.id }
            return nil
        }
        return Array(ids.prefix(limit))
    }
}

public enum SessionStateLabel {
    /// The SF Symbol for a state, so a list can show what the tab's own glyph shows.
    public static func symbol(_ state: SessionRowState) -> String {
        switch state {
        case .needsYou: return "hand.raised.fill"
        case .working: return "arrow.triangle.2.circlepath"
        case .interrupted: return "arrow.clockwise"
        case .failed: return "xmark"
        case .waiting: return "clock"
        case .finished: return "checkmark.circle.fill"
        case .done: return "checkmark"
        case .idle: return "circle"
        case .draft: return "bubble.left"
        }
    }

    /// "needs you", "waiting 46 min", "finished, not reviewed" ...
    public static func caption(_ state: SessionRowState, waitingSince: Date?, now: Date) -> String {
        switch state {
        case .needsYou(let n): return n > 1 ? "needs you (\(n))" : "needs you"
        case .working: return "working"
        case .interrupted: return "cut off, can resume"
        case .failed: return "failed"
        case .waiting: return waitingSince.map { "waiting \(SessionWait.duration(since: $0, now: now))" } ?? "waiting"
        case .finished: return "finished, not reviewed"
        case .done: return "done"
        case .idle: return "idle"
        case .draft: return "new"
        }
    }
}

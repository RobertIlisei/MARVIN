// EditorTabLayout — how the editor's tab bar spends its width (owner, 25.11.2026:
// "it shows like a full line of text, for no reason").
//
// A tab is a label for switching, not a place to read a 150-character file name.
// The bar used to give every tab its whole name: an ADR called
// `0659-a-delegated-session-reads-…-administrator-b87.md` made one tab as wide as
// the editor and squeezed its neighbour to `14ebe4.md`, cut from the FRONT.
//
// The decisions live here, as values, and the view only draws them:
//
//   • a tab is never wider than `EditorTabWidths.maxWidth` nor narrower than
//     `minWidth`; a long name is cut in the MIDDLE (`EditorTabTitle.shorten`), so
//     the start that tells files apart and the extension that tells their kind
//     both stay;
//   • when the tabs do not fit, the widest give way first and the short ones keep
//     the width they have (`distribute`: water-filling toward the minimum); only
//     when every tab is at the minimum does the bar scroll;
//   • two files with one base name show their nearest folder as a quieter
//     qualifier, because cutting names makes collisions more likely
//     (`EditorTabQualifiers`);
//   • the file header's path line is the same idea for one line of text
//     (`EditorHeaderPath`): the folder is shortened from the front, the name
//     keeps its start and its extension.
//
// Widths are in points, lengths in characters: the tab font is monospaced, so a
// character budget is exact and the view needs no text measurement.

import CoreGraphics
import Foundation

// MARK: - Shortening a name

public enum EditorTabTitle {
    /// Advance of one character of the 12 pt system monospaced font (measured: 7.418 pt),
    /// rounded up so a label never asks for more room than it was given. At 7.3 the
    /// header's path line overflowed by a character and SwiftUI cut it a second time.
    public static let charWidth: CGFloat = 7.45
    static let ellipsis = "\u{2026}"
    /// Characters of the start that always survive, so a cut name still says which file it is.
    static let minHead = 3

    /// `name` in at most `maxChars` characters. Cut in the middle: the start, an
    /// ellipsis, then the extension with the last two characters before it
    /// (`0659-a-deleg…87.md`). Never cut from the front. Below the budget that
    /// keeps a start, a tail and the ellipsis, the tail goes before the start does.
    public static func shorten(_ name: String, maxChars: Int) -> String {
        let chars = Array(name)
        if chars.count <= maxChars { return name }
        if maxChars <= 1 { return ellipsis }
        let ext = (name as NSString).pathExtension
        let hasExt = !ext.isEmpty && ext.count <= 6
        let extTail = hasExt ? "." + ext : ""
        let stem = hasExt ? String(chars.dropLast(extTail.count)) : name
        let stemChars = Array(stem)
        let tails: [String] = hasExt
            ? [String(stemChars.suffix(2)) + extTail, extTail]
            : [String(stemChars.suffix(5)), String(stemChars.suffix(3))]
        for tail in tails {
            let head = maxChars - 1 - tail.count
            if head >= minHead && head + tail.count < chars.count {
                return String(chars.prefix(head)) + ellipsis + tail
            }
        }
        return String(chars.prefix(maxChars - 1)) + ellipsis
    }

    /// `qualifier` (a folder path) in at most `maxChars`, keeping the end, the part
    /// nearest the file.
    static func shortenQualifier(_ qualifier: String, maxChars: Int) -> String {
        let chars = Array(qualifier)
        if chars.count <= maxChars { return qualifier }
        if maxChars <= 1 { return ellipsis }
        return ellipsis + String(chars.suffix(maxChars - 1))
    }

    public struct Fit: Equatable, Sendable {
        public let name: String
        public let qualifier: String?
        public init(name: String, qualifier: String?) { self.name = name; self.qualifier = qualifier }
    }

    /// The tab label for a `budget` of characters, a space between name and folder
    /// included. The name keeps what it needs; the folder takes what is left, never
    /// fewer than three characters. When even that would cut the name below seven
    /// characters the folder is left out of the label (it stays in the tooltip).
    public static func fit(name: String, qualifier: String?, budget: Int) -> Fit {
        guard let qualifier, !qualifier.isEmpty else {
            return Fit(name: shorten(name, maxChars: budget), qualifier: nil)
        }
        let available = budget - 1
        if name.count + qualifier.count <= available {
            return Fit(name: name, qualifier: qualifier)
        }
        let qMin = 3
        let remainder = available - name.count
        if remainder >= qMin {
            return Fit(name: name, qualifier: shortenQualifier(qualifier, maxChars: remainder))
        }
        let nameMin = min(name.count, 7)
        let qShare = max(qMin, min(qualifier.count, available / 3))
        let nameLen = available - qShare
        if nameLen >= nameMin {
            return Fit(name: shorten(name, maxChars: nameLen),
                       qualifier: shortenQualifier(qualifier, maxChars: qShare))
        }
        return Fit(name: shorten(name, maxChars: budget), qualifier: nil)
    }
}

// MARK: - Equal base names

public enum EditorTabQualifiers {
    /// For every path whose file name another open path shares: the shortest tail of
    /// its folders (relative to `root` when inside it) that tells it from the others
    /// ("api", then "x/api" when the parent name collides too). A file at the
    /// project root is "/". Paths with a unique name are not in the result.
    public static func qualifiers(for paths: [String], root: String?) -> [String: String] {
        func folders(_ path: String) -> [String] {
            let relative = root.flatMap { WorkspaceRelativePath.of(path, in: $0) } ?? path
            return relative.split(separator: "/").dropLast().map(String.init)
        }
        func name(_ path: String) -> String { (path as NSString).lastPathComponent }

        var groups: [String: [String]] = [:]
        for p in paths { groups[name(p), default: []].append(p) }
        var out: [String: String] = [:]
        for (_, members) in groups where members.count > 1 {
            let parts = members.map { folders($0) }
            let deepest = parts.map(\.count).max() ?? 0
            var depth = 1
            func label(_ comps: [String], _ k: Int) -> String {
                comps.isEmpty ? "/" : comps.suffix(k).joined(separator: "/")
            }
            while depth < deepest {
                let labels = parts.map { label($0, depth) }
                if Set(labels).count == labels.count { break }
                depth += 1
            }
            for (i, p) in members.enumerated() { out[p] = label(parts[i], depth) }
        }
        return out
    }
}

// MARK: - Widths

public enum EditorTabWidths {
    /// The longest a tab gets, whatever its name: about six tabs in a 1,250 pt editor
    /// (Miller: a bar that holds more than seven or so stops being scanned).
    public static let maxWidth: CGFloat = 200
    /// The shortest: icon, eleven characters and a 24 pt close target.
    public static let minWidth: CGFloat = 144
    public static let spacing: CGFloat = 1
    /// What a tab spends outside its text: 8 leading, a 12 pt icon, 6, then 6 and
    /// a 24 pt close target (Fitts: a desktop pointer target of at least 24 pt) and 4 trailing.
    public static let chrome: CGFloat = 60
    /// The modified dot (6) and its gap (6), present only on a tab with unsaved changes.
    public static let dirtyExtra: CGFloat = 12

    /// The width each tab gets (`ideals`: what each would like) in a bar `available`
    /// points wide, and whether the bar has to scroll. Every width is clamped to
    /// `minWidth...maxWidth`. When the wishes fit they are granted as they are; when
    /// not, the widest are brought down to a common level, so a short name keeps what
    /// it has and no long one takes the bar from the others. Only when every tab is
    /// at the minimum and the bar is still too narrow does it overflow.
    public static func distribute(ideals: [CGFloat], available: CGFloat) -> (widths: [CGFloat], overflows: Bool) {
        let n = ideals.count
        guard n > 0 else { return ([], false) }
        let wishes = ideals.map { min(maxWidth, max(minWidth, $0)) }
        let gaps = spacing * CGFloat(n - 1)
        if wishes.reduce(0, +) + gaps <= available { return (wishes, false) }
        if CGFloat(n) * minWidth + gaps > available {
            return ([CGFloat](repeating: minWidth, count: n), true)
        }
        var remaining = available - gaps
        var level = minWidth
        let sorted = wishes.sorted()
        for (i, wish) in sorted.enumerated() {
            let share = remaining / CGFloat(n - i)
            if wish <= share {
                remaining -= wish
            } else {
                level = max(minWidth, floor(share))
                break
            }
        }
        return (wishes.map { min($0, level) }, false)
    }
}

// MARK: - The whole bar

/// Everything the tab bar draws, decided in one call.
public struct EditorTabPlan: Equatable, Sendable {
    public struct Tab: Equatable, Sendable {
        public let path: String
        /// The whole file name, never cut. For the accessibility label and the tooltip.
        public let fileName: String
        public let shownName: String
        /// The folder, shown quieter after the name, only when another open file has this name.
        public let shownQualifier: String?
        public let width: CGFloat
        /// Tooltip: the path from the project root (the absolute path outside it).
        public let help: String
        public let accessibilityLabel: String
    }
    public let tabs: [Tab]
    /// True when the tabs are at their minimum and some run past the edge.
    public let overflows: Bool

    public static func make(paths: [String], root: String?, dirty: Set<String>, available: CGFloat) -> EditorTabPlan {
        let qualifiers = EditorTabQualifiers.qualifiers(for: paths, root: root)
        let names = paths.map { ($0 as NSString).lastPathComponent }
        func room(_ i: Int) -> CGFloat {
            EditorTabWidths.chrome + (dirty.contains(paths[i]) ? EditorTabWidths.dirtyExtra : 0)
        }
        let ideals: [CGFloat] = paths.indices.map { i in
            let q = qualifiers[paths[i]].map { $0.count + 1 } ?? 0
            return ceil(room(i) + CGFloat(names[i].count + q) * EditorTabTitle.charWidth)
        }
        let spread = EditorTabWidths.distribute(ideals: ideals, available: available)
        let tabs = paths.indices.map { i -> Tab in
            let path = paths[i]
            let width = spread.widths[i]
            let budget = max(0, Int((width - room(i)) / EditorTabTitle.charWidth + 1e-6))
            let fit = EditorTabTitle.fit(name: names[i], qualifier: qualifiers[path], budget: budget)
            let relative = root.flatMap { WorkspaceRelativePath.of(path, in: $0) }.flatMap { $0.isEmpty ? nil : $0 }
            let shownPath = relative ?? path
            let folder = (shownPath as NSString).deletingLastPathComponent
            return Tab(
                path: path, fileName: names[i], shownName: fit.name, shownQualifier: fit.qualifier,
                width: width, help: shownPath,
                accessibilityLabel: folder.isEmpty ? names[i] : "\(names[i]), in \(folder)")
        }
        return EditorTabPlan(tabs: tabs, overflows: spread.overflows)
    }
}

// MARK: - The header's path line

public enum EditorHeaderPath {
    public struct Fit: Equatable, Sendable {
        /// The folders, with their trailing slash; empty for a file at the root.
        public let folder: String
        public let name: String
        public init(folder: String, name: String) { self.folder = folder; self.name = name }
    }

    /// `relativePath` as folder + name in at most `budget` characters. The name is the
    /// thing the person came for: it stays whole when it can; when it cannot, it is cut
    /// in the middle like a tab's. The folder gives way from the front (`…/of/folders/inside/`),
    /// keeping the part nearest the file.
    public static func fit(relativePath: String, budget: Int) -> Fit {
        guard let slash = relativePath.lastIndex(of: "/") else {
            return Fit(folder: "", name: EditorTabTitle.shorten(relativePath, maxChars: budget))
        }
        let folder = String(relativePath[...slash])
        let name = String(relativePath[relativePath.index(after: slash)...])
        if folder.count + name.count <= budget { return Fit(folder: folder, name: name) }
        if name.count <= budget - 4 {
            return Fit(folder: shortenFolder(folder, maxChars: budget - name.count), name: name)
        }
        let folderBudget = min(folder.count, max(10, budget / 4))
        return Fit(folder: shortenFolder(folder, maxChars: folderBudget),
                   name: EditorTabTitle.shorten(name, maxChars: max(0, budget - folderBudget)))
    }

    static func shortenFolder(_ folder: String, maxChars: Int) -> String {
        if folder.count <= maxChars { return folder }
        let ellipsis = EditorTabTitle.ellipsis
        if maxChars < 2 { return "" }
        let segments = folder.split(separator: "/").map { String($0) + "/" }
        var kept: [String] = []
        var used = 2  // "…/"
        for segment in segments.reversed() {
            if used + segment.count > maxChars { break }
            kept.insert(segment, at: 0)
            used += segment.count
        }
        if kept.isEmpty { return ellipsis + String(folder.suffix(maxChars - 1)) }
        return ellipsis + "/" + kept.joined()
    }
}

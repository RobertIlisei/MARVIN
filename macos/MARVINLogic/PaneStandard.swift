// PaneStandard — the rules every side pane follows, as values (kit agent,
// 2026-11-25; prose in `docs/design/pane-standard.md`).
//
// The 2026-11-24 review said "each thing has its own design". Three surveys
// measured it: five section headers, five icon-button styles, three registers
// of empty text, and type from 8 pt to 13 pt with no scale behind it. The kit
// (`macos/MARVIN/Pane*.swift`) draws; this file DECIDES, so the decisions can
// be asserted — `MARVINTests` links `MARVINLogic` and nothing else.

import Foundation

// MARK: - Type scale

/// The sizes a pane may set text in, in points. The floor is 11: AppKit's own
/// `.caption`, `.caption2` and `.footnote` are all 10 pt on macOS, and a person
/// reading a list for an hour should not have to squint at its second line.
/// Glyph sizes (a chevron, a status dot) are not text and are not on this scale.
public enum PaneTypeScale {
    public static let minimumPoints: Double = 11

    /// A pane's title when it is not the shouting kind (the project name).
    public static let paneTitle: Double = 12
    /// The first line of a row: a name, a title.
    public static let rowTitle: Double = 12
    /// The ONE secondary line under a row title, and trailing state text.
    public static let rowSecondary: Double = 11
    /// A group's label, its count, a header's uppercase title.
    public static let groupLabel: Double = 11
    /// Text inside a field.
    public static let field: Double = 12
    /// An empty state's sentence.
    public static let emptyHeadline: Double = 12
    /// An empty state's hint, a notice, a footnote.
    public static let emptyHint: Double = 11
    /// A button's label.
    public static let action: Double = 11

    /// Every token by name, so a test can hold them all to the floor.
    public static let tokens: [(String, Double)] = [
        ("paneTitle", paneTitle), ("rowTitle", rowTitle), ("rowSecondary", rowSecondary),
        ("groupLabel", groupLabel), ("field", field), ("emptyHeadline", emptyHeadline),
        ("emptyHint", emptyHint), ("action", action),
    ]
}

// MARK: - Spacing scale

/// The only gaps a pane uses. The gutter is 10 because it was already 10 in the
/// header, the rows and the file tree; changing it would misalign every pane
/// that has not migrated yet.
public enum PaneSpacing {
    public static let hairline: Double = 2
    public static let tight: Double = 4
    public static let compact: Double = 6
    public static let standard: Double = 8
    /// Left and right edge of a header, a group header and a row.
    public static let gutter: Double = 10
    public static let section: Double = 12
    public static let roomy: Double = 16

    public static let scale: [Double] = [hairline, tight, compact, standard, gutter, section, roomy]
}

// MARK: - Filter

/// The search a pane puts under its header. Every word must match, in any
/// field, ignoring case and accents: "graph first" finds "Query the graph first".
public enum PaneFilter {
    public static func isActive(_ query: String) -> Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public static func tokens(_ query: String) -> [String] {
        query.split(whereSeparator: { $0.isWhitespace }).map { fold(String($0)) }
    }

    public static func matches(_ query: String, in fields: [String]) -> Bool {
        let words = tokens(query)
        if words.isEmpty { return true }
        let haystacks = fields.map(fold)
        return words.allSatisfy { w in haystacks.contains { $0.contains(w) } }
    }

    private static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}

// MARK: - Group disclosure state

/// Which groups a person closed (or opened against the default), per pane.
///
/// Only DIFFERENCES from the default are kept: a group put back where it started
/// leaves nothing behind, so the stored dictionary never grows with groups the
/// person has stopped caring about.
public struct PaneCollapseState: Equatable, Sendable {
    public private(set) var storage: [String: Bool]

    public init(storage: [String: Bool] = [:]) { self.storage = storage }

    public func isCollapsed(_ key: String, default d: Bool) -> Bool { storage[key] ?? d }

    public func toggled(_ key: String, default d: Bool) -> PaneCollapseState {
        var copy = self
        let next = !isCollapsed(key, default: d)
        if next == d { copy.storage[key] = nil } else { copy.storage[key] = next }
        return copy
    }

    /// A closed group still shows its matches while a filter is active: a
    /// search that hides its own results behind a chevron is a search that
    /// looks broken.
    public static func isShown(collapsed: Bool, filterActive: Bool) -> Bool {
        !collapsed || filterActive
    }

    /// UserDefaults key, one per pane.
    public static func defaultsKey(pane: String) -> String { "marvin.pane.\(pane).collapsedGroups" }
}

// MARK: - Row actions

/// What a row can do, ranked. The kit draws the plan; a pane only says which
/// verbs exist and which one is the point of the row.
public struct PaneRowAction: Equatable, Sendable {
    public enum Role: Equatable, Sendable { case primary, normal, destructive }
    public let id: String
    public let role: Role
    public init(id: String, role: Role) { self.id = id; self.role = role }
}

/// "At most ONE visible action, the rest in a … menu."
///
/// The visible one is the first `.primary`. A destructive verb is never
/// visible, however it is marked: a button a pointer can graze while scrolling
/// must not discard anything. Menu order is the caller's, destructive last.
public struct PaneRowActionPlan: Equatable, Sendable {
    public let visible: String?
    public let menu: [String]

    public static func plan(_ actions: [PaneRowAction]) -> PaneRowActionPlan {
        let visible = actions.first(where: { $0.role == .primary })
        let rest = actions.filter { $0.id != visible?.id }
        let ordered = rest.filter { $0.role != .destructive } + rest.filter { $0.role == .destructive }
        return PaneRowActionPlan(visible: visible?.id, menu: ordered.map { $0.id })
    }
}

/// A group header's one bulk verb. The label says how many it will touch.
public enum PaneBulkAction {
    public static func title(_ verb: String, count: Int) -> String {
        switch count {
        case ..<1: return verb
        case 1: return verb.components(separatedBy: " ").first ?? verb
        default: return "\(verb) (\(count))"
        }
    }
}

// MARK: - Keyboard

public enum PaneKeyMove: Equatable, Sendable { case up, down, first, last }

/// Arrow-key movement through a flat list of row ids. Stops at the ends (a list
/// that wraps hides where it starts) and restarts if the selection left the list.
public enum PaneKeyNav {
    public static func move(_ move: PaneKeyMove, from current: String?, in ids: [String]) -> String? {
        guard !ids.isEmpty else { return nil }
        let index = current.flatMap { ids.firstIndex(of: $0) }
        switch move {
        case .first: return ids.first
        case .last: return ids.last
        case .down:
            guard let index else { return ids.first }
            return ids[min(index + 1, ids.count - 1)]
        case .up:
            guard let index else { return ids.last }
            return ids[max(index - 1, 0)]
        }
    }
}

/// Type-ahead: letters typed in quick succession jump to the next title that
/// starts with them. A pause of a second starts a new word. One letter pressed
/// again cycles through the rows that share it (Finder behaves the same).
public struct PaneTypeAhead: Equatable, Sendable {
    public static let pause: TimeInterval = 1.0
    private var buffer = ""
    private var lastAt: Date?

    public init() {}

    public mutating func type(_ ch: String, at now: Date, rows: [(id: String, title: String)], from current: String?) -> String? {
        if let last = lastAt, now.timeIntervalSince(last) > Self.pause { buffer = "" }
        lastAt = now
        buffer += ch.lowercased()
        let hits = rows.filter { $0.title.lowercased().hasPrefix(buffer) }
        guard !hits.isEmpty else { return nil }
        // The selection already matches the word: stay on it (typing "gr" after
        // "g" must not jump away from the row "g" already found).
        if let current, hits.contains(where: { $0.id == current }), buffer.count > 1 { return current }
        // The same single letter again: the next match after the current row.
        if buffer.count == 1, let current, let i = hits.firstIndex(where: { $0.id == current }) {
            return hits[(i + 1) % hits.count].id
        }
        // A single letter while the selection does not match: the next one after it
        // in list order, else the first.
        if buffer.count == 1, let current, let at = rows.firstIndex(where: { $0.id == current }) {
            if let after = rows[(at + 1)...].first(where: { $0.title.lowercased().hasPrefix(buffer) }) { return after.id }
        }
        return hits.first?.id
    }
}

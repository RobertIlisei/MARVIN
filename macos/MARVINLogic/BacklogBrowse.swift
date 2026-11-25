// BacklogBrowse — how the Project Backlog window decides what to show.
//
// The backlog of a real project is about 250 open items among 2,700 files.
// A list that long is only usable when the rules for narrowing it are plain
// and predictable: which scope, which filters, which order, which groups, what
// a row says, and which ONE action a row offers up front. All of those are
// decided here, as pure functions, so they can be asserted; the view draws the
// result and holds no rules of its own.
//
// Nothing here writes. Keep and dismiss of a provisional item stay the user's
// act (ADR-0047) — `BacklogBulk` only decides WHICH items a confirmed bulk
// act would touch, and what the confirm says.

import Foundation

// MARK: - Scope, sort, group

/// The three lists the window switches between. Provisional items (ADR-0047)
/// are the "To review" scope rather than a band above the list: a person
/// reviewing captures wants only captures in front of them.
public enum BacklogScope: String, CaseIterable, Identifiable, Sendable {
    case open, review, resolved

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .open: return "Open"
        case .review: return "To review"
        case .resolved: return "Resolved"
        }
    }

    public func includes(status: String) -> Bool {
        switch self {
        case .open: return status == "open" || status == "doing"
        case .review: return status == "provisional"
        case .resolved: return status == "done" || status == "dismissed"
        }
    }
}

/// How the visible list is ordered. Raw values are the ones already stored in
/// `@AppStorage`, so a person's choice survives the redesign.
public enum BacklogSort: String, CaseIterable, Identifiable, Sendable {
    case severity, newest, oldest, title

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .severity: return "Severity"
        case .newest: return "Newest first"
        case .oldest: return "Oldest first"
        case .title: return "Title"
        }
    }
}

/// How the visible list is banded. Raw values as stored before, plus `age`.
public enum BacklogGroup: String, CaseIterable, Identifiable, Sendable {
    case none, severity, status, kind, age

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .none: return "No grouping"
        case .severity: return "Severity"
        case .status: return "Status"
        case .kind: return "Kind"
        case .age: return "Age"
        }
    }
}

public enum BacklogBlockedFilter: String, CaseIterable, Identifiable, Sendable {
    case all, hide, only

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "Blocked and not"
        case .hide: return "Hide blocked"
        case .only: return "Only blocked"
        }
    }
}

// MARK: - Filter

public struct BacklogFilter: Equatable, Sendable {
    public var scope: BacklogScope = .open
    public var query: String = ""
    public var severities: Set<String> = ["high", "med", "low"]
    public var hiddenKinds: Set<String> = []
    public var blocked: BacklogBlockedFilter = .all
    /// Status facets (BacklogStatusFilter.swift): narrow within the scope, joined by OR.
    public var statuses: Set<BacklogStatusFacet> = []
    /// Items a groom review flagged; nil = not narrowing to them.
    public var onlyIds: Set<String>? = nil

    public init(scope: BacklogScope = .open, query: String = "", severities: Set<String> = ["high", "med", "low"],
                hiddenKinds: Set<String> = [], blocked: BacklogBlockedFilter = .all,
                statuses: Set<BacklogStatusFacet> = [], onlyIds: Set<String>? = nil) {
        self.scope = scope
        self.query = query
        self.severities = severities
        self.hiddenKinds = hiddenKinds
        self.blocked = blocked
        self.statuses = statuses
        self.onlyIds = onlyIds
    }

    /// How many narrowing filters (beyond scope and search) are switched on —
    /// the number the Filter button wears so a non-default filter is visible
    /// without opening it. A list that silently omits rows reads as an empty
    /// backlog.
    public var activeFilterCount: Int {
        var n = 0
        if severities.count < 3 { n += 1 }
        if !hiddenKinds.isEmpty { n += 1 }
        if blocked != .all { n += 1 }
        if !activeStatuses.isEmpty { n += 1 }
        if onlyIds != nil { n += 1 }
        return n
    }

    public var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// True when anything beyond the scope narrows the list — what "no
    /// results" has to name, as opposed to "nothing here".
    public var isNarrowed: Bool { isSearching || activeFilterCount > 0 }
}

public struct BacklogCounts: Equatable, Sendable {
    public var open = 0
    public var review = 0
    public var resolved = 0

    public init(open: Int = 0, review: Int = 0, resolved: Int = 0) {
        self.open = open
        self.review = review
        self.resolved = resolved
    }

    public func count(_ scope: BacklogScope) -> Int {
        switch scope {
        case .open: return open
        case .review: return review
        case .resolved: return resolved
        }
    }
}

public struct BacklogSection: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let items: [BacklogItem]

    public init(id: String, title: String, items: [BacklogItem]) {
        self.id = id
        self.title = title
        self.items = items
    }
}

// MARK: - Browse

public enum BacklogBrowse {
    public static let kindOrder = ["bug", "feature", "investigate", "test", "docs", "chore", "unspecified"]

    public static func kindTitle(_ kind: String) -> String {
        kind == "unspecified" ? "Unclassified" : kind.prefix(1).uppercased() + kind.dropFirst()
    }

    public static func severityTitle(_ severity: String) -> String {
        switch severity {
        case "high": return "High"
        case "med": return "Medium"
        case "low": return "Low"
        default: return severity.prefix(1).uppercased() + severity.dropFirst()
        }
    }

    public static func counts(_ items: [BacklogItem]) -> BacklogCounts {
        var c = BacklogCounts()
        for i in items {
            if BacklogScope.open.includes(status: i.status) { c.open += 1 }
            else if BacklogScope.review.includes(status: i.status) { c.review += 1 }
            else if BacklogScope.resolved.includes(status: i.status) { c.resolved += 1 }
        }
        return c
    }

    /// Every word of the query must appear in the title, the body, the kind or
    /// the id — case- and diacritic-insensitive. An empty query matches all.
    public static func matches(_ item: BacklogItem, query: String) -> Bool {
        let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.isEmpty { return true }
        let hay = "\(item.title)\n\(item.body)\n\(item.kindOrUnspecified)\n\(item.id)"
        return words.allSatisfy { hay.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    public static func filter(_ items: [BacklogItem], _ f: BacklogFilter) -> [BacklogItem] {
        items.filter { item in
            guard f.scope.includes(status: item.status) else { return false }
            let sev = ["high", "low"].contains(item.severity) ? item.severity : "med"
            guard f.severities.contains(sev) else { return false }
            guard !f.hiddenKinds.contains(item.kindOrUnspecified) else { return false }
            switch f.blocked {
            case .all: break
            case .hide: if item.isBlocked { return false }
            case .only: if !item.isBlocked { return false }
            }
            let facets = f.activeStatuses
            if !facets.isEmpty, !facets.contains(where: { $0.matches(item) }) { return false }
            if let only = f.onlyIds, !only.contains(item.id) { return false }
            return matches(item, query: f.query)
        }
    }

    public static func severityRank(_ s: String) -> Int {
        switch s { case "high": return 0; case "med": return 1; default: return 2 }
    }

    public static func sort(_ items: [BacklogItem], by key: BacklogSort) -> [BacklogItem] {
        items.sorted { a, b in
            switch key {
            case .severity:
                let (ra, rb) = (severityRank(a.severity), severityRank(b.severity))
                if ra != rb { return ra < rb }
                if a.created != b.created { return a.created > b.created }
            case .newest:
                if a.created != b.created { return a.created > b.created }
            case .oldest:
                if a.created != b.created { return a.created < b.created }
            case .title: break
            }
            // A total order: equal keys fall back to the title, then the id,
            // so the list never reshuffles between two renders.
            let c = a.title.localizedCaseInsensitiveCompare(b.title)
            if c != .orderedSame { return c == .orderedAscending }
            return a.id < b.id
        }
    }

    /// Bands an already-sorted list. Empty bands are dropped; the order of
    /// items inside a band is the order they came in.
    public static func sections(_ items: [BacklogItem], group: BacklogGroup, now: Date = Date()) -> [BacklogSection] {
        func bands(_ order: [(id: String, title: String)], _ key: (BacklogItem) -> String) -> [BacklogSection] {
            let grouped = Dictionary(grouping: items, by: key)
            return order.compactMap { band in
                guard let g = grouped[band.id], !g.isEmpty else { return nil }
                return BacklogSection(id: band.id, title: band.title, items: g)
            }
        }
        switch group {
        case .none:
            return items.isEmpty ? [] : [BacklogSection(id: "all", title: "", items: items)]
        case .severity:
            return bands([("high", "High"), ("med", "Medium"), ("low", "Low")]) {
                ["high", "low"].contains($0.severity) ? $0.severity : "med"
            }
        case .status:
            return bands([("provisional", "To review"), ("doing", "In progress"), ("open", "Open"),
                          ("done", "Done"), ("dismissed", "Dismissed")]) { $0.status }
        case .kind:
            return bands(kindOrder.map { ($0, kindTitle($0)) }) {
                kindOrder.contains($0.kindOrUnspecified) ? $0.kindOrUnspecified : "unspecified"
            }
        case .age:
            return bands([("week", "Added this week"), ("month", "Added this month"), ("older", "Older")]) {
                switch BacklogAge.days(created: $0.created, now: now) {
                case .some(let d) where d < 7: return "week"
                case .some(let d) where d < 30: return "month"
                default: return "older"
                }
            }
        }
    }

    /// Filter, sort and band in one step — the whole of what the list shows.
    public static func view(_ items: [BacklogItem], filter f: BacklogFilter, sort key: BacklogSort,
                            group: BacklogGroup, now: Date = Date()) -> [BacklogSection] {
        sections(sort(filter(items, f), by: key), group: group, now: now)
    }
}

// MARK: - Age

public enum BacklogAge {
    /// Whole days between the item's created date (`2026-11-14` or a full ISO
    /// timestamp) and `now`; nil when the date cannot be read.
    public static func days(created: String, now: Date = Date()) -> Int? {
        guard let date = parse(created) else { return nil }
        let secs = now.timeIntervalSince(date)
        return secs < 0 ? 0 : Int(secs / 86_400)
    }

    private static func parse(_ s: String) -> Date? {
        if let d = FriendlyDate.parse(s) { return d }
        let day = String(s.prefix(10))
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: day)
    }

    /// "today", "3d", "2w", "5mo", "2y" — as short as a row's second line needs.
    public static func label(created: String, now: Date = Date()) -> String? {
        guard let d = days(created: created, now: now) else { return nil }
        switch d {
        case 0: return "today"
        case 1..<14: return "\(d)d"
        case 14..<60: return "\(d / 7)w"
        case 60..<730: return "\(d / 30)mo"
        default: return "\(d / 365)y"
        }
    }
}

// MARK: - Row text and actions

public enum BacklogRowText {
    /// The one secondary line under a row:
    /// `where it stands · severity · kind · age`. Where it stands comes FIRST and
    /// only when it is not a plain open item ("In progress · tab: fix-it",
    /// "Blocked · waits on the lawyer"): it is what a person scanning for work
    /// that is moving, or stuck, is looking for, and at the end of the line it was
    /// the part a narrow list truncated. Only what is known is printed, and what
    /// it waits on is never dropped.
    public static func secondary(_ item: BacklogItem, now: Date = Date()) -> String {
        var parts: [String] = []
        switch item.status {
        case "doing": parts.append("In progress")
            if let holder = item.holderLabel { parts.append(holder) }
        case "provisional": parts.append("Auto-captured")
        case "done": parts.append("Done")
        case "dismissed": parts.append("Dismissed")
        default: break
        }
        if item.isBlocked {
            parts.append("Blocked")
            let on = item.blockedOn?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !on.isEmpty { parts.append("waits on \(on)") }
        }
        parts.append(BacklogBrowse.severityTitle(item.severity))
        if item.kindOrUnspecified != "unspecified" { parts.append(item.kindOrUnspecified) }
        if let age = BacklogAge.label(created: item.created, now: now) { parts.append(age) }
        return parts.joined(separator: " · ")
    }
}

public enum BacklogAction: String, Equatable, Sendable {
    case keep, plan, done, reopen, backToOpen, export, dismiss

    /// The label in a menu, where there is room for a sentence.
    public var title: String {
        switch self {
        case .keep: return "Keep"
        case .plan: return "Promote to plan"
        case .done: return "Mark done"
        case .reopen: return "Reopen"
        case .backToOpen: return "Back to open"
        case .export: return "Export to issue"
        case .dismiss: return "Dismiss"
        }
    }

    /// The label on a row's one visible button, where there is room for a word.
    public var chipTitle: String {
        switch self {
        case .plan: return "Plan"
        case .done: return "Done"
        default: return title
        }
    }

    public var isDestructive: Bool { self == .dismiss }

    /// The status this action sets, when it is a status change.
    public var targetStatus: String? {
        switch self {
        case .keep, .reopen, .backToOpen: return "open"
        case .done: return "done"
        case .dismiss: return "dismissed"
        case .plan, .export: return nil
        }
    }
}

public struct BacklogRowActions: Equatable, Sendable {
    /// What the row's visible button does — the thing most likely wanted next.
    public let primary: BacklogAction?
    /// Everything else, behind the row's menu.
    public let menu: [BacklogAction]

    public static func forStatus(_ status: String) -> BacklogRowActions {
        switch status {
        case "provisional": return .init(primary: .keep, menu: [.dismiss])
        case "open": return .init(primary: .plan, menu: [.done, .export, .dismiss])
        case "doing": return .init(primary: .done, menu: [.plan, .backToOpen, .export, .dismiss])
        case "done", "dismissed": return .init(primary: .reopen, menu: [])
        default: return .init(primary: nil, menu: [])
        }
    }
}

// MARK: - Bulk review

/// Which items a confirmed bulk Keep / Dismiss touches, and what the confirm
/// says. ADR-0047 puts the bloat control at the review pass; a one-click
/// "Keep all" turned that control into a rubber stamp (2026-08-29: eight
/// items promoted in one click, two minutes after capture). So the count is
/// always in the question, and only provisional items can ever be in it.
public enum BacklogBulk {
    public enum Kind: Equatable, Sendable {
        case keep, dismiss

        public var status: String { self == .keep ? "open" : "dismissed" }
        public var verb: String { self == .keep ? "Keep" : "Dismiss" }
        public var explanation: String {
            self == .keep
                ? "They become open backlog items. Reviewing them one by one is how the list stays worth reading."
                : "They are marked dismissed. The files stay on disk as history, but they leave the active list."
        }
    }

    public struct Targets: Equatable, Sendable {
        public let items: [BacklogItem]
        /// True when the items are the person's selection rather than
        /// everything the list shows — the wording differs.
        public let fromSelection: Bool
    }

    /// A selection of two or more provisional items is the subject; otherwise
    /// every provisional item the list shows. A non-provisional id in the
    /// selection is ignored — bulk review never resolves real work.
    public static func targets(selected: Set<String>, shown: [BacklogItem]) -> Targets {
        let provisional = shown.filter { $0.status == "provisional" }
        let picked = provisional.filter { selected.contains($0.id) }
        if picked.count >= 2 { return Targets(items: picked, fromSelection: true) }
        return Targets(items: provisional, fromSelection: false)
    }

    /// The toolbar button: "Keep 3 selected…" / "Dismiss all 12…".
    public static func buttonTitle(_ kind: Kind, _ t: Targets) -> String {
        t.fromSelection ? "\(kind.verb) \(t.items.count) selected…" : "\(kind.verb) all \(t.items.count)…"
    }

    /// The confirm's question, with the count in it.
    public static func confirmTitle(_ kind: Kind, _ t: Targets) -> String {
        let n = t.items.count
        let noun = n == 1 ? "auto-captured item" : "auto-captured items"
        return t.fromSelection ? "\(kind.verb) the \(n) selected \(noun)?" : "\(kind.verb) all \(n) \(noun)?"
    }
}

// MARK: - Body

public struct BacklogNote: Equatable, Sendable {
    /// `2026-11-10`, when the note carries one.
    public let date: String?
    /// "note", "done", "dismissed" — what kind of line it was.
    public let label: String
    public let text: String

    public init(date: String?, label: String, text: String) {
        self.date = date
        self.label = label
        self.text = text
    }
}

public struct BacklogLink: Equatable, Sendable {
    public let label: String
    /// A URL, a repo-relative path, or a wiki target.
    public let target: String

    public init(label: String, target: String) {
        self.label = label
        self.target = target
    }

    public var isWebURL: Bool { target.hasPrefix("http://") || target.hasPrefix("https://") }
}

public struct BacklogBodyParts: Equatable, Sendable {
    public let text: String
    public let notes: [BacklogNote]
    public let links: [BacklogLink]
}

/// Splits an item's stored body into what a person reads: the description,
/// its dated `> ` notes (ADR-0044 — resolve and note-append write them), and
/// its links (the generated `**Related:**` trailer and any bare URL).
public enum BacklogBody {
    public static let linkMarker = "<!-- marvin:links -->"

    public static func parse(_ body: String) -> BacklogBodyParts {
        var text: [String] = []
        var notes: [BacklogNote] = []
        var links: [BacklogLink] = []
        func addLink(_ l: BacklogLink) { if !links.contains(where: { $0.target == l.target }) { links.append(l) } }

        for raw in body.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line == linkMarker { continue }
            if line.hasPrefix("**Related:**") {
                for l in related(String(line.dropFirst("**Related:**".count))) { addLink(l) }
                continue
            }
            if line.hasPrefix(">") {
                let rest = line.dropFirst().trimmingCharacters(in: .whitespaces)
                if !rest.isEmpty { notes.append(note(rest)) }
                continue
            }
            text.append(raw)
        }
        var plain = text.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // Taking the notes and the trailer out leaves their blank lines behind.
        while plain.contains("\n\n\n") { plain = plain.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
        for url in urls(in: plain) { addLink(BacklogLink(label: url, target: url)) }
        return BacklogBodyParts(text: plain, notes: notes, links: links)
    }

    /// `note 2026-11-10 — text`, `done — text`, `dismissed — text`, or free text.
    private static func note(_ s: String) -> BacklogNote {
        let words = s.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true).map(String.init)
        guard let first = words.first, ["note", "done", "dismissed", "open", "doing"].contains(first.lowercased())
        else { return BacklogNote(date: nil, label: "note", text: s) }
        var rest = Array(words.dropFirst())
        var date: String?
        if let d = rest.first, d.count == 10, d.dropFirst(4).first == "-" {
            date = d
            rest.removeFirst()
        }
        var text = rest.joined(separator: " ")
        for dash in ["— ", "– ", "- "] where text.hasPrefix(dash) {
            text = String(text.dropFirst(dash.count))
            break
        }
        return BacklogNote(date: date, label: first.lowercased(), text: text.isEmpty ? s : text)
    }

    private static func related(_ s: String) -> [BacklogLink] {
        s.components(separatedBy: "·").compactMap { piece in
            let p = piece.trimmingCharacters(in: .whitespaces)
            if p.isEmpty { return nil }
            // [label](target)
            if p.hasPrefix("["), let mid = p.range(of: "]("), p.hasSuffix(")") {
                let label = String(p[p.index(after: p.startIndex)..<mid.lowerBound])
                let target = String(p[mid.upperBound..<p.index(before: p.endIndex)])
                return BacklogLink(label: label, target: target)
            }
            // [[target]] or [[target|label]]
            if p.hasPrefix("[["), p.hasSuffix("]]") {
                let inner = String(p.dropFirst(2).dropLast(2))
                let bits = inner.split(separator: "|", maxSplits: 1).map(String.init)
                return BacklogLink(label: bits.last ?? inner, target: bits.first ?? inner)
            }
            return BacklogLink(label: p, target: p)
        }
    }

    private static func urls(in s: String) -> [String] {
        var out: [String] = []
        for token in s.split(whereSeparator: { $0.isWhitespace || $0 == "(" || $0 == ")" || $0 == "<" || $0 == ">" }) {
            guard token.hasPrefix("http://") || token.hasPrefix("https://") else { continue }
            let trimmed = String(token).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:\"'`]"))
            if trimmed.count > 8 { out.append(trimmed) }
        }
        return out
    }
}

// MARK: - Disclosure and window memory

/// Which groups of a list are folded. A string round trip because it lives in
/// `@AppStorage`; group ids never contain a comma.
public struct BrowseDisclosure: Equatable, Sendable {
    public private(set) var collapsed: Set<String>

    public init(raw: String = "") {
        collapsed = Set(raw.split(separator: ",").map(String.init))
    }

    public var raw: String { collapsed.sorted().joined(separator: ",") }

    public func isCollapsed(_ id: String, defaultCollapsed: Bool = false) -> Bool {
        // An explicit choice is stored as "+id" (opened) or "id" (folded), so a
        // group that starts folded by default can still be opened and stay so.
        if collapsed.contains("+" + id) { return false }
        if collapsed.contains(id) { return true }
        return defaultCollapsed
    }

    public mutating func toggle(_ id: String, defaultCollapsed: Bool = false) {
        let now = isCollapsed(id, defaultCollapsed: defaultCollapsed)
        collapsed.remove(id)
        collapsed.remove("+" + id)
        // Store only what differs from the default, so the string stays short.
        if now == defaultCollapsed {
            collapsed.insert(now ? "+" + id : id)
        }
    }

    /// Drops choices about groups that no longer exist, so the string cannot grow without bound.
    public mutating func prune(keeping ids: Set<String>) {
        collapsed = collapsed.filter { ids.contains($0.hasPrefix("+") ? String($0.dropFirst()) : $0) }
    }
}

/// The remembered size of a window, as one string for `UserDefaults`.
public enum WindowSizeMemory {
    public static func encode(width: Double, height: Double) -> String { "\(Int(width.rounded())),\(Int(height.rounded()))" }

    public static func decode(_ raw: String, minWidth: Double, minHeight: Double,
                              maxWidth: Double = 4000, maxHeight: Double = 3000) -> (width: Double, height: Double)? {
        let bits = raw.split(separator: ",").compactMap { Double($0) }
        guard bits.count == 2, bits[0] > 0, bits[1] > 0 else { return nil }
        return (min(max(bits[0], minWidth), maxWidth), min(max(bits[1], minHeight), maxHeight))
    }
}

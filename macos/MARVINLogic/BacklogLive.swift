// BacklogLive — the project's backlog counts, as ONE state every surface reads
// (ADR-0044 addendum, 2026-11-25).
//
// The chat's "N backlog items parked" strip used to hold a number it read once,
// when a session or its view was created: the backlog is PROJECT state, written
// all day by other sessions' tools, by the Project Backlog window and by hand,
// and none of that reached a view that had already looked. The sidecar now says
// when the backlog moved (`backlog.changed` on the project's announce stream,
// carrying counts by status); this file is the pure half on the app side:
//
//   - `BacklogStatusCounts`  what the sidecar counted
//   - `BacklogFeedEvent`     the event's wire shape
//   - `BacklogLiveState`     reduces events into the one set of numbers, and
//                            drops what is older than what it already holds
//   - `BacklogSurface`       what each surface SAYS for those numbers
//
// `BacklogLiveStore` (the app target) owns the single instance; a source guard
// (`BacklogCountSourceScan`) keeps any view from growing a private copy again.

import Foundation

/// The project's items counted by status. `active` is the number the chat's
/// strip shows: parked work that is not finished.
public struct BacklogStatusCounts: Equatable, Sendable, Codable {
    public var provisional: Int
    public var open: Int
    public var doing: Int
    public var done: Int
    public var dismissed: Int
    /// Items flagged blocked, whatever their status.
    public var blocked: Int

    public init(provisional: Int = 0, open: Int = 0, doing: Int = 0, done: Int = 0, dismissed: Int = 0, blocked: Int = 0) {
        self.provisional = provisional
        self.open = open
        self.doing = doing
        self.done = done
        self.dismissed = dismissed
        self.blocked = blocked
    }

    public static let zero = BacklogStatusCounts()

    /// provisional + open + doing. Computed here, never read from the wire, so
    /// there is one definition of "parked" on this side.
    public var active: Int { provisional + open + doing }

    /// The window's three scopes (Open / To review / Resolved), from the same
    /// numbers: the scope definitions are `BacklogScope.includes(status:)`.
    public var scopeCounts: BacklogCounts {
        var c = BacklogCounts()
        let byStatus: [(String, Int)] = [("provisional", provisional), ("open", open), ("doing", doing), ("done", done), ("dismissed", dismissed)]
        for (status, n) in byStatus {
            if BacklogScope.open.includes(status: status) { c.open += n }
            else if BacklogScope.review.includes(status: status) { c.review += n }
            else if BacklogScope.resolved.includes(status: status) { c.resolved += n }
        }
        return c
    }

    // A sidecar that sends fewer fields (an older bundle) reads the rest as zero.
    private enum Keys: String, CodingKey { case provisional, open, doing, done, dismissed, blocked }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        provisional = try c.decodeIfPresent(Int.self, forKey: .provisional) ?? 0
        open = try c.decodeIfPresent(Int.self, forKey: .open) ?? 0
        doing = try c.decodeIfPresent(Int.self, forKey: .doing) ?? 0
        done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
        dismissed = try c.decodeIfPresent(Int.self, forKey: .dismissed) ?? 0
        blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
    }
}

/// `backlog.changed` on `/api/chat/announce`. Counts and a revision only.
public enum BacklogFeedEvent: Equatable, Sendable {
    case changed(projectId: String, revision: Int, isSnapshot: Bool, counts: BacklogStatusCounts)

    public static func decode(name: String, data: Data) -> BacklogFeedEvent? {
        guard name == "backlog.changed" else { return nil }
        struct Wire: Decodable {
            let projectId: String
            let revision: Int
            let reason: String
            let counts: BacklogStatusCounts
        }
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        return .changed(projectId: w.projectId, revision: w.revision, isSnapshot: w.reason == "snapshot", counts: w.counts)
    }
}

/// The reducer. Value type, no I/O: the store feeds it events and reads it.
public struct BacklogLiveState: Equatable, Sendable {
    public private(set) var counts: BacklogStatusCounts = .zero
    /// False until the first numbers arrive: nothing to show is not "zero parked".
    public private(set) var hasData = false
    /// The newest revision applied on this connection; -1 on a fresh one.
    public private(set) var revision = -1
    /// Ticks whenever the numbers were replaced. A view that holds a LIST (the
    /// window) reloads on it; the counts themselves it reads from `counts`.
    public private(set) var generation = 0

    public init() {}

    /// Apply a feed event for `project`. Returns whether anything changed.
    /// A `change` must be newer than what is held. A `snapshot` is the state
    /// at attach (a first connection, a reconnect after sleep, a restarted
    /// sidecar whose revisions began again at zero) and always applies: it
    /// re-bases the revision, so the changes that follow are measured from it.
    /// Another project's event, or one with no project loaded, is ignored.
    @discardableResult
    public mutating func apply(_ event: BacklogFeedEvent, project: String?) -> Bool {
        guard case let .changed(pid, rev, isSnapshot, new) = event, let project, pid == project else { return false }
        if !isSnapshot && rev <= revision { return false }
        revision = rev
        counts = new
        hasData = true
        generation += 1
        return true
    }

    /// A plain re-read of the counts (the window back to the front, a slow
    /// safety net): replaces the numbers whatever their revision, and counts
    /// as a change only if they differ.
    @discardableResult
    public mutating func adoptRead(_ new: BacklogStatusCounts) -> Bool {
        let differs = new != counts || !hasData
        counts = new
        hasData = true
        if differs { generation += 1 }
        return differs
    }

    /// The project changed: drop everything.
    public mutating func reset() {
        counts = .zero
        hasData = false
        revision = -1
        generation = 0
    }
}

/// What each surface says for the numbers. One wording, in one place.
public enum BacklogSurface {
    /// The strip's card: "261 backlog items parked".
    public static func chipText(active: Int) -> String {
        "\(active) backlog item\(active == 1 ? "" : "s") parked"
    }

    /// The strip shows a row only when something is parked; zero behaves as it always did.
    public static func showsChip(active: Int) -> Bool { active > 0 }

    /// The window's header line: "6 open · 2 to review".
    public static func windowSubtitle(_ c: BacklogCounts) -> String {
        var parts = ["\(c.open) open"]
        if c.review > 0 { parts.append("\(c.review) to review") }
        return parts.joined(separator: " \u{B7} ")
    }
}

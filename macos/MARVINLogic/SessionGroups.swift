// SessionGroups — how the Sessions pane keeps a long fleet quiet (UI standard
// round, 25.11.2026).
//
// The owner's capture: "Finished (45)", forty-five two-line rows, no way to
// fold the group, clear it, or make the rail badge stop saying 45. Cause: a
// finished session stayed in Finished until somebody "looked at" it (selected
// its tab, or pressed Reviewed), and since R2-01 the fleet holds finished
// sessions with NO open tab, which nobody can ever select. A supervisor
// merging sixty branches a day makes dozens of those.
//
// Everything here is pure, so the grouping, the quiet rules and the undo are
// tested without a view. Nothing here deletes anything: the only thing a bulk
// action ever writes is a reviewed mark.

import Foundation

// MARK: - Groups and their collapse state

/// The pane's groups, in the order attention asks for them.
public enum SessionGroupId: String, CaseIterable, Sendable {
    case needsYou, working, waiting, finished, integrate, idle, history

    public static let displayOrder: [SessionGroupId] = [.needsYou, .working, .waiting, .finished, .integrate, .idle, .history]

    public var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .finished: return "Finished"
        case .integrate: return "Ready to integrate"
        case .idle: return "Idle"
        case .history: return "History"
        }
    }
}

/// Which groups the person folded. Remembered per project, so a project with
/// fifty finished sessions can stay folded while a small one stays open.
public struct SessionGroupCollapse: Equatable, Sendable {
    private var collapsed: Set<SessionGroupId> = []

    public init() {}

    /// From what was stored; a name this build does not know is dropped.
    public init(stored: [String]?) {
        collapsed = Set((stored ?? []).compactMap(SessionGroupId.init(rawValue:)))
    }

    public func isCollapsed(_ id: SessionGroupId) -> Bool { collapsed.contains(id) }

    public mutating func toggle(_ id: SessionGroupId) {
        if !collapsed.insert(id).inserted { collapsed.remove(id) }
    }

    public mutating func set(_ id: SessionGroupId, collapsed shut: Bool) {
        if shut { collapsed.insert(id) } else { collapsed.remove(id) }
    }

    /// Stable order, for the defaults store.
    public var stored: [String] { collapsed.map(\.rawValue).sorted() }

    public static func storageKey(projectId: String) -> String { "marvin.sessionGroups.\(projectId)" }
}

// MARK: - Finished is quiet

public enum FinishedPolicy {
    /// A finished session that is not open as a tab is treated as reviewed this
    /// long after its turn ended. It is not a hunch: the owner's sessions
    /// merge and close within the hour, so a tabless result older than that is
    /// one that was merged, abandoned or left to the supervisor, and the only
    /// place anybody will read it now is History. A session WITH a tab never
    /// settles by itself: the tab is its reminder, and selecting it is the
    /// review.
    public static let tablessAfter: TimeInterval = 60 * 60
    /// The same, once its branch is merged or its checkout is gone: there is
    /// nothing left to review, only a moment to see it land.
    public static let tablessMergedAfter: TimeInterval = 5 * 60
    /// Finished shows this many rows until "Show all".
    public static let quietLimit = 5

    /// True when nobody will look at this one again. A derivation from the
    /// clock, never a stored mark: nothing is written, so nothing is lost.
    public static func isSettled(hasTab: Bool, merged: Bool, endedAt: Date?, now: Date) -> Bool {
        guard !hasTab, let endedAt else { return false }
        return now.timeIntervalSince(endedAt) >= (merged ? tablessMergedAfter : tablessAfter)
    }

    public struct Row: Equatable, Sendable {
        public let id: String
        public let endedAt: Date?
        public let hasTab: Bool
        public let merged: Bool
        public init(id: String, endedAt: Date?, hasTab: Bool, merged: Bool) {
            self.id = id; self.endedAt = endedAt; self.hasTab = hasTab; self.merged = merged
        }
    }

    public struct Plan: Equatable, Sendable {
        /// In display order.
        public let shown: [String]
        public let hiddenCount: Int
        public init(shown: [String], hiddenCount: Int) { self.shown = shown; self.hiddenCount = hiddenCount }
    }

    /// Most recent first, merged ones after the rest (they are the first to
    /// fall behind "Show all"), at most `quietLimit` unless `showAll`.
    public static func plan(_ rows: [Row], showAll: Bool) -> Plan {
        let ordered = rows.enumerated().sorted { a, b in
            if a.element.merged != b.element.merged { return !a.element.merged }
            switch (a.element.endedAt, b.element.endedAt) {
            case let (x?, y?) where x != y: return x > y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.offset < b.offset
            }
        }.map(\.element.id)
        guard !showAll, ordered.count > quietLimit else { return Plan(shown: ordered, hiddenCount: 0) }
        return Plan(shown: Array(ordered.prefix(quietLimit)), hiddenCount: ordered.count - quietLimit)
    }
}

// MARK: - Mark all reviewed, and take it back

/// What a bulk review replaced, so Undo can put it back.
public struct ReviewUndo: Equatable, Sendable {
    public struct Change: Equatable, Sendable {
        public let id: String
        public let before: Date?
        public let after: Date
    }
    public let changes: [Change]
    public init(changes: [Change] = []) { self.changes = changes }
    public var isEmpty: Bool { changes.isEmpty }
}

public enum ReviewMarks {
    /// The mark `markReviewed` writes: the moment of looking, or the turn's
    /// end if that is later. nil when the existing mark already covers it.
    public static func mark(existing: Date?, lastTurnAt: Date?, now: Date) -> Date? {
        let seen = max(now, lastTurnAt ?? .distantPast)
        guard existing.map({ $0 < seen }) ?? true else { return nil }
        return seen
    }

    /// Mark every id reviewed. Pure: returns the new marks and what to restore.
    public static func markAll(ids: [String], reviewed: [String: Date], lastTurnAt: (String) -> Date?, now: Date)
        -> (reviewed: [String: Date], undo: ReviewUndo)
    {
        var out = reviewed
        var changes: [ReviewUndo.Change] = []
        for id in ids {
            guard let seen = mark(existing: reviewed[id], lastTurnAt: lastTurnAt(id), now: now) else { continue }
            out[id] = seen
            changes.append(.init(id: id, before: reviewed[id], after: seen))
        }
        return (out, ReviewUndo(changes: changes))
    }

    /// Put back what `markAll` replaced. A mark made since (the person selected
    /// the tab, pressed Reviewed on a row) is newer than the one undone and stays.
    public static func undo(_ u: ReviewUndo, reviewed: [String: Date]) -> [String: Date] {
        var out = reviewed
        for c in u.changes where out[c.id] == c.after { out[c.id] = c.before }
        return out
    }
}

// MARK: - A session whose work has landed

extension SessionEntry {
    /// Its branch is merged, or its checkout is gone: there is nothing left to
    /// review in the tree. The first to leave Finished.
    public var isMergedOrGone: Bool {
        if worktree?.mergedInto != nil || worktree?.state == "merged" { return true }
        return tree?.mode == .worktree && tree?.present == false
    }
}

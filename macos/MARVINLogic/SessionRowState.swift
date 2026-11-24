// SessionRowState — what a session's dot, badge and row say (ADR-0107).
//
// One derivation, shared by the tab strip, the dock badge and the Sessions
// pane, so the three can never disagree. Precedence: something waiting on
// the user beats everything; a live turn beats history; a turn cut off by a
// restart beats a plain error, because it has an action (Resume) attached;
// a draft has nothing to say yet.
//
// Idle collapse follows Claude Code's agent panel: idle rows hide after a
// timeout, the first few stay, the selected one never collapses.

import Foundation

public enum SessionRowState: Equatable, Sendable {
    case needsYou(Int)
    case working
    case interrupted
    case failed
    /// ADR-0130 — not live, waiting on its own background job or wakeup.
    case waiting
    /// ADR-0130 — not live, nothing pending, the last turn closed scope-met.
    case done
    /// W-08 — the last turn ended with a result (scope met, or completed) and
    /// the person has not looked at the tab since.
    case finished
    case idle
    case draft

    /// Sort order for a list: attention first.
    public var sortRank: Int {
        switch self {
        case .needsYou: return 0
        case .working: return 1
        case .interrupted: return 2
        case .failed: return 3
        case .finished: return 4
        case .waiting: return 5
        case .idle: return 6
        case .done: return 7
        case .draft: return 8
        }
    }

    /// `done` collapses with idle rows; `waiting` stays visible (it has a clock running).
    public var isIdle: Bool { self == .idle || self == .done }

    /// R2-01 — a session that is NOT open as a tab is still part of the fleet
    /// while it is in a state somebody supervising must see: working, waiting,
    /// wanting the person, failed, cut off, or finished and not looked at.
    /// Idle, done (already looked at) and a draft say nothing a person must act on.
    public var staysInFleetWithoutTab: Bool {
        switch self {
        case .needsYou, .working, .interrupted, .failed, .waiting, .finished: return true
        case .done, .idle, .draft: return false
        }
    }
}

public enum SessionRowStateDeriver {
    public static func derive(_ e: SessionEntry, unreviewed: Bool = false) -> SessionRowState {
        if e.needsYou > 0 { return .needsYou(e.needsYou) }
        if e.isLive { return .working }
        if e.interrupted { return .interrupted }
        if e.lastOutcome == .error { return .failed }
        if e.waitingOn != nil { return .waiting }
        // W-08 — a result nobody has looked at yet. A Stop is not a result.
        if unreviewed, e.isDone || e.lastOutcome == .completed { return .finished }
        if e.isDone { return .done }
        if e.isDraft && e.lastOutcome == nil { return .draft }
        return .idle
    }
}

public enum SessionIdleCollapse {
    /// Idle rows hide this long after their turn ended (agent-panel precedent: 30 s).
    public static let collapseAfter: TimeInterval = 30
    /// The first N idle rows stay visible regardless of age.
    public static let alwaysVisibleIdle = 3

    public struct Row: Equatable, Sendable {
        public let id: String
        public let state: SessionRowState
        public let idleSince: Date?
        public init(id: String, state: SessionRowState, idleSince: Date?) {
            self.id = id
            self.state = state
            self.idleSince = idleSince
        }
    }

    public struct Partition: Equatable, Sendable {
        public let visible: [String]
        public let collapsed: [String]
        public init(visible: [String], collapsed: [String]) {
            self.visible = visible
            self.collapsed = collapsed
        }
    }

    /// Input order is preserved. Only `.idle` rows ever collapse; `selected`
    /// never does; `expanded` shows everything.
    public static func partition(_ rows: [Row], selected: String?, now: Date, expanded: Bool) -> Partition {
        if expanded { return Partition(visible: rows.map(\.id), collapsed: []) }
        var visible: [String] = []
        var collapsed: [String] = []
        var idleShown = 0
        for row in rows {
            guard row.state.isIdle, row.id != selected else {
                visible.append(row.id)
                continue
            }
            if idleShown < alwaysVisibleIdle {
                idleShown += 1
                visible.append(row.id)
                continue
            }
            let age = row.idleSince.map { now.timeIntervalSince($0) } ?? .infinity
            if age >= collapseAfter {
                collapsed.append(row.id)
            } else {
                visible.append(row.id)
            }
        }
        return Partition(visible: visible, collapsed: collapsed)
    }
}

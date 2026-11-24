// TabNotifications — which tab events a supervisor of many tabs is told about
// by the system, and how a burst of them is worded (UX review N-01).
//
// Until now exactly one thing posted a notification: the pending-confirm count
// going from 0 to more. A tab that finished, failed or was cut off by a restart
// made no sound, and the one banner that existed named no tab and jumped to none.
//
// This is the decision, with no UI and no clock of its own, so it can be
// tested: feed it what every tab looks like now (`observe`), later ask what to
// say (`flush`). The app layer owns the timer, the selected tab, whether the
// app is in front, and the UNUserNotificationCenter.
//
// What it decides:
//  - an event is a TRANSITION seen in this process. A tab met for the first
//    time is a baseline, so a snapshot full of old failures says nothing.
//  - finished / failed / interrupted need the tab seen `working` before: a row
//    that arrives already failed is history, not news. needs-you is news from
//    any other state.
//  - events wait `coalesceWindow` from the first one, so five tabs finishing
//    within a couple of seconds are one notification.
//  - at flush time an event is dropped if the tab no longer is what the event
//    said (it started another turn, the snapshot then said it waits on a job,
//    it was closed). The tab the user is looking at, in the front app, is never
//    announced to them.
//
// There is no "stalled" event: the app has no stall detector, only the
// attention item the sidecar raises (a closing question, a chain-cap refusal),
// which already counts as `needsYou`. A timer-based stall would be invented.

import Foundation

public enum TabEventKind: String, Equatable, Sendable {
    /// Ordered by how urgently a person is wanted.
    case needsYou, failed, interrupted, finished

    fileprivate var rank: Int {
        switch self {
        case .needsYou: return 0
        case .failed: return 1
        case .interrupted: return 2
        case .finished: return 3
        }
    }

    fileprivate var groupPhrase: String {
        switch self {
        case .needsYou: return "need you"
        case .failed: return "failed"
        case .interrupted: return "were interrupted"
        case .finished: return "finished"
        }
    }
}

/// What the planner needs to know about one tab, at one moment.
public struct TabObservation: Equatable, Sendable {
    public let id: String
    public let title: String
    public let state: SessionRowState
    public let outcome: TurnOutcome?

    public init(id: String, title: String, state: SessionRowState, outcome: TurnOutcome?) {
        self.id = id
        self.title = title
        self.state = state
        self.outcome = outcome
    }
}

/// One system notification, ready to post.
public struct TabNotification: Equatable, Sendable {
    public let kind: TabEventKind
    public let title: String
    public let body: String
    /// The tabs it is about, in the order they were queued. A click selects the first.
    public let tabIds: [String]

    /// Stable per kind and tabs: a repeat replaces the banner instead of stacking.
    public var identifier: String { "marvin.tab.\(kind.rawValue).\(tabIds.joined(separator: "+"))" }
}

/// How a tab is named in a notification, the same way the Sessions pane names it.
public enum TabNotificationTitle {
    public static func make(entryTitle: String?, isDraft: Bool, id: String) -> String {
        if isDraft { return "New chat" }
        if let t = entryTitle?.replacingOccurrences(of: "\n", with: " "),
           !t.trimmingCharacters(in: .whitespaces).isEmpty {
            return t.count > 40 ? String(t.prefix(38)) + "\u{2026}" : t
        }
        return String(id.prefix(8))
    }
}

public struct TabNotificationPlanner {
    private struct Pending {
        let id: String
        let kind: TabEventKind
        let queuedAt: Date
    }

    public let coalesceWindow: TimeInterval
    private var last: [String: SessionRowState] = [:]
    private var pending: [Pending] = []

    public init(coalesceWindow: TimeInterval = 2) {
        self.coalesceWindow = coalesceWindow
    }

    public var hasPending: Bool { !pending.isEmpty }

    /// Seconds until the oldest queued event is due; nil when nothing is queued.
    public func nextFlushDelay(now: Date) -> TimeInterval? {
        guard let first = pending.map(\.queuedAt).min() else { return nil }
        return max(0, coalesceWindow - now.timeIntervalSince(first))
    }

    /// Record how every tab looks now and queue what changed since the last call.
    public mutating func observe(_ tabs: [TabObservation], now: Date) {
        for tab in tabs {
            defer { last[tab.id] = tab.state }
            guard let before = last[tab.id] else { continue }
            guard let kind = Self.event(from: before, to: tab) else { continue }
            pending.removeAll { $0.id == tab.id && $0.kind == kind }
            pending.append(Pending(id: tab.id, kind: kind, queuedAt: now))
        }
    }

    /// What to post now. Returns [] (and keeps the queue) until the oldest event
    /// has waited the whole window; then settles every queued event against how
    /// the tabs look `current`ly and empties the queue.
    public mutating func flush(
        now: Date,
        current: [TabObservation],
        selectedId: String?,
        appIsFrontmost: Bool
    ) -> [TabNotification] {
        guard let delay = nextFlushDelay(now: now), delay <= 0 else { return [] }
        let queued = pending
        pending = []

        let byId = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        var groups: [TabEventKind: [TabObservation]] = [:]
        for event in queued {
            guard let tab = byId[event.id], Self.stillHolds(event.kind, tab) else { continue }
            if appIsFrontmost, event.id == selectedId { continue }
            groups[event.kind, default: []].append(tab)
        }
        return groups.keys.sorted { $0.rank < $1.rank }.map { kind in
            Self.compose(kind, groups[kind] ?? [])
        }
    }

    // MARK: - Rules

    private static func event(from before: SessionRowState, to tab: TabObservation) -> TabEventKind? {
        switch tab.state {
        case .needsYou:
            if case .needsYou = before { return nil }
            return .needsYou
        case .failed:
            return before == .working ? .failed : nil
        case .interrupted:
            return before == .working ? .interrupted : nil
        case .done, .idle, .finished:
            // `.finished` is the row state of a completed turn nobody has looked at yet (W-08); same event.
            // The user pressing Stop is `.cancelled`: not a result, not a finish.
            return before == .working && tab.outcome == .completed ? .finished : nil
        case .working, .waiting, .draft:
            return nil
        }
    }

    private static func stillHolds(_ kind: TabEventKind, _ tab: TabObservation) -> Bool {
        switch (kind, tab.state) {
        case (.needsYou, .needsYou): return true
        case (.failed, .failed): return true
        case (.interrupted, .interrupted): return true
        case (.finished, .done), (.finished, .idle), (.finished, .finished): return true
        default: return false
        }
    }

    private static func compose(_ kind: TabEventKind, _ tabs: [TabObservation]) -> TabNotification {
        let ids = tabs.map(\.id)
        if tabs.count == 1, let tab = tabs.first {
            return TabNotification(kind: kind, title: tab.title, body: body(kind, tab), tabIds: ids)
        }
        let shown = tabs.prefix(3).map(\.title).joined(separator: ", ")
        let rest = tabs.count - 3
        return TabNotification(
            kind: kind,
            title: "\(tabs.count) tabs \(kind.groupPhrase)",
            body: rest > 0 ? "\(shown) and \(rest) more" : shown,
            tabIds: ids
        )
    }

    private static func body(_ kind: TabEventKind, _ tab: TabObservation) -> String {
        switch kind {
        case .needsYou:
            if case .needsYou(let n) = tab.state, n != 1 { return "\(n) things are waiting for your answer" }
            return "1 thing is waiting for your answer"
        case .failed: return "Stopped with an error"
        case .interrupted: return "Cut off by a restart; open it to resume"
        case .finished: return tab.state == .done ? "Finished: scope met" : "Finished its turn"
        }
    }
}

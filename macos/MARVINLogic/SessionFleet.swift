// SessionFleet — the project-wide view of the sessions: how many are working,
// waiting, or need the person, and how a wait is worded and ordered.
//
// Pure, so the Sessions pane, the tab strip, the status bar and the rail badge
// all read ONE derivation (`SessionRowStateDeriver`) and can never disagree.

import Foundation

public struct FleetCounts: Equatable, Sendable {
    public let total: Int
    public let working: Int
    public let waiting: Int
    /// Sessions (not confirms) that wait on an answer from the person.
    public let needsYou: Int
    public init(total: Int, working: Int, waiting: Int, needsYou: Int) {
        self.total = total; self.working = working; self.waiting = waiting; self.needsYou = needsYou
    }
}

public enum SessionFleet {
    /// One state per tab (or live session). Interrupted and failed rows are
    /// NOT counted as needing you: they are history with a Resume chip, and a
    /// stale error would keep the rail badge lit for days.
    public static func counts(_ states: [SessionRowState]) -> FleetCounts {
        var working = 0, waiting = 0, needsYou = 0
        for s in states {
            switch s {
            case .working: working += 1
            case .waiting: waiting += 1
            case .needsYou: needsYou += 1
            default: break
            }
        }
        return FleetCounts(total: states.count, working: working, waiting: waiting, needsYou: needsYou)
    }

    /// How much the status-bar segment says. The bar drops detail before it
    /// drops any other segment.
    public enum Detail: Sendable { case full, compact, minimal }

    /// "11 tabs · 2 working · 5 waiting · 1 needs you"; zero parts vanish.
    /// Empty string means "show nothing".
    public static func summary(_ c: FleetCounts, detail: Detail) -> String {
        guard c.total > 0 else { return "" }
        var parts: [String] = []
        if c.working > 0 { parts.append("\(c.working) working") }
        if c.waiting > 0 { parts.append("\(c.waiting) waiting") }
        if c.needsYou > 0 { parts.append("\(c.needsYou) needs you") }
        let tabs = "\(c.total) tab\(c.total == 1 ? "" : "s")"
        switch detail {
        case .full:
            return ([tabs] + parts).joined(separator: " \u{B7} ")
        case .compact:
            return parts.isEmpty ? tabs : parts.joined(separator: " \u{B7} ")
        case .minimal:
            if c.needsYou > 0 { return "\(c.needsYou) needs you" }
            if c.waiting > 0 { return "\(c.waiting) waiting" }
            return ""
        }
    }
}

public enum SessionWait {
    /// A wait is "long" from 15 minutes. One commit or job step on the gate
    /// takes a few minutes, so a quarter of an hour is several turns of the
    /// queue; on 2026-11-24 six tabs sat 46 to 53 minutes behind one gated
    /// commit and none of them looked different from a tab that had finished.
    /// A constant, not a setting: a threshold nobody tunes is one the whole
    /// fleet reads the same way.
    public static let longAfter: TimeInterval = 15 * 60

    public static func isLong(since: Date?, now: Date) -> Bool {
        guard let since else { return false }
        return now.timeIntervalSince(since) >= longAfter
    }

    /// "<1 min", "46 min", "1 h 12 min", "2 h", "1 d 3 h". Truncates, so a
    /// wait never reads longer than it is.
    public static func duration(since: Date, now: Date) -> String {
        let minutes = Int(max(0, now.timeIntervalSince(since)) / 60)
        if minutes < 1 { return "<1 min" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 {
            let m = minutes % 60
            return m == 0 ? "\(hours) h" : "\(hours) h \(m) min"
        }
        let h = hours % 24
        return h == 0 ? "\(hours / 24) d" : "\(hours / 24) d \(h) h"
    }

    /// The feed's own words for what the session waits on, on one line; a
    /// plain fallback by kind when the feed gave none.
    public static func label(kind: String, label: String?) -> String {
        let text = (label ?? "")
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !text.isEmpty { return text }
        switch kind {
        case "job": return "Waiting on a job"
        case "wakeup": return "Waiting on a wakeup"
        default: return "Waiting"
        }
    }

    /// Oldest wait first; an unknown start goes last; ties keep their order.
    public static func oldestFirst<T>(_ items: [T], since: (T) -> Date?) -> [T] {
        items.enumerated().sorted { a, b in
            switch (since(a.element), since(b.element)) {
            case let (x?, y?): return x != y ? x < y : a.offset < b.offset
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return a.offset < b.offset
            }
        }.map(\.element)
    }
}

extension SessionEntry {
    /// When the wait the feed reports began; nil when not waiting or no start was given.
    public var waitSince: Date? { waitingOn?.since.flatMap(SessionLedger.parseISO) }

    public func isLongWait(now: Date) -> Bool {
        waitingOn != nil && SessionWait.isLong(since: waitSince, now: now)
    }
}

extension SessionLedger {
    /// A wait is known only from a snapshot: no feed event carries it, and a
    /// new turn (`registered`) clears it. So when a turn ENDS the wait it
    /// armed, if any, must be re-read. Without this the pane showed every tab
    /// that had run a turn since the last snapshot as idle (S-01, 2026-11-24).
    public static func restatesWait(after event: SessionFeedEvent) -> Bool {
        if case .ended = event { return true }
        return false
    }
}

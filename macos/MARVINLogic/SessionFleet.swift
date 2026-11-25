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
    /// W-08 — turns that ended with a result and have not been looked at.
    public let finished: Int
    /// R2-03 — of the `waiting` sessions, those whose wait has run `SessionWait.longAfter`.
    public let longWaiting: Int
    /// Failed or cut-off sessions a person can still act on: those with an open
    /// tab, and tabless ones whose turn ended within `FinishedPolicy.tablessAfter`.
    public let attention: Int
    public init(total: Int, working: Int, waiting: Int, needsYou: Int, finished: Int = 0, longWaiting: Int = 0, attention: Int = 0) {
        self.total = total; self.working = working; self.waiting = waiting; self.needsYou = needsYou
        self.finished = finished; self.longWaiting = longWaiting; self.attention = attention
    }
    /// The same number as `finished`, under the name the signals outside the pane use: a
    /// `.finished` row IS "finished, not yet looked at" (a looked-at one is `.done`).
    public var finishedUnreviewed: Int { finished }
}

/// One session as the fleet counts it: its state, and when its wait began.
public struct FleetItem: Equatable, Sendable {
    public let state: SessionRowState
    public let waitingSince: Date?
    /// Whether the session is open as a tab. A session with none has nobody who
    /// can "select" it, so its result is history, not a review waiting.
    public let hasTab: Bool
    /// When its last turn ended.
    public let endedAt: Date?
    public init(state: SessionRowState, waitingSince: Date? = nil, hasTab: Bool = true, endedAt: Date? = nil) {
        self.state = state; self.waitingSince = waitingSince; self.hasTab = hasTab; self.endedAt = endedAt
    }
}

public enum FleetTone: Equatable, Sendable { case quiet, longWait, needsYou }

public struct FleetBadge: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case urgent, review }
    public let count: Int
    public let tone: Tone
    public let help: String
    public init(count: Int, tone: Tone, help: String) { self.count = count; self.tone = tone; self.help = help }
}


public enum SessionFleet {
    /// One state per tab (or live session). Interrupted and failed rows are
    /// counted apart (`attention`), and only while a person can still act on
    /// them: a stale error with no tab would keep the rail badge lit for days.
    public static func counts(_ states: [SessionRowState]) -> FleetCounts {
        counts(states.map { FleetItem(state: $0) }, now: Date())
    }

    /// As above, and `longWaiting` counts the waiting sessions whose own start
    /// time is `SessionWait.longAfter` or more ago (R2-03). A wait with no
    /// start time is never called long: nothing is invented.
    public static func counts(_ items: [FleetItem], now: Date) -> FleetCounts {
        var working = 0, waiting = 0, needsYou = 0, finished = 0, longWaiting = 0, attention = 0
        for item in items {
            switch item.state {
            case .failed, .interrupted:
                // A failure a person can still act on: its tab is open, or it
                // just happened. Weeks of tabless failures are history.
                if item.hasTab || item.endedAt.map({ now.timeIntervalSince($0) < FinishedPolicy.tablessAfter }) == true { attention += 1 }
            case .working: working += 1
            case .waiting:
                waiting += 1
                if SessionWait.isLong(since: item.waitingSince, now: now) { longWaiting += 1 }
            case .needsYou: needsYou += 1
            case .finished:
                // A tabless result is history: nobody can select it to look at it.
                if item.hasTab { finished += 1 }
            default: break
            }
        }
        return FleetCounts(total: items.count, working: working, waiting: waiting, needsYou: needsYou,
                           finished: finished, longWaiting: longWaiting, attention: attention)
    }

    /// R2-01 — the sessions the fleet is made of: every open tab, in strip
    /// order, then every other session of the project that the feed reports as
    /// working, waiting, needing the person, failed, cut off or finished and not
    /// yet looked at. Until 2026-11-24 the second half was "has a running turn",
    /// so a session started elsewhere vanished from the pane, the status bar and
    /// the badge at the moment it began to wait, which is the state a person who
    /// supervises many tabs most wants to see. A tab the person closed is
    /// history whatever it waits on; a live turn is shown regardless, as before.
    public static func memberIds(openTabs: [String], entries: [SessionEntry], state: (SessionEntry) -> SessionRowState) -> [String] {
        var ids: [String] = []
        var seen = Set<String>()
        for id in openTabs where seen.insert(id).inserted { ids.append(id) }
        let extra = entries
            .filter { e in
                !seen.contains(e.id) && e.closedAt == nil
                    && (e.worktree?.closed != true || e.isLive)
                    && state(e).staysInFleetWithoutTab
            }
            .map(\.id)
            .sorted()
        return ids + extra
    }

    /// Sessions the ledger holds that are not a tab, were not closed here, have
    /// no running turn and that a snapshot of the whole fleet no longer lists.
    /// The sidecar leaves a closed session out of that snapshot, and the
    /// snapshot only ever adds or updates rows: without this a session closed
    /// from another client kept its last known wait on screen until the next
    /// launch. The caller marks them closed (they then read as history).
    public static func vanished(entries: [SessionEntry], openTabs: Set<String>, inSnapshot: Set<String>) -> [String] {
        entries
            .filter { !openTabs.contains($0.id) && !inSnapshot.contains($0.id) && $0.closedAt == nil && !$0.isLive && !$0.isDraft }
            .map(\.id)
            .sorted()
    }

    /// How loudly the status-bar chip speaks. A person wanted is orange; a wait
    /// that has run long is the same warm colour with its own words; the rest is quiet.
    public static func tone(_ c: FleetCounts) -> FleetTone {
        if c.needsYou > 0 { return .needsYou }
        if c.longWaiting > 0 { return .longWait }
        return .quiet
    }

    /// The Sessions rail badge: what needs a person. Needs-you + failed or cut off
    /// + finished-unreviewed (with an open tab) + long waits.
    /// Needs-you's colour wins; a long wait is as urgent as a person wanted;
    /// results alone are the calmer "review" tone. nil when there is nothing to look at.
    public static func badge(_ c: FleetCounts) -> FleetBadge? {
        let count = c.needsYou + c.attention + c.finishedUnreviewed + c.longWaiting
        guard count > 0 else { return nil }
        var parts: [String] = []
        if c.needsYou > 0 { parts.append("\(c.needsYou) need\(c.needsYou == 1 ? "s" : "") you") }
        if c.attention > 0 { parts.append("\(c.attention) failed or cut off") }
        if c.finishedUnreviewed > 0 { parts.append("\(c.finishedUnreviewed) finished, not reviewed") }
        if c.longWaiting > 0 { parts.append("\(c.longWaiting) long wait\(c.longWaiting == 1 ? "" : "s")") }
        return FleetBadge(count: count, tone: c.needsYou > 0 || c.attention > 0 || c.longWaiting > 0 ? .urgent : .review,
                          help: parts.joined(separator: " \u{B7} "))
    }

    /// The status-bar chip's tooltip: the summary, then what its colours and counts mean.
    public static func help(_ c: FleetCounts) -> String {
        [
            summary(c, detail: .full),
            "A wait turns orange after \(Int(SessionWait.longAfter / 60)) minutes.",
            "Finished means the last turn ended and the tab has not been opened since.",
            "Click to open Sessions.",
        ].joined(separator: "\n")
    }

    /// How much the status-bar segment says. The bar drops detail before it
    /// drops any other segment.
    public enum Detail: Sendable { case full, compact, minimal }

    /// "11 tabs · 2 working · 5 waiting · 1 needs you · 2 finished"; zero parts vanish.
    /// Empty string means "show nothing".
    public static func summary(_ c: FleetCounts, detail: Detail) -> String {
        guard c.total > 0 else { return "" }
        var parts: [String] = []
        if c.working > 0 { parts.append("\(c.working) working") }
        if c.waiting > 0 { parts.append(waitingText(c)) }
        if c.needsYou > 0 { parts.append("\(c.needsYou) needs you") }
        if c.attention > 0 { parts.append("\(c.attention) failed") }
        if c.finished > 0 { parts.append("\(c.finished) finished") }
        let tabs = "\(c.total) tab\(c.total == 1 ? "" : "s")"
        switch detail {
        case .full:
            return ([tabs] + parts).joined(separator: " \u{B7} ")
        case .compact:
            return parts.isEmpty ? tabs : parts.joined(separator: " \u{B7} ")
        case .minimal:
            if c.needsYou > 0 { return "\(c.needsYou) needs you" }
            if c.waiting > 0 { return waitingText(c) }
            return ""
        }
    }

    private static func waitingText(_ c: FleetCounts) -> String {
        c.longWaiting > 0 ? "\(c.waiting) waiting (\(c.longWaiting) long)" : "\(c.waiting) waiting"
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
    /// The wait's label with a structural cause appended. Only causes this build knows are shown; an unknown one is ignored.
    public static func label(kind: String, label: String?, cause: String?) -> String {
        let base = SessionWait.label(kind: kind, label: label)
        return cause == "restart" ? base + " (re-queued by a restart)" : base
    }

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
    /// The start of the unbroken stretch when the sidecar reports one (ADR-0130 addendum): a tab that re-arms the
    /// same wait every few minutes has still been waiting since the first one. Falls back to this wait's own start.
    public var waitSince: Date? {
        (waitingOn?.waitingSince ?? waitingOn?.since).flatMap(SessionLedger.parseISO)
    }

    /// The feed's structural cause for the wait (`restart`), nil otherwise.
    public var waitCause: String? { waitingOn?.cause }

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

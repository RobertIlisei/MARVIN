// SessionLedger — per-session state for EVERY session of a project, reduced
// from the project feed and the cold-start snapshot (ADR-0107).
//
// A value type with `mutating apply`, in the `SubagentLedger` idiom, so the
// rules are testable without a view or a network: what a `registered` clears,
// what an `ended` closes, why a snapshot must not knock out a live turn it
// merely has not heard about yet.

import Foundation

public struct SessionEntry: Equatable, Identifiable, Sendable {
    public let id: String                       // marvinSessionId
    public var title: String?
    public var mode: SessionMode = .shared
    public var tree: SessionTreeWire?
    public var liveTurnId: String?
    public var liveKind: String?
    public var liveSince: Date?
    /// What the live turn is doing now, from the project feed. nil until the
    /// sidecar has said (a turn starts as "thinking" on the sidecar side).
    public var activity: SessionActivityState?
    /// The tool in use when `activity == .tool`.
    public var activityTool: String?
    /// Keyed by toolUseId, so a re-announced confirm never double-counts.
    public var pendingConfirms: [String: PendingConfirmInfo] = [:]
    /// Confirms answered here, and when — so a snapshot composed before the
    /// answer cannot put them back. Pruned on every snapshot.
    public var resolvedConfirms: [String: Date] = [:]
    public var lastOutcome: TurnOutcome?
    public var lastTurnAt: Date?
    /// The sidecar marked the last turn as cut off by a restart.
    public var interrupted: Bool = false
    public var diff: SessionDiffSummary?
    public var plan: SessionPlanProgress?
    public var costUsd: Double?
    /// Minted in this process, no turn yet.
    public var isDraft: Bool = false
    /// Set when the tab was closed; feeds a "Recent" section.
    public var closedAt: Date?
    /// ADR-0111 — the sidecar's derived worktree state, from the last snapshot.
    public var worktree: SessionWatchRowWire.Worktree?

    public init(id: String) { self.id = id }

    public var isLive: Bool { liveTurnId != nil }
    public var needsYou: Int { pendingConfirms.count }

    /// The brain state this session would show if it were on screen — the
    /// string vocabulary `MarvinBridge.marvinState` already uses. A live turn
    /// the feed has not described yet is "thinking"; nothing live is "idle".
    public var brainState: String {
        if !isLive { return "idle" }
        return activity?.rawValue ?? "thinking"
    }

    /// Short human phrase for a row subtitle: "thinking", "writing", "using Bash".
    public var activityLabel: String? {
        guard isLive, let a = activity else { return nil }
        switch a {
        case .thinking: return "thinking"
        case .writing: return "writing"
        case .tool: return activityTool.map { "using \($0)" } ?? "using a tool"
        }
    }
}

public struct SessionLedger: Equatable, Sendable {
    public private(set) var entries: [String: SessionEntry] = [:]

    public init() {}

    public subscript(id: String) -> SessionEntry? { entries[id] }

    public var needsYouCount: Int { entries.values.reduce(0) { $0 + $1.needsYou } }

    /// Get-or-create. `draft` marks a tab minted locally with no turn yet.
    @discardableResult
    public mutating func ensure(_ id: String, draft: Bool = false) -> SessionEntry {
        if let e = entries[id] { return e }
        var e = SessionEntry(id: id)
        e.isDraft = draft
        entries[id] = e
        return e
    }

    public mutating func remove(_ id: String) { entries[id] = nil }

    /// Put back an entry the caller edited.
    public mutating func replace(_ entry: SessionEntry) { entries[entry.id] = entry }

    // MARK: - Live events

    public mutating func apply(_ event: SessionFeedEvent, now: Date = Date()) {
        var e = ensure(event.sessionId)
        switch event {
        case .registered(_, let turnId, let kind, let startedAt):
            if e.liveTurnId != turnId { e.activity = nil; e.activityTool = nil }
            e.liveTurnId = turnId
            e.liveKind = kind
            e.liveSince = Date(timeIntervalSince1970: startedAt / 1000)
            e.lastOutcome = nil
            e.interrupted = false
            e.isDraft = false
            e.closedAt = nil
        case .ended(_, let turnId, let outcome, let costUsd):
            // A stale `ended` for an older turn must not close a newer one.
            if let live = e.liveTurnId, live != turnId { break }
            e.liveTurnId = nil
            e.liveKind = nil
            e.liveSince = nil
            e.activity = nil
            e.activityTool = nil
            // The sidecar auto-denies every pending confirm when a turn ends.
            e.pendingConfirms.removeAll()
            e.lastOutcome = outcome
            e.lastTurnAt = now
            if let c = costUsd { e.costUsd = (e.costUsd ?? 0) + c }
        case .confirmPending(_, let turnId, let toolUseId, let toolName):
            e.pendingConfirms[toolUseId] = PendingConfirmInfo(turnId: turnId, toolUseId: toolUseId, toolName: toolName)
            if e.liveTurnId == nil { e.liveTurnId = turnId }
        case .confirmResolved(_, _, let toolUseId):
            e.pendingConfirms[toolUseId] = nil
            // Remember it briefly. A snapshot already in flight still lists
            // this confirm as pending, and applying it verbatim put the
            // question back, re-lit the dock badge and offered Allow/Deny for
            // a decision already made (2026-09-11).
            e.resolvedConfirms[toolUseId] = now
        case .tree(_, let tree):
            e.tree = tree
            e.mode = tree.mode
        case .activity(_, let turnId, let state, let tool):
            // Activity for a turn we have not heard `registered` for yet still
            // means the session is live (the two frames race on the wire).
            if let live = e.liveTurnId, live != turnId { break }
            if e.liveTurnId == nil { e.liveTurnId = turnId; e.isDraft = false }
            e.activity = state
            e.activityTool = state == .tool ? tool : nil
        }
        entries[event.sessionId] = e
    }

    // MARK: - Snapshot merge

    /// Merge the cold-start rows. Snapshot fields replace what we hold, with
    /// one exception: a `live` turn is only CLEARED by a snapshot when no
    /// `registered` for that session arrived within `graceSeconds` — the
    /// snapshot may have been built a moment before the feed said otherwise.
    public mutating func apply(snapshot rows: [SessionWatchRowWire], now: Date = Date(), graceSeconds: TimeInterval = 5) {
        for row in rows {
            var e = ensure(row.marvinSessionId)
            if let t = row.turn {
                e.liveTurnId = t.turnId
                e.liveKind = t.kind
                if let s = t.startedAt, let d = Self.parseISO(s) { e.liveSince = d }
                e.isDraft = false
                if let a = row.activity {
                    e.activity = a.state
                    e.activityTool = a.state == .tool ? a.tool : nil
                }
            } else if let since = e.liveSince, now.timeIntervalSince(since) < graceSeconds {
                // Keep it: registered too recently for this snapshot to know.
            } else {
                e.liveTurnId = nil
                e.liveKind = nil
                e.liveSince = nil
                e.activity = nil
                e.activityTool = nil
            }
            if let pending = row.pending {
                // Anything answered within the grace window is OURS to know
                // about: this snapshot was composed before the answer landed.
                let fresh = pending.filter { p in
                    guard let at = e.resolvedConfirms[p.toolUseId] else { return true }
                    return now.timeIntervalSince(at) >= graceSeconds
                }
                e.pendingConfirms = Dictionary(uniqueKeysWithValues: fresh.map { ($0.toolUseId, $0) })
            } else if row.turn == nil {
                e.pendingConfirms.removeAll()
            }
            e.resolvedConfirms = e.resolvedConfirms.filter { now.timeIntervalSince($0.value) < graceSeconds }
            if let tree = row.tree {
                e.tree = tree.wire
                e.mode = tree.mode
            }
            e.worktree = row.worktree
            if let diff = row.diff { e.diff = diff }
            if let plan = row.plan { e.plan = plan }
            if let cost = row.cost { e.costUsd = cost.costUsd }
            if let title = row.title, !title.isEmpty { e.title = title }
            if let last = row.lastTurn {
                switch last.outcome {
                case "completed": e.lastOutcome = .completed; e.interrupted = false
                case "error": e.lastOutcome = .error; e.interrupted = false
                case "interrupted": e.lastOutcome = .error; e.interrupted = true
                // The user pressed Stop. Not a failure, so not a red row, and
                // not resumable, so not an interrupted one either.
                case "stopped": e.lastOutcome = .cancelled; e.interrupted = false
                default: break
                }
                if let endedAt = last.endedAt, let d = Self.parseISO(endedAt) { e.lastTurnAt = d }
            }
            if row.state == "interrupted" { e.interrupted = true }
            entries[row.marvinSessionId] = e
        }
    }

    // MARK: - Local observations (the selected session sees its own events first)

    public mutating func noteTurnStarted(_ id: String, turnId: String, now: Date = Date()) {
        apply(.registered(sessionId: id, turnId: turnId, kind: "human", startedAt: now.timeIntervalSince1970 * 1000), now: now)
    }

    public mutating func noteTurnEnded(_ id: String, outcome: TurnOutcome, costUsd: Double?, now: Date = Date()) {
        let turnId = entries[id]?.liveTurnId ?? ""
        apply(.ended(sessionId: id, turnId: turnId, outcome: outcome, costUsd: costUsd), now: now)
    }

    public mutating func setMode(_ id: String, tree: SessionTreeWire) {
        apply(.tree(sessionId: id, tree: tree))
    }

    public mutating func setTitle(_ id: String, title: String?) {
        var e = ensure(id)
        e.title = title
        entries[id] = e
    }

    public mutating func setDiff(_ id: String, diff: SessionDiffSummary?) {
        var e = ensure(id)
        e.diff = diff
        entries[id] = e
    }

    public mutating func setPlan(_ id: String, done: Int, total: Int) {
        var e = ensure(id)
        e.plan = total > 0 ? SessionPlanProgress(done: done, total: total) : nil
        entries[id] = e
    }

    public mutating func markClosed(_ id: String, at: Date = Date()) {
        var e = ensure(id)
        e.closedAt = at
        entries[id] = e
    }

    public mutating func markInterrupted(_ id: String, _ flag: Bool) {
        var e = ensure(id)
        e.interrupted = flag
        entries[id] = e
    }

    // MARK: - Helpers

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parseISO(_ s: String) -> Date? {
        iso.date(from: s) ?? isoPlain.date(from: s)
    }
}

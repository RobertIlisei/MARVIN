// SessionAttentionOrder — "go to the next tab that needs me" (UX review M-02).
//
// With fourteen tabs the person cannot scan for the one that matters, and
// stepping through the strip (⇧⌘] / ⇧⌘[) visits idle tabs on the way. This is
// the order a single key walks instead: a tab that asks for an answer, then one
// that failed or was cut off, then one that finished and has not been looked
// at, then the longest wait. Everything else is not on the list.

import Foundation

public struct AttentionCandidate: Equatable, Sendable {
    public let id: String
    public let state: SessionRowState
    /// When the wait began (`.waiting`).
    public let waitingSince: Date?
    /// When the last turn ended (`.finished`).
    public let endedAt: Date?
    public init(id: String, state: SessionRowState, waitingSince: Date? = nil, endedAt: Date? = nil) {
        self.id = id; self.state = state; self.waitingSince = waitingSince; self.endedAt = endedAt
    }
}

public enum SessionAttentionOrder {
    /// The tabs worth a visit, most urgent first. Ties keep the strip's order,
    /// except finished (oldest result first) and waiting (longest wait first).
    public static func ordered(_ tabs: [AttentionCandidate]) -> [String] {
        func tier(_ s: SessionRowState) -> Int? {
            switch s {
            case .needsYou: return 0
            case .failed, .interrupted: return 1
            case .finished: return 2
            case .waiting: return 3
            case .working, .done, .idle, .draft: return nil
            }
        }
        func key(_ t: AttentionCandidate) -> Date? {
            switch t.state {
            case .finished: return t.endedAt
            case .waiting: return t.waitingSince
            default: return nil
            }
        }
        let listed = tabs.enumerated().compactMap { i, t in tier(t.state).map { (i, $0, t) } }
        return listed.sorted { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            switch (key(a.2), key(b.2)) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.0 < b.0
            }
        }.map { $0.2.id }
    }

    /// The tab one press lands on: the one after `current` in `ordered`, wrapping;
    /// the first when `current` is not on the list; nil when there is nowhere else to go.
    public static func next(after current: String?, in tabs: [AttentionCandidate]) -> String? {
        let list = ordered(tabs)
        guard let first = list.first else { return nil }
        guard let current, let i = list.firstIndex(of: current) else { return first }
        guard list.count > 1 else { return nil }
        return list[(i + 1) % list.count]
    }
}

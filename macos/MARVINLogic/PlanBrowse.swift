// PlanBrowse — how the Plans panel and the plan checklist decide what to show.
//
// A plan is the tracked `[N]` step list a tab works through (ADR-0046 / 0049 /
// 0052 / 0106 / 0116). The file under `.marvin/plans/` is the APP's
// projection, so everything here is display: it reads a `Plan`, it never
// writes one.
//
// The rule that shapes the glyphs: a step's state must never be colour alone.
// Four states, four different shapes, four words — and a `superseded` step
// (ADR-0106: dropped by the very batch that closed its parent) never wears the
// tick of a done one, because a tick would be a false claim.

import Foundation

// MARK: - Step state

public enum PlanStepState: Equatable, Sendable {
    case pending, inProgress, completed, superseded

    public init(status: String) {
        switch status {
        case "in_progress": self = .inProgress
        case "completed": self = .completed
        case TodoItem.superseded: self = .superseded
        default: self = .pending
        }
    }

    /// SF Symbol. Four distinct shapes: an empty ring, a half-filled one, a
    /// tick, and a minus.
    public var glyph: String {
        switch self {
        case .pending: return "circle"
        case .inProgress: return "circle.lefthalf.filled"
        case .completed: return "checkmark.circle.fill"
        case .superseded: return "minus.circle"
        }
    }

    /// The state in words — the accessibility label, and the tag a superseded
    /// step wears so it cannot be read as done.
    public var word: String {
        switch self {
        case .pending: return "To do"
        case .inProgress: return "In progress"
        case .completed: return "Done"
        case .superseded: return "Superseded"
        }
    }

    /// Out of the way: finished, or dropped.
    public var isClosed: Bool { self == .completed || self == .superseded }

    /// Only a real tick counts toward progress.
    public var countsAsDone: Bool { self == .completed }
}

// MARK: - Progress

public enum PlanProgressText {
    /// "3 / 12".
    public static func text(done: Int, total: Int) -> String { "\(done) / \(total)" }

    public static func fraction(done: Int, total: Int) -> Double {
        total > 0 ? min(1, max(0, Double(done) / Double(total))) : 0
    }

    /// A step's sub-steps. Superseded ones are set aside, not counted either
    /// way — they were never ticked and no longer hold the step open.
    public static func sub(_ step: PlanStep) -> (done: Int, total: Int, superseded: Int) {
        let superseded = step.subtasks.filter { $0.status == TodoItem.superseded }.count
        let live = step.subtasks.count - superseded
        let done = step.subtasks.filter { $0.status == "completed" }.count
        return (done, live, superseded)
    }
}

// MARK: - Step text

public enum PlanStepDisplay {
    /// A step is an action, not the paragraph of the brief it came from.
    public static func lead(_ text: String) -> String { PlanStepTitle.lead(text) }

    /// The whole text with emphasis markers dropped and lines folded together.
    public static func full(_ text: String) -> String {
        text.replacingOccurrences(of: "**", with: "")
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// There is more than the lead to show.
    public static func hasMore(_ text: String) -> Bool { lead(text) != full(text) }
}

// MARK: - Freshness

public enum PlanFreshness {
    /// A plan nobody has touched for this long, with steps still open, is
    /// worth a second look: its tab has probably stopped.
    public static let staleAfter: TimeInterval = 30 * 60

    public static func label(updated: Date?, now: Date = Date()) -> String? {
        guard let updated else { return nil }
        let secs = max(0, now.timeIntervalSince(updated))
        switch secs {
        case ..<60: return "updated just now"
        case ..<3_600: return "updated \(Int(secs / 60))m ago"
        case ..<86_400: return "updated \(Int(secs / 3_600))h ago"
        default: return "updated \(Int(secs / 86_400))d ago"
        }
    }

    public static func isStale(updated: Date?, complete: Bool, now: Date = Date()) -> Bool {
        guard !complete, let updated else { return false }
        return now.timeIntervalSince(updated) >= staleAfter
    }
}

// MARK: - Grouping

public enum PlanGroupKind: String, Equatable, Sendable {
    case active, recent, older

    public var title: String {
        switch self {
        case .active: return "Active"
        case .recent: return "Recent"
        case .older: return "Older"
        }
    }

    /// Past plans fold away until asked for.
    public var startsCollapsed: Bool { self == .older }
}

public struct PlanSection: Equatable, Identifiable, Sendable {
    public let kind: PlanGroupKind
    public let plans: [Plan]
    public var id: String { kind.rawValue }
}

public enum PlanBrowse {
    /// A plan changed within this window is "recent".
    public static let recentWindow: TimeInterval = 7 * 86_400

    public static func matches(_ plan: Plan, query: String) -> Bool {
        let words = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.isEmpty { return true }
        let hay = ([plan.title] + plan.steps.flatMap { [$0.content] + $0.subtasks.map(\.content) }).joined(separator: "\n")
        return words.allSatisfy { hay.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    /// Active (the one the tab works), recent (touched within a week, or not
    /// yet dated and unfinished) and older. Newest first inside a group; a plan
    /// with no known date sorts last.
    public static func sections(_ plans: [Plan], activeId: String?, updated: (Plan) -> Date?,
                                now: Date = Date(), query: String) -> [PlanSection] {
        let shown = plans.filter { matches($0, query: query) }
        var active: [Plan] = [], recent: [Plan] = [], older: [Plan] = []
        for p in shown {
            if p.id == activeId { active.append(p); continue }
            let isRecent: Bool
            if let d = updated(p) { isRecent = now.timeIntervalSince(d) <= recentWindow } else { isRecent = !p.isComplete }
            if isRecent { recent.append(p) } else { older.append(p) }
        }
        func newestFirst(_ list: [Plan]) -> [Plan] {
            // Stable: equal dates keep the order the session produced them in.
            list.enumerated().sorted { a, b in
                switch (updated(a.element), updated(b.element)) {
                case let (x?, y?) where x != y: return x > y
                case (.some, .none): return true
                case (.none, .some): return false
                default: return a.offset < b.offset
                }
            }.map(\.element)
        }
        return [PlanSection(kind: .active, plans: newestFirst(active)),
                PlanSection(kind: .recent, plans: newestFirst(recent)),
                PlanSection(kind: .older, plans: newestFirst(older))].filter { !$0.plans.isEmpty }
    }

    /// The active, unfinished plan shows its steps; a finished plan is one
    /// line; everything else waits to be opened.
    public static func startsExpanded(_ plan: Plan, isActive: Bool) -> Bool {
        isActive && !plan.isComplete
    }

    /// A step's `[N.M]` sub-steps are noise once the step is done.
    public static func subStepsStartOpen(_ step: PlanStep) -> Bool {
        step.status != "completed"
    }
}

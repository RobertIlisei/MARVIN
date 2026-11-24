// ChatStatusStrip — one compact strip instead of five tinted cards (UX review
// round 2: R2-05, R2-07, R2-08, R2-26).
//
// In a tab that was waiting, five stacked cards (plan, waiting on a job,
// backlog, files changed, scope met) left the transcript about 310 of 1030
// points, and each card was a different colour with none of them saying "do
// this". The rule that replaces them:
//
//   - what ASKS something of the person (a confirm, a plan to approve, a
//     decision, a cut-off turn, a scope-met bar) is never folded: it stays a
//     full card, so the newest thing that needs the person is never hidden;
//   - what only REPORTS state (the plan, a job being waited on, files changed,
//     a project-wide backlog count) folds into one line, expandable to the
//     full card on click;
//   - the line starts collapsed once the stack would take a real share of the
//     column, and the person's own open/close always wins.
//
// Pure: the view builds the items, this decides what is open, what is folded,
// what the line says and whether it starts open.

import Foundation
import CoreGraphics

public enum ChatStatusKind: Int, CaseIterable, Sendable {
    // Ask something of the person — never folded.
    case confirm, interrupted, approvePlan, decision, pausedPlan, scopeMet
    // Report state — fold into the strip. Raw order is the summary order.
    case plan, job, files, backlog, resetArmed

    public var needsUser: Bool {
        switch self {
        case .confirm, .interrupted, .approvePlan, .decision, .pausedPlan, .scopeMet: return true
        case .plan, .job, .files, .backlog, .resetArmed: return false
        }
    }
}

public struct ChatStatusItem: Equatable, Sendable, Identifiable {
    public let kind: ChatStatusKind
    /// The item in the strip's own words: "4/5 steps", "waiting on gate · 3 min".
    public let line: String
    /// A long wait: amber, and it leads the line.
    public let attention: Bool
    public var id: Int { kind.rawValue }
    public init(kind: ChatStatusKind, line: String, attention: Bool = false) {
        self.kind = kind; self.line = line; self.attention = attention
    }
}

public enum ChatStatusStrip {
    public struct Split: Equatable, Sendable {
        /// Needs the person: full cards, in the order given.
        public let open: [ChatStatusItem]
        /// Reports state: one line each, attention first, then plan, job, files, backlog.
        public let folded: [ChatStatusItem]
    }

    public static func split(_ items: [ChatStatusItem]) -> Split {
        let open = items.filter { $0.kind.needsUser }
        let folded = items.filter { !$0.kind.needsUser }.enumerated().sorted { a, b in
            if a.element.attention != b.element.attention { return a.element.attention }
            if a.element.kind != b.element.kind { return a.element.kind.rawValue < b.element.kind.rawValue }
            return a.offset < b.offset
        }.map(\.element)
        return Split(open: open, folded: folded)
    }

    /// "4/5 steps · waiting on gate · 3 min · 2 files · 325 parked".
    public static func summary(_ folded: [ChatStatusItem]) -> String {
        folded.map(\.line).joined(separator: " \u{B7} ")
    }

    /// What one folded card costs when expanded, in points (the review measured
    /// 50 to 100 for the cards that stacked).
    public static let estimatedRowHeight: CGFloat = 56
    /// The share of the column the expanded stack may take before the strip
    /// starts collapsed.
    public static let startCollapsedShare: CGFloat = 0.15

    /// Whether the strip starts collapsed, judged from the column's own height
    /// (measured outside the strip, so collapsing cannot flip the answer back).
    public static func startsCollapsed(columnHeight: CGFloat, foldedCount: Int) -> Bool {
        guard foldedCount > 0 else { return false }
        guard columnHeight > 0 else { return true }
        return CGFloat(foldedCount) * estimatedRowHeight > columnHeight * startCollapsedShare
    }

    public static func isExpanded(userChoice: Bool?, columnHeight: CGFloat, foldedCount: Int) -> Bool {
        guard foldedCount > 0 else { return false }
        if let userChoice { return userChoice }
        return !startsCollapsed(columnHeight: columnHeight, foldedCount: foldedCount)
    }

    // MARK: Wording

    public static func planLine(done: Int, total: Int) -> String {
        total > 0 && done >= total ? "plan complete" : "\(done)/\(total) steps"
    }

    public static func filesLine(_ count: Int) -> String {
        "\(count) file\(count == 1 ? "" : "s")"
    }

    public static func backlogLine(_ count: Int) -> String {
        "\(count) parked"
    }

    /// "waiting on gated commit · 3 min". The feed's fallback labels already
    /// start with "Waiting" and are not prefixed twice.
    public static func jobLine(label: String, since: Date?, now: Date) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let phrase: String
        if trimmed.lowercased().hasPrefix("waiting") {
            phrase = trimmed.prefix(1).lowercased() + trimmed.dropFirst()
        } else {
            phrase = "waiting on " + ChipText.fit(trimmed, maxLength: 36)
        }
        guard let since else { return phrase }
        return phrase + " \u{B7} " + SessionWait.duration(since: since, now: now)
    }
}

/// The scope-met bar's actions (R2-07): the step the owner takes next is the
/// primary one; the three housekeeping chips go behind a menu.
public enum ScopeMetBar {
    public enum Action: String, Equatable, Sendable {
        case reviewChanges, markReviewed, saveNote, startFresh, auditSession
    }

    public struct Layout: Equatable, Sendable {
        /// In order; the first is the prominent one.
        public let primary: [Action]
        public let menu: [Action]
    }

    public static func layout(hasChanges: Bool) -> Layout {
        Layout(primary: hasChanges ? [.markReviewed, .reviewChanges] : [.markReviewed],
               menu: [.saveNote, .startFresh, .auditSession])
    }

    /// "Scope met" is the state word, in the same hue as the Finished dot.
    public static func title(reviewed: Bool) -> String {
        reviewed ? "Scope met \u{B7} reviewed" : "Scope met"
    }
}

/// R2-08 — a plan step is an action, not a paragraph of the brief: the bold
/// lead, or the first sentence, or the first line.
public enum PlanStepTitle {
    public static func lead(_ text: String, maxLength: Int = 90) -> String {
        let firstLine = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        if firstLine.hasPrefix("**"), let close = firstLine.dropFirst(2).range(of: "**") {
            let inside = firstLine.dropFirst(2)[..<close.lowerBound].trimmingCharacters(in: .whitespaces)
            if !inside.isEmpty { return ChipText.fit(inside, maxLength: maxLength) }
        }
        return ChipText.fit(firstSentence(of: firstLine), maxLength: maxLength)
    }

    /// Up to and including the first `.`, `?` or `!` that is followed by a
    /// space — so `3.5` and `session-watch.ts` do not end a sentence.
    private static func firstSentence(of line: String) -> String {
        let chars = Array(line)
        for i in chars.indices where ".?!".contains(chars[i]) {
            if i + 1 < chars.count, chars[i + 1] == " " { return String(chars[...i]) }
        }
        return line
    }
}

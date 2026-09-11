// PaneChrome — the DECISIONS a left pane makes about its own chrome, kept
// pure so they can be asserted (ADR-0114).
//
// `MARVINTests` links `MARVINLogic` and nothing else, so a rule that lives in
// a SwiftUI view cannot be tested. Everything here is therefore a value or a
// function over values; the drawing lives in `MARVIN/Pane*.swift` and holds no
// rules of its own.
//
// What is here is exactly what three surveys of the seven panes measured as
// divergent (2026-09-11): empty-state copy written in three different
// registers, count badges in five styles, and header action rows that squeeze
// their own labels.

import Foundation

// MARK: - Empty states

/// What a pane says when it has nothing to show.
///
/// The copy is DATA, not a string literal spread across seven files. Before
/// this, the same idea was written three ways: parenthesised debug text
/// (`(empty tree)`, `(not a git repository)`, `(initialising)`), full
/// sentences (`Open a project to see its skills.`), and bare fragments
/// (`No runs yet.`). A person reading the first kind cannot tell whether the
/// app is broken or simply idle.
///
/// The shape follows Apple's wayfinding question — *where am I, and what can
/// I do here?* — so a headline is required, and a hint that names the next
/// action is expected wherever one exists.
public struct PaneEmptyState: Equatable, Sendable {
    public let headline: String
    public let hint: String?
    public let symbol: String?

    public init(headline: String, hint: String? = nil, symbol: String? = nil) {
        self.headline = headline
        self.hint = hint
        self.symbol = symbol
    }

    /// No project is open. `noun` names what the pane would show — "skills",
    /// "sessions", "changes" — so seven panes give seven specific answers
    /// rather than one generic one.
    public static func noProject(_ noun: String) -> PaneEmptyState {
        PaneEmptyState(
            headline: "No project open",
            hint: "Open a project to see its \(noun).",
            symbol: "folder"
        )
    }

    /// The project is open but this pane's subject does not exist yet.
    public static func nothingYet(_ noun: String, hint: String? = nil) -> PaneEmptyState {
        PaneEmptyState(headline: "No \(noun) yet", hint: hint, symbol: "tray")
    }

    public static func notARepo() -> PaneEmptyState {
        PaneEmptyState(
            headline: "Not a git repository",
            hint: "Run `git init` in this folder, or open one that is already tracked.",
            symbol: "arrow.triangle.branch"
        )
    }

    /// A search ran and matched nothing. The query is quoted back so the user
    /// can see what was actually asked, which is usually the bug.
    public static func noResults(query: String) -> PaneEmptyState {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return PaneEmptyState(
            headline: q.isEmpty ? "No results" : "No results for “\(q)”",
            hint: "Check the pattern, or widen the file filter.",
            symbol: "magnifyingglass"
        )
    }

    /// Waiting on the user to type. Not a failure, and must not read like one.
    public static func awaitingInput(_ what: String) -> PaneEmptyState {
        PaneEmptyState(headline: what, symbol: "magnifyingglass")
    }
}

// MARK: - Count badges

public enum PaneBadge {
    /// The number shown in a section's count capsule.
    ///
    /// Clamped, because a badge is a glance, not a readout: a four-digit count
    /// widens the capsule enough to push a section's own title into
    /// truncation, and the difference between 1,000 and 4,127 findings changes
    /// nothing a person does next.
    public static func text(_ n: Int) -> String {
        if n < 0 { return "0" }
        return n > 999 ? "999+" : String(n)
    }

    /// Whether a count is worth showing at all. Zero is the pane's empty
    /// state's job to explain, not a badge's.
    public static func shows(_ n: Int) -> Bool { n > 0 }
}

// MARK: - Header overflow

/// How many of a pane header's actions stay visible.
///
/// Practice's header put five buttons — three of them text-labelled — plus a
/// title into one row inside a pane that compresses to nothing, and SwiftUI
/// resolved it by truncating the labels: `Run now` became `Run no…`. The same
/// shape was latent in Skills, Plugins and Files.
///
/// The decision is made by COUNT, deliberately, not by measuring the
/// container. A `GeometryReader` or `ViewThatFits` here would re-enter layout
/// to decide layout, which is the oscillation ADR-0062 crashes on; and a rule
/// a person can predict ("more than two and they collapse") is worth more than
/// one that is pixel-perfect but changes under them as they drag.
public enum PaneHeaderOverflow {
    public enum Plan: Equatable, Sendable {
        /// Few enough to show with their labels.
        case inline
        /// Icons only, all still visible.
        case iconOnly
        /// The first `visible` as icons, the rest behind a `…` menu.
        case iconOnlyPlusMenu(visible: Int)
    }

    /// With labels, two actions is the most a 260pt pane holds beside a title.
    public static let inlineLimit = 2
    /// As icons, four fit; beyond that the rest go in the menu.
    public static let iconLimit = 4

    public static func plan(actionCount n: Int) -> Plan {
        if n <= 0 { return .inline }
        if n <= inlineLimit { return .inline }
        if n <= iconLimit { return .iconOnly }
        return .iconOnlyPlusMenu(visible: iconLimit - 1)
    }
}

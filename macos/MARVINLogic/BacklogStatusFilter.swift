// BacklogStatusFilter — filtering the Project Backlog by where an item stands.
//
// The owner, 25.11: "i can't filter by 'in progress' for example, or blocked, or
// by their status in general, only by importance." The data always carried it
// (`status`: provisional / open / doing / done / dismissed, and the orthogonal
// `blocked` flag with `blockedOn`); the window narrowed by severity and kind only.
//
// How it composes with the three-way switch (Open / To review / Resolved): the
// switch stays the top-level view, and a status facet is a filter WITHIN one of
// its scopes. "In progress", "Blocked" and "Open, not started" are Open's;
// "Done" and "Dismissed" are Resolved's; "To review" is the whole of its scope,
// so it has nothing to narrow. The menu offers the current scope's facets; a
// facet chosen in another scope waits there and narrows nothing here, so
// switching scope never leaves a hidden filter on a list.
//
// Several facets are joined by OR ("In progress + Blocked" is the items that are
// either), and the group as a whole is ANDed with severity, kind and search.

import Foundation

public enum BacklogStatusFacet: String, CaseIterable, Identifiable, Sendable {
    case inProgress, blocked, notStarted, toReview, done, dismissed

    public var id: String { rawValue }

    /// The owner's words.
    public var title: String {
        switch self {
        case .inProgress: return "In progress"
        case .blocked: return "Blocked"
        case .notStarted: return "Open, not started"
        case .toReview: return "To review"
        case .done: return "Done"
        case .dismissed: return "Dismissed"
        }
    }

    /// What the facet means, for the menu's tooltip.
    public var help: String {
        switch self {
        case .inProgress: return "A tab or session holds the item (status doing)."
        case .blocked: return "Waiting on something outside the repo, whatever its status."
        case .notStarted: return "Open and not blocked: what can be picked up now."
        case .toReview: return "Auto-captured and waiting for a keep or a dismiss."
        case .done: return "Resolved as done."
        case .dismissed: return "Resolved as not worth doing."
        }
    }

    public var scope: BacklogScope {
        switch self {
        case .inProgress, .blocked, .notStarted: return .open
        case .toReview: return .review
        case .done, .dismissed: return .resolved
        }
    }

    public func matches(_ item: BacklogItem) -> Bool {
        switch self {
        case .inProgress: return item.status == "doing"
        case .blocked: return item.isBlocked
        case .notStarted: return item.status == "open" && !item.isBlocked
        case .toReview: return item.status == "provisional"
        case .done: return item.status == "done"
        case .dismissed: return item.status == "dismissed"
        }
    }

    /// The facets a person can pick in a scope. To review has one, which is the
    /// scope itself, so nothing is offered there.
    public static func facets(in scope: BacklogScope) -> [BacklogStatusFacet] {
        scope == .review ? [] : allCases.filter { $0.scope == scope }
    }

    // MARK: Storage

    /// Comma-joined raw values in declaration order, for `@AppStorage`.
    public static func encode(_ set: Set<BacklogStatusFacet>) -> String {
        allCases.filter { set.contains($0) }.map(\.rawValue).joined(separator: ",")
    }

    /// An unknown word (a facet a later version retired) is dropped, not an error.
    public static func decode(_ raw: String) -> Set<BacklogStatusFacet> {
        Set(raw.split(separator: ",").compactMap { BacklogStatusFacet(rawValue: String($0)) })
    }
}

// MARK: - Chips

/// One active filter, as the strip under the toolbar shows it.
public struct BacklogFilterChip: Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

extension BacklogBrowse {
    /// For each facet of the filter's scope: how many items picking it would show,
    /// under every OTHER filter (scope, search, severity, kind). The facets do not
    /// shrink each other's numbers, or choosing one would zero the rest.
    public static func statusCounts(_ items: [BacklogItem], _ f: BacklogFilter) -> [BacklogStatusFacet: Int] {
        var base = f
        base.statuses = []
        let shown = filter(items, base)
        var out: [BacklogStatusFacet: Int] = [:]
        for facet in BacklogStatusFacet.facets(in: f.scope) {
            out[facet] = shown.filter { facet.matches($0) }.count
        }
        return out
    }

    /// The active filters, one chip each (statuses singly, so one can be removed
    /// alone; severity and kind as one chip apiece). Scope and search are not
    /// filters: the switch and the search box show them.
    public static func chips(_ f: BacklogFilter) -> [BacklogFilterChip] {
        var out = f.activeStatuses.map { BacklogFilterChip(id: "status.\($0.rawValue)", label: $0.title) }
        if f.severities.count < 3 {
            let names = ["high", "med", "low"].filter { f.severities.contains($0) }.map(severityTitle)
            out.append(BacklogFilterChip(id: "severity", label: names.isEmpty ? "Severity: none" : "Severity: " + names.joined(separator: ", ")))
        }
        if !f.hiddenKinds.isEmpty {
            let names = kindOrder.filter { f.hiddenKinds.contains($0) }.map(kindTitle)
            out.append(BacklogFilterChip(id: "kinds", label: "Hiding " + names.joined(separator: ", ")))
        }
        if f.onlyIds != nil { out.append(BacklogFilterChip(id: "flagged", label: "Flagged only")) }
        return out
    }
}

extension BacklogFilter {
    /// The facets that narrow THIS scope; the rest wait for their own.
    public var activeStatuses: [BacklogStatusFacet] {
        BacklogStatusFacet.facets(in: scope).filter { statuses.contains($0) }
    }

    /// What removing one chip leaves.
    public func removing(_ chipID: String) -> BacklogFilter {
        var f = self
        if chipID.hasPrefix("status."), let facet = BacklogStatusFacet(rawValue: String(chipID.dropFirst("status.".count))) {
            f.statuses.remove(facet)
        } else {
            switch chipID {
            case "severity": f.severities = ["high", "med", "low"]
            case "kinds": f.hiddenKinds = []
            case "flagged": f.onlyIds = nil
            default: break
            }
        }
        return f
    }

    /// "Clear filters": everything a chip stands for, and the facets waiting in
    /// other scopes too. The scope and the search text stay: they are the view
    /// and the box the person typed in.
    public func cleared() -> BacklogFilter {
        var f = self
        f.severities = ["high", "med", "low"]
        f.hiddenKinds = []
        f.blocked = .all
        f.statuses = []
        f.onlyIds = nil
        return f
    }
}

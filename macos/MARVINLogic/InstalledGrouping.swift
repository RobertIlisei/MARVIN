// InstalledGrouping — how Skills and Plugins sort what is installed.
//
// Both panes answer the same question ("what is on here, what is waiting, what
// is off?") and used to answer it in different shapes: Skills in three flat
// sections with paragraphs under each, Plugins in one list in disk order with
// the marketplace catalog below. One rule now, so the two read the same.

import Foundation

public struct InstalledEntry: Equatable, Sendable {
    public let id: String
    public let name: String
    public let enabled: Bool
    /// A check found a newer version upstream.
    public let hasUpdate: Bool
    /// The loader skipped it: it is installed, and it is not doing anything.
    public let blocked: Bool

    public init(id: String, name: String, enabled: Bool, hasUpdate: Bool, blocked: Bool) {
        self.id = id; self.name = name; self.enabled = enabled; self.hasUpdate = hasUpdate; self.blocked = blocked
    }
}

/// In reading order: what needs the person first, then what is waiting, then
/// what is on, then what is off.
public enum InstalledGroup: String, CaseIterable, Sendable {
    case attention, needsUpdate, enabled, available

    public var title: String {
        switch self {
        case .attention: return "Not loaded"
        case .needsUpdate: return "Needs update"
        case .enabled: return "On in this project"
        case .available: return "Off in this project"
        }
    }

    /// Stable key for the persisted disclosure state.
    public var key: String { rawValue }
}

public enum InstalledGrouping {
    public struct Section: Equatable, Sendable {
        public let group: InstalledGroup
        public let ids: [String]
    }

    /// Empty groups are left out, not drawn as a header over nothing.
    public static func group(_ entries: [InstalledEntry]) -> [Section] {
        func bucket(_ e: InstalledEntry) -> InstalledGroup {
            if e.blocked { return .attention }
            if e.hasUpdate { return .needsUpdate }
            return e.enabled ? .enabled : .available
        }
        func byName(_ a: InstalledEntry, _ b: InstalledEntry) -> Bool {
            let c = a.name.localizedCaseInsensitiveCompare(b.name)
            return c == .orderedSame ? a.id < b.id : c == .orderedAscending
        }
        return InstalledGroup.allCases.compactMap { g in
            let ids = entries.filter { bucket($0) == g }.sorted(by: byName).map { $0.id }
            return ids.isEmpty ? nil : Section(group: g, ids: ids)
        }
    }
}

import Foundation

/// The decisions behind the Settings block's model pick: which rows, in which
/// order, what Default says, what is selected. Pure, so the view only draws
/// (the same split as the left-pane vocabulary, ADR-0114).
///
/// The pick is the user's own click, in the app: no supervisor verb names a
/// model, and the route it uses is one a tab is denied (ADR-0127 §5).
public enum SupervisorModelPicker {
    /// One row of `GET /api/models`, reduced to what the menu needs.
    public struct Entry: Equatable, Sendable, Identifiable {
        public let id: String
        public let displayName: String
        public let tier: String
        public init(id: String, displayName: String, tier: String) {
            self.id = id; self.displayName = displayName; self.tier = tier
        }
    }

    public struct Group: Equatable, Sendable, Identifiable {
        public let tier: String
        public let entries: [Entry]
        public var id: String { tier }
        public var title: String { tier.uppercased() }
    }

    /// The Models dialog's order, so the two lists read alike.
    public static let tierOrder = ["opus", "sonnet", "haiku", "other"]

    public static func groups(_ entries: [Entry]) -> [Group] {
        tierOrder.compactMap { tier in
            let rows = entries.filter { $0.tier == tier }
            return rows.isEmpty ? nil : Group(tier: tier, entries: rows)
        }
    }

    /// "Default · Sonnet 5.5" while the default is in force; plain "Default"
    /// once a model is picked, because the default's own model is then unknown.
    public static func defaultTitle(_ model: SupervisorStatus.Model?) -> String {
        guard let model, model.choice == nil, let label = model.label ?? model.resolved else { return "Default" }
        return "Default · \(label)"
    }

    /// The stored choice, never the resolved model: Default must be selectable
    /// while a tier row names the very same model.
    public static func selection(_ model: SupervisorStatus.Model?) -> String? { model?.choice }

    /// A stored choice the active provider no longer lists (the provider was
    /// switched). Kept as a row so the menu does not show nothing selected.
    public static func staleEntry(choice: String?, in entries: [Entry]) -> Entry? {
        guard let choice, !entries.contains(where: { $0.id == choice }) else { return nil }
        return Entry(id: choice, displayName: "\(choice) · not in this provider's list", tier: "other")
    }

    // MARK: Keyboard
    //
    // The list is walked with the arrow keys, so every row has a string key:
    // the model id, or "" for Default (a nil id cannot be a cursor value).

    /// Row keys in the order they are drawn: Default, then each tier's rows.
    public static func keys(_ entries: [Entry]) -> [String] {
        [""] + groups(entries).flatMap { $0.entries.map(\.id) }
    }

    public static func cursorKey(choice: String?) -> String { choice ?? "" }

    public static func modelID(forKey key: String) -> String? { key.isEmpty ? nil : key }

    /// One arrow-key step, clamped at both ends. No cursor yet: Default.
    public static func step(from key: String?, by delta: Int, in keys: [String]) -> String {
        guard let key, let i = keys.firstIndex(of: key) else { return keys.first ?? "" }
        return keys[min(max(i + delta, 0), keys.count - 1)]
    }

    public static let accessibilityLabel = "Supervisor model"

    /// The role is app-wide (ADR-0126), not per project; a wake binds the model once at its start.
    public static let help = "Applies from the next wake. Every project's supervisor uses it."
}

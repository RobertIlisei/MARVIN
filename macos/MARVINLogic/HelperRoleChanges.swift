import Foundation

/// What the Models dialog writes on Apply: the rows the user changed, nothing
/// else. The dialog used to PUT the whole role map it loaded when it opened, so
/// a dialog opened before the Supervisor workspace's inline pick wrote the old
/// supervisor model back (and any other tab's pick with it). One PATCH per
/// changed row leaves every row the user did not touch to whoever last set it.
public enum HelperRoleChanges {
    public struct Change: Equatable, Sendable {
        public let role: String
        /// nil puts the role back on its default.
        public let model: String?
        public init(role: String, model: String?) { self.role = role; self.model = model }
    }

    /// `saved` is what the server held when the dialog loaded; `chosen` is what
    /// the dialog now shows. Sorted by role so the writes are deterministic.
    public static func changes(saved: [String: String], chosen: [String: String]) -> [Change] {
        Set(saved.keys).union(chosen.keys)
            .filter { saved[$0] != chosen[$0] }
            .sorted()
            .map { Change(role: $0, model: chosen[$0]) }
    }
}

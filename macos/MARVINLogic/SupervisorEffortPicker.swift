import Foundation

/// The decisions behind the Settings block's effort pick, beside the model chip
/// (the same split as `SupervisorModelPicker`: pure here, drawing in the view).
///
/// Raising effort widens what the supervisor spends, so the pick is the user's
/// own click: no supervisor verb names an effort, the route is one a tab is
/// denied, and a tab cannot write the file it lands in (ADR-0127 §5).
public enum SupervisorEffortPicker {
    public typealias Effort = SupervisorStatus.Model.Effort

    /// The words a rung is shown as. An unknown rung from a newer sidecar shows capitalised.
    public static func title(forKey key: String) -> String {
        switch key {
        case "": return "Default"
        case "xhigh": return "XHigh"
        default: return key.prefix(1).uppercased() + key.dropFirst()
        }
    }

    /// Row keys in the order they are drawn: Default, then the rungs the model can run.
    /// A status with no effort block (an older sidecar) offers Default only.
    public static func keys(_ effort: Effort?) -> [String] { [""] + (effort?.options ?? []) }

    /// The stored choice, never the resolved rung: the row stays marked while
    /// the model cannot run it, so the user sees what they chose.
    public static func selection(_ effort: Effort?) -> String? { effort?.choice }

    /// "High", or "Default" when nothing is chosen or the choice did not fit the model.
    public static func chipTitle(_ effort: Effort?) -> String {
        guard let effort, let choice = effort.choice, !effort.fellBack else { return "Default" }
        return title(forKey: choice)
    }

    /// Said whenever a stored choice fell back, never otherwise.
    public static func fallbackNotice(_ effort: Effort?) -> String? {
        guard let effort, effort.fellBack, let choice = effort.choice else { return nil }
        return "\(title(forKey: choice)) isn't available on this model, so the supervisor runs on Default. Pick another model or effort."
    }

    public static func cursorKey(choice: String?) -> String { choice ?? "" }

    public static func effort(forKey key: String) -> String? { key.isEmpty ? nil : key }

    /// One arrow-key step, clamped at both ends. No cursor yet: Default.
    public static func step(from key: String?, by delta: Int, in keys: [String]) -> String {
        guard let key, let i = keys.firstIndex(of: key) else { return keys.first ?? "" }
        return keys[min(max(i + delta, 0), keys.count - 1)]
    }

    public static let accessibilityLabel = "Supervisor effort"

    /// Like the model, app-wide and bound once at a wake's start; unlike it, it costs more as it rises.
    public static let help = "How hard it thinks. Applies from the next wake. Every project's supervisor uses it; higher effort costs more."
}

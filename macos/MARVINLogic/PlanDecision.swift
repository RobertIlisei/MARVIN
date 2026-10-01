import Foundation

/// Whether a paused turn's last message is asking the user to choose.
///
/// The scope-met handoff is not a question. MARVIN's prompt makes every finished
/// turn close with "Anything else, or should I stop?" plus the
/// `<!-- marvin:scope-met -->` marker; that sentence contains a "?" and
/// "should i", so before this rule every completed tab showed "MARVIN needs your
/// decision" — the user read finished work as blocked. A turn that carries the
/// marker is done, and the mandated closing sentence never counts as a question.
public enum PlanDecision {
    static let scopeMetMarker = "<!-- marvin:scope-met -->"
    static let handoffClose = "anything else, or should i stop?"

    /// True when `text` reads like a decision prompt: it contains a question
    /// mark AND a decision marker, once the scope-met handoff is set aside.
    public static func isAsking(_ text: String) -> Bool {
        if text.contains(scopeMetMarker) { return false }
        let t = text.lowercased().replacingOccurrences(of: handoffClose, with: "")
        guard t.contains("?") else { return false }
        let markers = [
            "decision", "which way", "which option", "(a)", "(b)",
            "option a", "option b", "should i", "let me know", "your call",
            "recommend", "choose", "pick one", "go with",
        ]
        return markers.contains { t.contains($0) }
    }
}

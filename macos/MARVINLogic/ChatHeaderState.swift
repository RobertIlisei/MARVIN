// ChatHeaderState — the small state indicator in the chat header (UX review
// R2-06 / S-02).
//
// The animated orb said "STATE idle" for a tab the pane called Waiting, and
// took 200 to 270 points of the column to say it. The state it shows now comes
// from the same derived row state the Sessions pane and the tab strip read
// (`SessionRowStateDeriver`), so the three cannot disagree, and the indicator
// is a dot and a few words. The large orb stays available, opt-in, and its
// caption follows the same rule.

import Foundation

public enum ChatHeaderState {
    public enum Kind: Equatable, Sendable {
        case working, waiting, needsYou, finished, failed, interrupted, idle
    }

    public struct Indicator: Equatable, Sendable {
        public let kind: Kind
        public let label: String
        /// Only a working tab moves; everything else is still, so a tab that
        /// waits does not read as one that works.
        public let animates: Bool
    }

    public static func indicator(row: SessionRowState, waitLabel: String?, waitingSince: Date?, now: Date) -> Indicator {
        switch row {
        case .working:
            return Indicator(kind: .working, label: "Working", animates: true)
        case .waiting:
            var label = waitPhrase(waitLabel)
            if let waitingSince { label += " \u{B7} " + SessionWait.duration(since: waitingSince, now: now) }
            return Indicator(kind: .waiting, label: label, animates: false)
        case .needsYou(let n):
            return Indicator(kind: .needsYou, label: n > 1 ? "Needs you (\(n))" : "Needs you", animates: false)
        case .finished:
            return Indicator(kind: .finished, label: "Finished, not reviewed", animates: false)
        case .failed:
            return Indicator(kind: .failed, label: "Failed", animates: false)
        case .interrupted:
            return Indicator(kind: .interrupted, label: "Cut off, can resume", animates: false)
        case .done:
            return Indicator(kind: .idle, label: "Done", animates: false)
        case .draft:
            return Indicator(kind: .idle, label: "New chat", animates: false)
        case .idle:
            return Indicator(kind: .idle, label: "Idle", animates: false)
        }
    }

    /// The caption under the optional large orb. While the tab is working the
    /// orb's own word (thinking / tool / writing) is the honest one; for every
    /// state the row knows better than the brain, the row's wording wins.
    public static func orbCaption(row: SessionRowState, brainName: String, waitLabel: String?, waitingSince: Date?, now: Date) -> String {
        switch row {
        case .waiting:
            let phrase = waitPhrase(waitLabel)
            return phrase.prefix(1).lowercased() + phrase.dropFirst()
        case .needsYou: return "needs you"
        case .finished: return "finished, not reviewed"
        case .failed: return "failed"
        case .interrupted: return "cut off, can resume"
        case .working, .idle, .done, .draft: return brainName
        }
    }

    /// "Waiting on gated commit"; the feed's own fallbacks ("Waiting on a job")
    /// are not prefixed twice.
    private static func waitPhrase(_ label: String?) -> String {
        let text = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return "Waiting" }
        if text.lowercased().hasPrefix("waiting") { return text }
        return "Waiting on " + ChipText.fit(text, maxLength: 40)
    }
}

/// The large animated orb is off by default (S-02). A layout saved before that
/// has it on, so it is switched off once, and the person's own choice after that
/// is respected.
public enum BrainOrbDefault {
    public static func migrate(brainOn: Bool, alreadyMigrated: Bool) -> (brainOn: Bool, migrated: Bool) {
        alreadyMigrated ? (brainOn, true) : (false, true)
    }
}

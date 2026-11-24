// SessionRestartTrace — a restart leaves a visible trace (UX review R-01).
//
// On 2026-11-24 the sidecar restarted at 17:49 and an hour later nothing in the
// app said that anything had been cut off. The sidecar already marks a turn a
// restart interrupted (`interrupted` on the session's last turn); the Sessions
// pane showed it as one more row. This is what turns those rows into one
// sentence the person reads once, names the tabs, and can dismiss.
//
// What it cannot say: a background job or wakeup the sidecar re-armed after a
// restart carries no structural mark in the watch feed (only free text the
// tab itself wrote), so those waits are not counted here.

import Foundation

public enum SessionRestartTrace {
    /// The interrupted sessions the person has not dismissed, in the order given.
    public static func pending(interrupted: [String], acknowledged: Set<String>) -> [String] {
        var seen = Set<String>()
        return interrupted.filter { !acknowledged.contains($0) && seen.insert($0).inserted }
    }

    /// Dismissals only last while the session stays interrupted: once it has
    /// run again, a later interruption is news and must show again.
    public static func stillAcknowledged(_ acknowledged: Set<String>, interrupted: [String]) -> Set<String> {
        acknowledged.intersection(interrupted)
    }

    /// "A restart cut off 3 turns: Alpha, Beta, Gamma."
    public static func message(titles: [String], limit: Int = 4) -> String {
        guard !titles.isEmpty else { return "" }
        let n = titles.count
        let shown = titles.prefix(limit).joined(separator: ", ")
        let rest = n > limit ? " and \(n - limit) more" : ""
        return "A restart cut off \(n) turn\(n == 1 ? "" : "s"): \(shown)\(rest)."
    }
}

// StatusBarText — the words of the status bar's figures (UX review round 2, R2-14).
//
// On 2026-11-24 the bar read "ctx 196K" (of what?), "≈$431.27" (today? this
// tab? ever?), "2.171↑" (a decimal?) and a red "graph 164 · reads 273" that
// meant "MARVIN read files instead of asking the code graph", which a person
// watching the fleet cannot act on and which red made read as an error. The
// numbers stay; what they are is now said. Pure, so each sentence is tested.

import Foundation

public enum StatusBarText {
    /// "1M", "1.5M", "200K". A binary million reads as a million.
    public static func windowLabel(_ tokens: Int) -> String {
        if tokens >= 1_000_000 {
            let millions = (Double(tokens) / 1_000_000 * 10).rounded() / 10
            return millions == millions.rounded() ? "\(Int(millions))M" : "\(millions)M"
        }
        return "\(Int((Double(tokens) / 1000).rounded()))K"
    }

    /// "ctx 196K / 1M" on the full bar, "196K/1M" when it is squeezed. With no
    /// known window the limit is left out rather than guessed.
    public static func context(residentTokens: Int, window: Int, full: Bool) -> String {
        let used = "\(Int((Double(residentTokens) / 1000).rounded()))K"
        let figure = window > 0 ? (full ? "\(used) / \(windowLabel(window))" : "\(used)/\(windowLabel(window))") : used
        return full ? "ctx \(figure)" : figure
    }

    /// The chip is today's spend for this project; the full bar says so.
    public static func costChip(_ chip: String, full: Bool) -> String {
        full ? "today \(chip)" : chip
    }

    /// What the "2171↑" / "3↓" figure counts, and what a click does.
    public static func syncHelp(ahead: Int, behind: Int, upstream: String?) -> String {
        guard let upstream else { return "No upstream branch" }
        if ahead == 0 && behind == 0 { return "Up to date with \(upstream). Click to fetch and sync." }
        var parts: [String] = []
        if ahead > 0 { parts.append("\(ahead) commit\(ahead == 1 ? "" : "s") not pushed (\u{2191})") }
        if behind > 0 { parts.append("\(behind) commit\(behind == 1 ? "" : "s") to pull (\u{2193})") }
        return parts.joined(separator: ", ") + " \u{2014} \(upstream). Click to pull, then push."
    }

    /// The graph/reads counter in plain words. It is a measure of how the model
    /// worked, never a failure of the app, so it is not drawn in the error colour.
    public static func graphReadsHelp(graph: Int, reads: Int, hint: String) -> String {
        "\(graph) graph lookups and \(reads) file reads in this chat. Far more reads than lookups means files were read "
            + "directly instead of asking the code graph first: a note on how the work went, not an error.\n\(hint)"
    }
}

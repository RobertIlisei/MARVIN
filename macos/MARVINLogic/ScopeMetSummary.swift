// ScopeMetSummary — extract a one-line memory.md entry from a
// `**Scope met:**` block (ADR-0022 §3). The personality emits prose
// like:
//
//     **Scope met:**
//     - Wired the X handler
//     - Added the Y test
//     - Verified Z behaviour locally
//
//     Anything else, or should I stop?
//     <!-- marvin:scope-met -->
//
// We turn that into a single line suitable for a memory.md append.
// memory.md prefers short, dated entries that survive a future read.
//
// Strategy:
//   1. Find the `**Scope met:**` line.
//   2. Collect bullet lines that follow (one per scope item).
//   3. Concatenate with semicolons for a one-line dense summary.
//   4. Prefix with the current date so memory.md replays read
//      chronologically.
//
// If the scope block can't be parsed (unusual formatting,
// fast-path one-liner), fall back to the first 120 chars of the
// last assistant text — better than nothing.

import Foundation

public enum ScopeMetSummary {
    /// Extract a one-line summary from a list of message-text bodies.
    /// Caller passes the full text of the latest assistant message
    /// (joined across text blocks). Returns a string ready to append
    /// to memory.md.
    public static func extract(fromAssistantText text: String) -> String {
        let date = isoDate()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Look for `**Scope met:**` (case-insensitive on the prose
        // word, but the surrounding markdown bold is the load-bearing
        // marker so we keep it strict).
        let lines = trimmed.components(separatedBy: "\n")
        var bullets: [String] = []
        var inScope = false
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if !inScope {
                if line.lowercased().hasPrefix("**scope met:**") {
                    inScope = true
                    // The rest of the line after the marker can carry
                    // the one-liner fast-path: `**Scope met:** did X.`
                    let after = line.dropFirst("**Scope met:**".count)
                        .trimmingCharacters(in: .whitespaces)
                    if !after.isEmpty {
                        bullets.append(after)
                    }
                }
                continue
            }
            // Inside the scope block. Stop at the trailing prose
            // ("Anything else…") or the sentinel.
            if line.hasPrefix("Anything else") || line.contains("marvin:scope-met") {
                break
            }
            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                bullets.append(String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces))
            } else if line.isEmpty {
                continue
            } else {
                bullets.append(line)
            }
        }

        let summary: String
        if !bullets.isEmpty {
            summary = bullets.map(stripTrailingPeriod).joined(separator: "; ")
        } else {
            // Fallback: first 120 chars of the message.
            let collapsed = trimmed.replacingOccurrences(of: "\n", with: " ")
            let cap = collapsed.count > 120
                ? String(collapsed.prefix(117)) + "..."
                : collapsed
            summary = cap
        }
        return "\(date) — \(summary)"
    }

    /// Convenience overload that takes an array of (role, text)
    /// tuples — pulls the latest assistant text and dispatches.
    /// `messages` is opaque to the helper; the caller filters.
    public static func extract(from latestAssistantText: String?) -> String {
        guard let text = latestAssistantText, !text.isEmpty else {
            return "\(isoDate()) — scope met"
        }
        return extract(fromAssistantText: text)
    }

    private static func isoDate() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter.string(from: Date())
    }

    private static func stripTrailingPeriod(_ s: String) -> String {
        return s.hasSuffix(".") ? String(s.dropLast()) : s
    }
}

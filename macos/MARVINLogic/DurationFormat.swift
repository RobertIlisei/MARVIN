// DurationFormat — render a millisecond count as a human-friendly
// "1h 4m 30s" / "4m 18s" / "12s" string. Used by the chat result
// row and the terminal exit footer so users don't have to mentally
// divide 630885ms into 10m 30s.
//
// Rounding rules:
//   - Sub-second durations show as "0.42s" (two decimals).
//   - Whole seconds and above show as integers.
//   - We round-half-up at each granularity so a 999ms turn shows
//     as "1s" rather than "0s" — feels right for the chat surface
//     where the user sees a real reply.
//
// Pure logic, no UIKit / AppKit imports — testable from MARVINTests.

import Foundation

public enum DurationFormat {
    public static func humanize(ms rawMs: Int) -> String {
        // Negative is degenerate; treat as zero rather than rendering
        // garbage. Callers that care about negative deltas should
        // handle that themselves before reaching the formatter.
        let ms = max(0, rawMs)

        // Sub-second threshold deliberately set below 1000 — anything
        // ≥ 950ms would render as "1.00s" under the %.2f format, which
        // is visually awkward next to "1s" / "2s" / etc. Roll those
        // into the integer-second branch so the rendering is uniform.
        if ms < 950 {
            // Sub-second — show as fractional seconds with two decimals.
            // 0ms still prints "0.00s" which is a fine distinct signal
            // (the row is shown for completed turns, so 0ms is rare).
            let s = Double(ms) / 1_000.0
            return String(format: "%.2fs", s)
        }

        // Round to whole seconds. A 999ms turn rounds to 1s, a 1499ms
        // turn rounds to 1s, a 1500ms turn rounds to 2s.
        let totalSeconds = Int((Double(ms) / 1_000.0).rounded())

        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let seconds = totalSeconds % 60

        if hours > 0 {
            return "\(hours)h \(minutes)m \(seconds)s"
        }
        if minutes > 0 {
            return "\(minutes)m \(seconds)s"
        }
        return "\(seconds)s"
    }
}

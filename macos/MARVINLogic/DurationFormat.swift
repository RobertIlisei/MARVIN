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

// ClockFormat — render an ISO-8601 wall-clock timestamp as "HH:mm:ss"
// (24-hour, local zone by default). Used by the chat result row to show
// WHEN a turn ran, not just how long — so a "completed in 6m 9s" footer
// can read "completed in 6m 9s · 17:45:31 → 17:51:40" and line up against
// server logs. Pure Foundation, no AppKit — testable from MARVINTests.
public enum ClockFormat {
    /// Parse an ISO-8601 timestamp (with or without fractional seconds)
    /// and render it as "HH:mm:ss" in `timeZone`. Returns nil when the
    /// string doesn't parse — old transcripts predate the field, so the
    /// caller falls back to the duration-only footer.
    public static func time(iso: String, timeZone: TimeZone = .current) -> String? {
        guard let date = parse(iso: iso) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }

    /// ISO-8601 parse tolerant of the fractional-seconds variant Node's
    /// `Date.toISOString()` emits (".123Z") and the plain variant.
    static func parse(iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

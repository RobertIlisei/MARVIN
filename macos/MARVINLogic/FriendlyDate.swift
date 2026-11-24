// FriendlyDate — the tab tooltip printed "last active 2026-11-24T16:30:45.057Z"
// (UX review R2-19). `ISO8601DateFormatter()` with default options refuses
// fractional seconds, and the sidecar always writes them, so the parse failed
// and the helper fell back to the raw string. This parses both shapes.

import Foundation

public enum FriendlyDate {
    public static func parse(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: iso) { return d }
        return ISO8601DateFormatter().date(from: iso)
    }

    /// "HH:mm" for a time on the same day as `now`, "M/d" before; the raw text
    /// only when it cannot be read as a date.
    public static func short(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parse(iso) else { return iso }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "HH:mm" : "M/d"
        return f.string(from: date)
    }

    /// "16:30 (3 h 59 min ago)" — a time and an age, for a tooltip.
    public static func lastActive(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parse(iso) else { return iso }
        return "\(short(iso, now: now, calendar: calendar)) (\(SessionWait.duration(since: date, now: now)) ago)"
    }
}

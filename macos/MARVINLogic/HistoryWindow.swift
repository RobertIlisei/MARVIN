// HistoryWindow — the arithmetic behind the transcript's history paging
// control (ADR-0048).
//
// Pure. "Show full log" lifts the render window to `full` (Int.max), and a
// later "Show 200 earlier lines" added 200 to it: an arithmetic-overflow
// trap that killed the app on 2026-10-01. Every widening goes through here.

public enum HistoryWindow {
    /// The whole log: every row rendered, nothing held back.
    public static let full = Int.max

    /// `current` widened by `page`, saturating at `full`.
    public static func widened(_ current: Int, by page: Int) -> Int {
        let (sum, overflow) = current.addingReportingOverflow(page)
        return overflow ? full : sum
    }

    /// True when the window already shows the full log.
    public static func isFull(_ window: Int) -> Bool { window == full }
}

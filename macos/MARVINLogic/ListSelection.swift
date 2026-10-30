// ListSelection — the highlighted row of a filter-as-you-type list.
//
// Quick Open, Go to Symbol and Run Task acted on `selection ?? filtered.first`
// on Return, but drew no highlight until the first arrow key (audit W1): the
// row that would run — a shell command, in Run Task — was invisible. The
// effective selection is now one function that both the highlight and the
// Return key read, so they cannot disagree.

import Foundation

public enum ListSelection {
    /// The row that is highlighted and that Return will act on. `nil` only when
    /// the list is empty. A stored index that fell off the end after the filter
    /// narrowed is pulled back to the last row.
    public static func effective(_ selection: Int?, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let s = selection else { return 0 }
        return min(max(s, 0), count - 1)
    }

    /// Arrow-key movement from the effective selection, stopping at the ends.
    public static func step(_ selection: Int?, by delta: Int, count: Int) -> Int? {
        guard let current = effective(selection, count: count) else { return nil }
        return min(max(current + delta, 0), count - 1)
    }
}

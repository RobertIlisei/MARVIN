// DiffPreview — the few lines of a file's diff the Source Control pane shows
// under the list when a file is selected, and the words for when there are none.
//
// The full diff is a sheet (DiffSheet). This is the glance: what kind of change
// it is (+N −M, counted over the WHOLE diff) and the first rows of it, with a
// number for what was left out so "this is a preview" is never a guess. It is
// built from an already-parsed `UnifiedDiff`; the app parses off the main actor
// and hands the small result back, so selecting a file never blocks the list.
//
// Pure (ADR-0022).

import Foundation

public struct DiffPreview: Equatable, Sendable {
    public enum Row: Equatable, Sendable {
        case hunk(String)
        case line(UnifiedDiffLine)
    }

    public let rows: [Row]
    public let additions: Int
    public let deletions: Int
    /// Hunk bars and lines that exist but are not in `rows`.
    public let hiddenRows: Int

    public var summary: String {
        additions + deletions > 0 ? "+\(additions) \u{2212}\(deletions)" : ""
    }

    public static func make(_ diff: UnifiedDiff, maxRows: Int) -> DiffPreview {
        var rows: [Row] = []
        var total = 0
        var adds = 0, dels = 0
        for hunk in diff.hunks {
            total += 1
            if rows.count < maxRows { rows.append(.hunk(hunk.header)) }
            for line in hunk.lines {
                total += 1
                switch line.kind {
                case .added: adds += 1
                case .removed: dels += 1
                case .context, .noNewline: break
                }
                if rows.count < maxRows { rows.append(.line(line)) }
            }
        }
        return DiffPreview(rows: rows, additions: adds, deletions: dels, hiddenRows: total - rows.count)
    }

    /// Why there is nothing to show, or nil when there is.
    public static func empty(binary: Bool, truncated: Bool, empty: Bool) -> String? {
        if binary { return "Binary file — open the diff to see its size." }
        if truncated { return "Over 2 MB — too large to preview." }
        if empty { return "No changes in this view." }
        return nil
    }
}

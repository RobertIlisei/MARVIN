// MarkdownFlow — which markdown blocks can share one text view.
//
// Chat prose renders through `RichText`, an `NSTextView` per block, because
// SwiftUI's `Text` cannot give you selection AND a working link cursor at the
// same time. The cost was invisible until someone tried to copy: **selection
// cannot cross two independent text systems**, so a drag stopped at the end
// of whatever paragraph or list item it started in (user, 2026-09-01: "i
// can't select new lines in the box, i can only select 1 line at a time").
//
// The fix is to stop making so many of them. Consecutive prose blocks —
// headings, paragraphs, lists — are one continuous flow of text and can share
// a single view, which makes a drag across them one selection.
//
// Code blocks, tables and rules stay standalone, and that is not laziness:
// each is a different SwiftUI view with its own layout, highlighting or
// geometry, and folding them into a run of attributed text would lose what
// makes them readable. Quotes stay standalone too — the bar down their left
// edge is an overlay on the view, so merging one into a shared run would
// leave the bar spanning its neighbours' text.
//
// Pure (ADR-0022) so the grouping is pinned without a window.

import Foundation

public enum MarkdownFlowGroup: Equatable {
    /// Blocks that share one text view, in order. Never empty.
    case flow([MarkdownBlock])
    /// A block that renders as its own view.
    case standalone(MarkdownBlock)
}

public enum MarkdownFlow {
    /// True when a block is prose that can share a text view with its
    /// neighbours.
    public static func isFlowable(_ block: MarkdownBlock) -> Bool {
        switch block {
        case .heading, .paragraph, .list: return true
        case .code, .table, .quote, .rule: return false
        }
    }

    /// Group blocks into runs that can share a text view.
    ///
    /// A single flowable block still comes back as `.flow([block])` rather
    /// than `.standalone` — the renderer takes one path for prose and the
    /// distinction is "how is this laid out", not "how many are there".
    public static func group(_ blocks: [MarkdownBlock]) -> [MarkdownFlowGroup] {
        var out: [MarkdownFlowGroup] = []
        var run: [MarkdownBlock] = []
        func flush() {
            if !run.isEmpty {
                out.append(.flow(run))
                run = []
            }
        }
        for block in blocks {
            if isFlowable(block) {
                run.append(block)
            } else {
                flush()
                out.append(.standalone(block))
            }
        }
        flush()
        return out
    }
}

// TabStripScroll — the chat tab strip's motion and marks (UX review R2-18, S-05).
//
// Selecting a tab used to centre it, so the strip slid under the pointer and a
// different tab arrived where the click had been. The rule now is the one a
// native tab bar follows: move only when the selected tab is not fully in view,
// and then by the least that brings it in.

import Foundation
import CoreGraphics

public enum TabStripScroll {
    public enum Reveal: Equatable, Sendable {
        /// Fully visible, or nothing measured yet: do not move the strip.
        case none
        /// Cut off on the left: align the tab's leading edge to the viewport's.
        case leading
        /// Cut off on the right: align the tab's trailing edge to the viewport's.
        case trailing
    }

    /// Tab `index` occupies `[leadingInset + index * (tabWidth + spacing), + tabWidth]`
    /// in the scrolled content; the viewport shows `[contentOffset, + viewportWidth]`.
    public static func reveal(index: Int, tabWidth: CGFloat, spacing: CGFloat, leadingInset: CGFloat,
                              contentOffset: CGFloat, viewportWidth: CGFloat) -> Reveal {
        guard viewportWidth > 0, index >= 0 else { return .none }
        let tolerance: CGFloat = 0.5
        let minX = leadingInset + CGFloat(index) * (tabWidth + spacing)
        let maxX = minX + tabWidth
        if minX < contentOffset - tolerance { return .leading }
        if maxX > contentOffset + viewportWidth + tolerance { return .trailing }
        return .none
    }
}

/// What a tab's state glyph is tinted. The view maps it to a colour; keeping the
/// rule here pins the thresholds: amber from `SessionWait.longAfter`, blue while
/// a result is unreviewed.
public enum TabGlyphTone: Equatable, Sendable {
    case neutral, muted, amber, blue, failed, working, draft
}

public enum TabStripGlyph {
    public static func tone(_ state: SessionRowState, waitingSince: Date?, now: Date) -> TabGlyphTone {
        switch state {
        case .waiting: return SessionWait.isLong(since: waitingSince, now: now) ? .amber : .neutral
        case .needsYou, .interrupted: return .amber
        case .working: return .working
        case .failed: return .failed
        case .finished: return .blue
        case .done, .idle: return .muted
        case .draft: return .draft
        }
    }
}

/// S-05 — a chip label cut at a word with an ellipsis, never mid-word and never
/// with nothing to say that it was cut.
public enum ChipText {
    public static func fit(_ text: String, maxLength: Int) -> String {
        guard maxLength > 1, text.count > maxLength else { return text }
        let head = String(text.prefix(maxLength - 1))
        var body = head
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > maxLength / 2 {
            body = String(head[..<space])
        }
        while let last = body.last, " \u{B7}\u{2014}\u{2013}-:,;".contains(last) { body.removeLast() }
        return body + "\u{2026}"
    }
}

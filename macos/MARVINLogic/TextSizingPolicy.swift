// TextSizingPolicy — how an AppKit text view answers SwiftUI's size probes.
//
// 2026-09-28: MARVIN froze with a large session open. The exceptions log's
// `LayoutOscillationProbe` captures showed assistant rows flipping between
// 45 pt and 69–76 pt tall at a FIXED row width, forty times a second, and the
// transcript stack cycling between 5,200 and 5,789 pt. The row's prose renders
// through `RichText`, whose `sizeThatFits` answered every non-finite or zero
// width proposal with a made-up 400 pt:
//
//     width = proposal.width.map { $0.isFinite && $0 > 0 ? $0 : 400 } ?? 400
//
// SwiftUI stacks probe a child at width 0 (its minimum) and at infinity (its
// maximum) before placing it at a real width. So a one-line reply reported a
// minimum of 400 pt — wider than a real 300 pt placement — and a maximum of
// 400 pt — narrower than its real 1,190 pt placement — each with the height of
// the text wrapped at 400 pt (two or three lines). A lazy stack mixing cached
// and fresh answers of that kind never converges.
//
// The rule below is how SwiftUI's own `Text` behaves: the ideal and maximum
// width is the natural, unwrapped width; the minimum is zero; a real width is
// filled.
import CoreGraphics

public enum TextSizingPolicy {
    /// The width to report and to measure the height at, for a SwiftUI
    /// `proposal.width`, given the text's natural single-line width.
    public static func width(proposal: CGFloat?, naturalWidth: CGFloat) -> CGFloat {
        let natural = max(0, naturalWidth)
        guard let p = proposal else { return natural }   // ideal size
        guard p.isFinite else { return natural }          // maximum probe
        guard p > 0 else { return 0 }                     // minimum probe
        return p                                          // a real width: fill it
    }

    /// The width to lay the text out at when measuring its height. A zero
    /// (minimum) probe is answered at the natural width — one line — rather
    /// than by typesetting at zero width, which would put one glyph per line
    /// and cost a full layout of every long string on every probe.
    public static func measuringWidth(reported: CGFloat, naturalWidth: CGFloat) -> CGFloat {
        reported > 0 ? reported : max(1, naturalWidth)
    }
}

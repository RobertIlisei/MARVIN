// SkeletonRows — placeholder rows shown while a pane's first load is in
// flight, so a slow fetch reads as "loading" rather than as empty or broken.
//
// Added 2026-09-30: the backlog showed "No open backlog items" for 10–15 s
// while 1,076 items were still loading, and Source Control sat on a spinner.
// A skeleton has the shape of the content it stands in for, so the pane does
// not jump when the rows arrive.

import SwiftUI

struct SkeletonRows: View {
    /// How many placeholder rows to draw.
    var count: Int = 6
    /// Lines per row after the title bar (0 for single-line lists).
    var detailLines: Int = 1
    /// Draw each row as a card, the way the backlog does.
    var card: Bool = false

    var body: some View {
        // Static on purpose. A `repeatForever` pulse re-runs the view graph on
        // every display frame for as long as the skeleton is up; inside the
        // transcript's lazy stack that pinned the main thread at 100 % and the
        // load it stood in for never finished (2026-10-01).
        VStack(alignment: .leading, spacing: card ? 8 : 10) {
            ForEach(0..<count, id: \.self) { i in
                row(i)
            }
        }
        .opacity(0.6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
    }

    private func row(_ i: Int) -> some View {
        // Varied widths so the block reads as text, not as a grid of bars.
        let widths: [CGFloat] = [0.55, 0.72, 0.4, 0.64, 0.5, 0.8]
        let w = widths[i % widths.count]
        return HStack(alignment: .top, spacing: 10) {
            if card {
                Circle().fill(.quaternary).frame(width: 12, height: 12).padding(.top, 2)
            }
            // Width-capped bars, not GeometryReader: this app's layout breaker
            // counts passes against views in the window (AGENTS.md).
            VStack(alignment: .leading, spacing: 6) {
                bar(maxWidth: 520 * w, height: 11)
                ForEach(0..<detailLines, id: \.self) { line in
                    bar(maxWidth: line == detailLines - 1 ? 380 : 640, height: 8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(card ? 8 : 0)
        .background {
            if card {
                RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor).opacity(0.5))
            }
        }
    }

    private func bar(maxWidth: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: height / 2)
            .fill(.quaternary)
            .frame(maxWidth: maxWidth, minHeight: height, maxHeight: height)
    }
}

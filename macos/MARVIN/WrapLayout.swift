// WrapLayout — lays children out left to right and wraps to a new line when the
// proposed width runs out.
//
// A row of fixed-size chips used to be an HStack: its ideal width is the sum of
// its chips, so in a narrow left pane it pushed the row past the pane and the
// control beside it (Plugins' Update chip) was clipped (U4). Left-pane rows must
// not demand width (DESIGN.md Layout), so a row that can be long wraps instead.
// The layout's minimum is its widest single child, so it compresses like any
// flexible view.

import SwiftUI

struct WrapLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.reduce(0) { $0 + $1.height } + CGFloat(max(lines.count - 1, 0)) * lineSpacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for item in line.items {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y), anchor: .topLeading,
                    proposal: ProposedViewSize(item.size)
                )
                x += item.size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }

    private struct Line {
        var items: [(index: Int, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Line] {
        var lines: [Line] = []
        var current = Line()
        for (index, view) in subviews.enumerated() {
            // Offered the line width, so a long Text wraps within it while a
            // fixed-size chip reports its own size.
            let size = view.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            let needed = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.items.isEmpty {
                lines.append(current)
                current = Line()
            }
            current.width = current.items.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.items.append((index, size))
        }
        if !current.items.isEmpty { lines.append(current) }
        return lines
    }
}

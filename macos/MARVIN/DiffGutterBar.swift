// DiffGutterBar — M5. 3px-wide NSView overlay pinned to the right
// edge of the STLineNumberRulerView. Draws a colored strip for each
// changed line: green (added), orange (modified), red triangle
// (removed — small downward pip between lines). Mirrors VS Code's
// left-edge gutter markers.
//
// Positioning: STTextView uses NSFont.monospacedSystemFont(12, .regular)
// with textContainerInset = (4, 4). Line height is computed from the
// font's ascender/descender + leading, rounded to the nearest pixel.
// The ruler's coordinate origin is at its top (flipped = true for NSRulerView
// subclasses), so y grows downward.

import AppKit

final class DiffGutterBar: NSView {
    weak var textView: (NSView & NSTextContent)?  // STTextView
    var diffLines: [Int: DiffLineStatus] = [:]

    private static let barWidth: CGFloat = 3
    private static let topInset: CGFloat = 4  // STTextView.textContainerInset.height

    init(textView: NSView) {
        self.textView = textView as? (NSView & NSTextContent)
        super.init(frame: .zero)
        wantsLayer = false  // draw in draw(_:) for crisp lines

        // Redraw when the scroll position changes.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(scrolled),
            name: NSView.boundsDidChangeNotification,
            object: textView.enclosingScrollView?.contentView
        )
    }

    required init?(coder: NSCoder) { fatalError() }

    @objc private func scrolled() { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        guard !diffLines.isEmpty else { return }
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let lh = lineHeight()
        let scrollY = textView?.enclosingScrollView?.contentView.bounds.origin.y ?? 0
        let topInset = Self.topInset

        for (lineNo, status) in diffLines {
            let y = topInset + CGFloat(lineNo - 1) * lh - scrollY

            // Skip lines outside the visible area of the ruler.
            guard y + lh > dirtyRect.minY, y < dirtyRect.maxY + lh else { continue }

            let color: NSColor
            switch status {
            case .added:    color = NSColor.systemGreen
            case .modified: color = NSColor.systemOrange
            case .removed:  color = NSColor.systemRed
            }

            ctx.setFillColor(color.cgColor)
            if status == .removed {
                // Small triangular pip between lines for deletions.
                let midY = y - 1
                let path = CGMutablePath()
                path.move(to: CGPoint(x: 0, y: midY))
                path.addLine(to: CGPoint(x: Self.barWidth, y: midY))
                path.addLine(to: CGPoint(x: Self.barWidth / 2, y: midY + 4))
                path.closeSubpath()
                ctx.addPath(path)
                ctx.fillPath()
            } else {
                // Solid bar spanning the line.
                ctx.fill(CGRect(x: 0, y: y, width: Self.barWidth, height: lh))
            }
        }
    }

    private func lineHeight() -> CGFloat {
        // Measure from the monospaced font used by the editor.
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let h = font.ascender + abs(font.descender) + font.leading
        // Round up to whole pixel, minimum 14.
        return max(14, ceil(h))
    }
}

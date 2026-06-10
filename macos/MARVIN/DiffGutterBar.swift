// DiffGutterBar — M5. 3px-wide NSView overlay pinned to the right
// edge of the STLineNumberRulerView. Draws a colored strip for each
// changed line: green (added), orange (modified), red triangle
// (removed — small downward pip between lines). Mirrors VS Code's
// left-edge gutter markers.
//
// The strip is a FIXED-size view covering the ruler's visible area;
// each marker's document position is mapped into that area by
// subtracting the scroll offset. The earlier version positioned markers
// from a font-metric *guess* of a uniform line height — that sub-pixel
// guess error compounded with the line number, so the bars drifted
// further off the deeper you scrolled (and a missing `isFlipped`
// override mirrored them, sending them the wrong way entirely).
//
// This version takes no such guess. It reads each changed line's real
// top + height from STTextView's TextKit 2 layout fragments and caches
// that geometry, rebuilding only when the change set itself changes —
// so scrolling just re-uses the cache (no per-tick re-layout, no jank).

import AppKit
import STTextView

final class DiffGutterBar: NSView {
    weak var textView: STTextView?
    var diffLines: [Int: DiffLineStatus] = [:] {
        didSet {
            geometryDirty = true
            needsDisplay = true
        }
    }

    private static let barWidth: CGFloat = 3

    /// lineNo → (document-space top, height), from the real layout.
    private var lineGeometry: [Int: (top: CGFloat, height: CGFloat)] = [:]
    private var geometryDirty = true

    init(textView: STTextView) {
        self.textView = textView
        super.init(frame: .zero)
        wantsLayer = false  // draw in draw(_:) for crisp lines

        // Redraw when the scroll position changes. NSClipView posts
        // bounds-changed by default; set it explicitly so a redraw is
        // guaranteed on every scroll tick.
        if let clip = textView.enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(scrolled),
                name: NSView.boundsDidChangeNotification,
                object: clip
            )
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Match the ruler / text view's flipped (top-origin) coordinates.
    /// Without this every marker is mirrored vertically.
    override var isFlipped: Bool { true }

    @objc private func scrolled() { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        guard !diffLines.isEmpty,
              let textView,
              let ctx = NSGraphicsContext.current?.cgContext else { return }

        rebuildGeometryIfNeeded(textView)

        // bounds.origin.y already folds in any clip-view content inset,
        // so (documentTop - scrollY) is the on-screen y within the strip.
        let scrollY = textView.enclosingScrollView?.contentView.bounds.origin.y ?? 0

        for (lineNo, status) in diffLines {
            guard let geo = lineGeometry[lineNo] else { continue }
            let y = geo.top - scrollY
            let h = geo.height

            // Skip markers outside the visible (dirty) band.
            guard y + h > dirtyRect.minY, y < dirtyRect.maxY else { continue }

            let color: NSColor
            switch status {
            case .added:    color = NSColor.systemGreen
            case .modified: color = NSColor.systemOrange
            case .removed:  color = NSColor.systemRed
            }

            ctx.setFillColor(color.cgColor)
            if status == .removed {
                // Small triangular pip at the line's top edge for deletions.
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
                ctx.fill(CGRect(x: 0, y: y, width: Self.barWidth, height: h))
            }
        }
    }

    /// Walk the TextKit 2 layout fragments once and record the real top +
    /// height of each changed line. The editor doesn't wrap, so one line
    /// fragment == one physical (newline-delimited) line, matching the
    /// new-side line numbers DiffGutterService produces. Enumeration stops
    /// after the last changed line so we never lay out the whole document
    /// for a change near the top.
    private func rebuildGeometryIfNeeded(_ textView: STTextView) {
        guard geometryDirty, !diffLines.isEmpty else { return }

        let maxLine = diffLines.keys.max() ?? 0
        var geo: [Int: (top: CGFloat, height: CGFloat)] = [:]
        let ltm = textView.textLayoutManager
        var lineNo = 0

        ltm.enumerateTextLayoutFragments(
            from: ltm.documentRange.location,
            options: [.ensuresLayout]
        ) { fragment in
            let fragTop = fragment.layoutFragmentFrame.minY
            let lineFragments = fragment.textLineFragments
            if lineFragments.isEmpty {
                lineNo += 1  // defensive: never stall the counter
            } else {
                for line in lineFragments {
                    lineNo += 1
                    if diffLines[lineNo] != nil {
                        geo[lineNo] = (
                            top: fragTop + line.typographicBounds.minY,
                            height: line.typographicBounds.height
                        )
                    }
                }
            }
            return lineNo < maxLine  // keep going until past the last change
        }

        // Only mark clean once layout actually produced fragments; if it
        // wasn't ready (lineNo stayed 0) leave it dirty so the next draw
        // — triggered by a scroll or the next diff load — re-measures.
        if lineNo > 0 {
            lineGeometry = geo
            geometryDirty = false
        }
    }
}

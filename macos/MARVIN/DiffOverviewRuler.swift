// DiffOverviewRuler — the scrollbar-track change map. A thin NSView
// pinned over the editor's vertical scroller that draws one tick per
// changed line, positioned proportionally to the line's place in the
// document, so every hunk in the file is visible at once without
// scrolling. Mirrors VS Code's "overview ruler".
//
// DiffGutterBar (the 3px strip beside the line numbers) answers "is
// THIS line changed?" and needs real layout geometry for that. This
// view answers "WHERE in the file are the changes?" — a question about
// the whole document, not the visible band — so it maps by line number
// over line count and never touches the layout manager. That keeps it
// O(changed lines) per draw and independent of how far the user has
// scrolled.
//
// It sits BELOW the overlay scroller in the view order and refuses hit
// testing, so the knob still draws on top and still receives drags.

import AppKit
import STTextView

final class DiffOverviewRuler: NSView {
    weak var textView: STTextView?

    var diffLines: [Int: DiffLineStatus] = [:] {
        didSet { needsDisplay = true }
    }

    /// Wide enough to sit under a legacy scroller (15pt) as well as the
    /// overlay one; the ticks themselves are narrower and right-aligned
    /// so they read as part of the track, not a second gutter.
    static let width: CGFloat = 14
    private static let tickWidth: CGFloat = 6
    private static let minTickHeight: CGFloat = 2

    init(textView: STTextView) {
        self.textView = textView
        super.init(frame: .zero)
        wantsLayer = false
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Top-origin, matching the document and the gutter bar.
    override var isFlipped: Bool { true }

    /// Never intercept the scroller's clicks or the content's.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard !diffLines.isEmpty,
              let textView,
              let ctx = NSGraphicsContext.current?.cgContext else { return }

        // Newline count, not layout height: with wrap off the two agree,
        // and with wrap on the difference is a few points on a long file —
        // acceptable for a map whose job is "roughly there".
        let lineCount = max(1, Self.lineCount(of: textView.string))
        let height = bounds.height
        let perLine = height / CGFloat(lineCount)
        let tickHeight = max(Self.minTickHeight, perLine)
        let x = bounds.width - Self.tickWidth - 2

        // Draw in status order so a modified tick is never hidden under an
        // adjacent added one when lines are denser than points.
        for status in [DiffLineStatus.added, .modified, .removed] {
            let color: NSColor
            switch status {
            case .added:    color = .systemGreen
            case .modified: color = .systemOrange
            case .removed:  color = .systemRed
            }
            ctx.setFillColor(color.cgColor)
            for (lineNo, s) in diffLines where s == status {
                let y = CGFloat(lineNo - 1) * perLine
                guard y + tickHeight >= dirtyRect.minY, y <= dirtyRect.maxY else { continue }
                ctx.fill(CGRect(x: x, y: y, width: Self.tickWidth, height: tickHeight))
            }
        }
    }

    static func lineCount(of text: String) -> Int {
        var n = 1
        for byte in text.utf8 where byte == 0x0A { n += 1 }
        return n
    }
}

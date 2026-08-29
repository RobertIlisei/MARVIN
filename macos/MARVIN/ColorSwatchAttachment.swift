// ColorSwatchAttachment — inline colour chips beside hex literals in the
// editor, the way VS Code / Antigravity render a design token.
//
// `colors: primary: "#285232"` is unreadable as text: the reader has to
// imagine the colour. Antigravity draws a small filled square immediately
// before the literal, and the user asked for the same (2026-08-29,
// side-by-side of DESIGN.md).
//
// ## How it attaches
//
// An `NSTextAttachment` with a custom cell, inserted into the text view's
// attributed string as an EXTRA character before each literal — which would
// corrupt the buffer if it were really inserted. It is not: the attachment is
// applied as an ATTRIBUTE on the literal's first character
// (`.marvinColorSwatch`) and drawn by the layout manager, so `textView.string`
// is untouched, the byte offsets the editor reports to the status bar stay
// correct, and saving writes exactly what was loaded. Nothing downstream can
// tell the difference; only the pixels change.
//
// ## Formats recognised
//
// `#RGB`, `#RRGGBB`, `#RRGGBBAA` (and the `0x`-prefixed spellings CSS-in-Swift
// uses), plus `rgb()` / `rgba()` with integer channels. Deliberately NOT named
// CSS colours: "red" and "green" appear constantly in prose and code as words,
// and a swatch beside every one of them is noise, not information.

import AppKit
import MARVINLogic

extension NSAttributedString.Key {
    /// Marks a range whose first character should draw a colour chip.
    static let marvinColorSwatch = NSAttributedString.Key("marvinColorSwatch")
}

enum ColorSwatch {
    /// One recognised colour literal, with the range to decorate.
    struct Hit {
        let range: NSRange
        let color: NSColor
    }

    /// Scanning lives in `MARVINLogic.ColorLiteralScanner` (pure, tested);
    /// this wrapper only turns channels into an `NSColor`.
    static func scan(_ text: String, limit: Int = 500) -> [Hit] {
        ColorLiteralScanner.scan(text, limit: limit).map {
            Hit(
                range: NSRange(location: $0.location, length: $0.length),
                color: NSColor(
                    srgbRed: CGFloat($0.red), green: CGFloat($0.green),
                    blue: CGFloat($0.blue), alpha: CGFloat($0.alpha)
                )
            )
        }
    }
}

/// Draws the chip. A rounded square in the colour, with a hairline border so a
/// white swatch is still visible on a light background and a black one on dark.
final class ColorSwatchCell: NSTextAttachmentCell {
    private let color: NSColor
    private let side: CGFloat = 9

    init(color: NSColor) {
        self.color = color
        super.init()
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not supported") }

    override func cellSize() -> NSSize {
        // Width includes the gap to the literal, so no layout code downstream
        // has to know a swatch is there.
        NSSize(width: side + 4, height: side)
    }

    override func cellBaselineOffset() -> NSPoint {
        // Sit on the text baseline rather than hanging below it.
        NSPoint(x: 0, y: -1)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let box = NSRect(x: cellFrame.minX, y: cellFrame.minY, width: side, height: side)
        let path = NSBezierPath(roundedRect: box.insetBy(dx: 0.5, dy: 0.5), xRadius: 2, yRadius: 2)
        color.setFill()
        path.fill()
        NSColor.separatorColor.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

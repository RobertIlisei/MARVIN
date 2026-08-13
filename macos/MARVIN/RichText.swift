// RichText — AppKit-backed inline text for chat output.
//
// SwiftUI's `Text` gives you text selection OR working links, not both:
// `.textSelection(.enabled)` turns the whole run into a selection surface, so
// the I-beam cursor wins everywhere and a link never advertises itself as
// clickable. That's the difference the user spotted against Cursor — the link
// fired, but nothing about the pointer said it would.
//
// `NSTextView` does both natively: pointing-hand cursor over `.link` ranges,
// `clickedOnLink` for activation, and ordinary selection everywhere else. So
// every prose block that can contain a link renders through here instead.
//
// The text view is deliberately NOT wrapped in an NSScrollView — it reports its
// intrinsic height through `sizeThatFits`, and SwiftUI lays it out like any
// other view. That keeps it composable inside the table's custom `Layout`.

import AppKit
import MARVINLogic
import SwiftUI

struct RichText: NSViewRepresentable {
    let attributed: NSAttributedString
    /// Return true when the link was handled in-app; false lets AppKit open it.
    let onLink: (URL) -> Bool

    func makeNSView(context: Context) -> LinkTextView {
        // Explicit TextKit 1 stack. `NSTextView()` defaults to TextKit 2 on
        // macOS 14, where `layoutManager` is nil and the used-rect height query
        // in `sizeThatFits` has nothing to ask.
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(
            size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude)
        )
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)

        let view = LinkTextView(frame: .zero, textContainer: container)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = NSSize.zero
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        // Our own attributes carry the link styling; without this AppKit
        // repaints every link in its default blue and drops the code tint that
        // makes a file path scannable.
        view.linkTextAttributes = [NSAttributedString.Key.cursor: NSCursor.pointingHand]
        view.delegate = context.coordinator
        context.coordinator.onLink = onLink
        return view
    }

    func updateNSView(_ view: LinkTextView, context: Context) {
        context.coordinator.onLink = onLink
        if view.textStorage?.isEqual(to: attributed) != true {
            view.textStorage?.setAttributedString(attributed)
        }
    }

    /// Height for the width SwiftUI proposes.
    ///
    /// This must be CHEAP and it must not touch the live view. SwiftUI calls
    /// `sizeThatFits` many times per view per layout pass (stack layouts probe
    /// candidate widths), and the first version answered by resizing the real
    /// text container and calling `ensureLayout` — which invalidates the whole
    /// layout, so every probe re-typeset the entire string. Nested inside the
    /// table's stack layouts that went combinatorial: MARVIN hung for 9 minutes
    /// on the main thread inside NSLayoutManager, sampled mid-ICU-line-break.
    ///
    /// So measurement goes to a shared offscreen text stack and is memoised on
    /// (text, width). Repeat probes then cost a dictionary lookup.
    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: LinkTextView,
        context: Context
    ) -> CGSize? {
        let width = proposal.width.map { $0.isFinite && $0 > 0 ? $0 : 400 } ?? 400
        return CGSize(width: width, height: TextMeasurer.height(of: attributed, width: width))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency NSTextViewDelegate {
        var onLink: (URL) -> Bool = { _ in false }

        func textView(
            _ textView: NSTextView,
            clickedOnLink link: Any,
            at charIndex: Int
        ) -> Bool {
            let url: URL? = (link as? URL) ?? (link as? String).flatMap { URL(string: $0) }
            guard let url else { return false }
            return onLink(url)
        }
    }
}

/// NSTextView tuned for sitting inline in a SwiftUI transcript.
///
/// It DOES take first responder — selection is impossible otherwise — so
/// clicking chat text moves focus off the composer, same as clicking text in
/// any editor.
final class LinkTextView: NSTextView {

    /// Let scroll events through to the enclosing SwiftUI ScrollView. Without
    /// this the transcript stops scrolling whenever the pointer happens to rest
    /// over a paragraph.
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

/// Shared offscreen text stack for height measurement, with a memo on
/// (text, width). Kept separate from any displayed view so measuring never
/// invalidates what's on screen.
@MainActor
enum TextMeasurer {
    private struct Key: Hashable {
        let text: Int
        let length: Int
        let width: CGFloat
    }

    private static var cache: [Key: CGFloat] = [:]
    private static let cap = 4000

    private static let container: NSTextContainer = {
        let c = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        c.lineFragmentPadding = 0
        c.widthTracksTextView = false
        return c
    }()

    private static let storage: NSTextStorage = {
        let s = NSTextStorage()
        let lm = NSLayoutManager()
        s.addLayoutManager(lm)
        lm.addTextContainer(container)
        return s
    }()

    static func height(of attributed: NSAttributedString, width: CGFloat) -> CGFloat {
        // Round the width so sub-pixel probe jitter doesn't miss the cache.
        let w = (width * 2).rounded() / 2
        let key = Key(text: attributed.string.hashValue, length: attributed.length, width: w)
        if let hit = cache[key] { return hit }

        storage.setAttributedString(attributed)
        container.size = NSSize(width: w, height: CGFloat.greatestFiniteMagnitude)
        guard let lm = storage.layoutManagers.first else { return 0 }
        lm.ensureLayout(for: container)
        let height = ceil(lm.usedRect(for: container).height)

        if cache.count >= cap { cache.removeAll(keepingCapacity: true) }
        cache[key] = height
        return height
    }
}

// MARK: - Inline markup → NSAttributedString

/// Builds the AppKit attributed string for one inline run of markdown.
///
/// Mirrors what the SwiftUI path used to do (bold / italic / code / links), but
/// in AppKit attributes so `NSTextView` can render it. Block structure is still
/// `ChatMarkdown.parse`'s job — this only handles what lives inside a block.
enum MarkdownInline {
    static func build(
        _ source: String,
        font: NSFont,
        color: NSColor,
        workDir: String?
    ) -> NSAttributedString {
        let parsed = (try? AttributedString(
            markdown: source,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )) ?? AttributedString(source)

        let out = NSMutableAttributedString(parsed)
        let full = NSRange(location: 0, length: out.length)
        out.addAttributes([.font: font, .foregroundColor: color], range: full)

        // Foundation TAGS inline runs with presentation intents but applies no
        // visual styling, so `code` would come out identical to prose.
        out.enumerateAttribute(.inlinePresentationIntent, in: full) { value, range, _ in
            guard let raw = value as? UInt else { return }
            let intent = InlinePresentationIntent(rawValue: raw)
            if intent.contains(.code) {
                out.addAttributes(
                    [
                        .font: NSFont.monospacedSystemFont(ofSize: font.pointSize - 0.5, weight: .regular),
                        .foregroundColor: codeTint,
                        .backgroundColor: codeBackground,
                    ],
                    range: range
                )
            }
            if intent.contains(.stronglyEmphasized) {
                out.addAttribute(.font, value: trait(font, .boldFontMask), range: range)
            }
            if intent.contains(.emphasized) {
                out.addAttribute(.font, value: trait(font, .italicFontMask), range: range)
            }
        }

        // Markdown-syntax links first, then the ones we detect ourselves.
        out.enumerateAttribute(.link, in: full) { value, range, _ in
            guard value != nil else { return }
            style(out, range: range, kind: .web)
        }
        for span in MarkdownLinks.webSpans(in: out.string)
            + MarkdownLinks.fileSpans(in: out.string, workDir: workDir) {
            guard span.range.upperBound <= out.length,
                  out.attribute(.link, at: span.range.location, effectiveRange: nil) == nil
            else { continue }
            out.addAttribute(.link, value: span.url, range: span.range)
            style(out, range: span.range, kind: span.kind)
        }
        return out
    }

    private static func style(
        _ s: NSMutableAttributedString,
        range: NSRange,
        kind: MarkdownLinkSpan.Kind
    ) {
        s.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
        // File refs keep their inline-code tint — recolouring them would fight
        // the styling that makes a path scannable. Web links take the accent.
        if kind == .web {
            s.addAttribute(.foregroundColor, value: NSColor.controlAccentColor, range: range)
        }
    }

    private static func trait(_ font: NSFont, _ mask: NSFontTraitMask) -> NSFont {
        NSFontManager.shared.convert(font, toHaveTrait: mask)
    }

    /// Warm tint on a faint chip, matching how Cursor and Claude Code surface
    /// `code` inside prose.
    static let codeTint = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedRed: 0.98, green: 0.65, blue: 0.45, alpha: 1)
            : NSColor(calibratedRed: 0.72, green: 0.28, blue: 0.10, alpha: 1)
    }

    static let codeBackground = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.08)
            : NSColor(white: 0, alpha: 0.05)
    }
}

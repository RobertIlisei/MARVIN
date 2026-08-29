// MarkdownView — renders assistant chat output as formatted markdown.
//
// Block structure comes from `ChatMarkdown.parse` (MARVINLogic, unit-tested);
// this file is purely presentation. Inline markup (**bold**, *italic*,
// `code`, links) is delegated to `AttributedString(markdown:)` rather than
// hand-parsed — Foundation already does it correctly, including escapes.
//
// Code blocks reuse `SyntaxHighlighter`, the same tree-sitter path the file
// viewer uses, so a ```swift fence in chat is coloured by the same grammar
// that colours the file on disk. Unknown languages degrade to plain
// monospace rather than failing.

import AppKit
import MARVINLogic
import SwiftUI

struct MarkdownView: View {
    let text: String
    /// Assistant/system/result text fills the row; user text sizes to its
    /// bubble.
    let fillWidth: Bool
    var baseFont: Font = .body
    var baseColor: Color = .primary
    /// Project root, so `path:line` references can be resolved and opened.
    var workDir: String?

    private var blocks: [MarkdownBlock] { ChatMarkdown.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: fillWidth ? .infinity : nil, alignment: .leading)
        .textSelection(.enabled)
        // Route clicks: our private file scheme opens the file in MARVIN's
        // editor; everything else (http/https) goes to the browser.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == MarkdownLinks.fileScheme else { return .systemAction }
            let path = url.path
            guard !path.isEmpty else { return .handled }
            let line = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "line" })
                .flatMap { $0.value }
                .flatMap(Int.init)
            MarvinBridge.shared.openFileFromChat(path: path, line: line)
            return .handled
        })
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            rich(text, font: headingNSFont(level), color: nsBaseColor)
                .padding(.top, level <= 2 ? 4 : 2)

        case let .paragraph(text):
            rich(text, font: baseNSFont, color: nsBaseColor)

        case let .code(language, content):
            CodeBlockView(language: language, content: content)

        case let .table(headers, rows):
            MarkdownTableView(
                headers: headers,
                rows: rows,
                attributed: { text, font in
                    attributed(text, font: font, color: nsBaseColor)
                },
                onLink: Self.handleLink
            )

        case let .list(items, ordered):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    // .top, not .firstTextBaseline: an NSViewRepresentable
                    // publishes no text baseline, so baseline alignment put the
                    // marker on its own line above the item.
                    HStack(alignment: .top, spacing: 6) {
                        Text(ordered ? "\(idx + 1)." : "•")
                            .font(baseFont)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 18 : 10, alignment: .trailing)
                        rich(item, font: baseNSFont, color: nsBaseColor)
                    }
                }
            }

        case let .quote(text):
            // The bar is drawn as a leading OVERLAY on the text, not as an
            // HStack sibling: a bare `Rectangle` is greedy vertically, so as a
            // sibling it stretched to the container's full height and the quote
            // bar ran hundreds of points past its own text.
            rich(text, font: baseNSFont, color: .secondaryLabelColor)
                .padding(.leading, 11)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.35))
                        .frame(width: 3)
                }

        case .rule:
            MarvinDivider().padding(.vertical, 2)
        }
    }

    private func rich(_ s: String, font: NSFont, color: NSColor) -> some View {
        RichText(
            attributed: attributed(s, font: font, color: color),
            onLink: Self.handleLink
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Single place both the chat body and the table route clicks through:
    /// our private scheme opens the file in MARVIN's editor, anything else
    /// falls back to AppKit (i.e. the browser).
    static func handleLink(_ url: URL) -> Bool {
        guard url.scheme == MarkdownLinks.fileScheme else { return false }
        let path = url.path
        guard !path.isEmpty else { return true }
        let line = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "line" })
            .flatMap { $0.value }
            .flatMap(Int.init)
        MarvinBridge.shared.openFileFromChat(path: path, line: line)
        return true
    }

    private var baseNSFont: NSFont {
        baseFont == .caption
            ? NSFont.preferredFont(forTextStyle: .caption1)
            : NSFont.preferredFont(forTextStyle: .body)
    }

    private var nsBaseColor: NSColor {
        baseColor == .secondary ? .secondaryLabelColor : .labelColor
    }

    private func headingNSFont(_ level: Int) -> NSFont {
        let body = NSFont.preferredFont(forTextStyle: .body).pointSize
        switch level {
        case 1: return .systemFont(ofSize: body + 4, weight: .bold)
        case 2: return .systemFont(ofSize: body + 2, weight: .bold)
        case 3: return .systemFont(ofSize: body, weight: .semibold)
        default: return .systemFont(ofSize: body - 1, weight: .semibold)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(.title2, weight: .bold)
        case 2: return .system(.title3, weight: .bold)
        case 3: return .system(.headline, weight: .semibold)
        default: return .system(.subheadline, weight: .semibold)
        }
    }

    /// Build the AppKit attributed string for one inline run, memoised.
    ///
    /// This is called from `body`, so a streaming turn would otherwise re-parse
    /// every visible paragraph on every token — and link detection adds a
    /// `stat` per candidate path on top. The result is a pure function of
    /// (text, workDir, font, colour), so cache on exactly that. Cleared
    /// wholesale past the cap: a chat that long has scrolled well past its
    /// early paragraphs, and re-parsing them costs less than tracking recency.
    private func attributed(_ s: String, font: NSFont, color: NSColor) -> NSAttributedString {
        let key = "\(workDir ?? "")\u{0}\(font.fontName)|\(font.pointSize)\u{0}\(color.hash)\u{0}\(s)"
        if let hit = Self.inlineCache[key] { return hit }
        let built = MarkdownInline.build(s, font: font, color: color, workDir: workDir)
        if Self.inlineCache.count >= Self.inlineCacheCap {
            Self.inlineCache.removeAll(keepingCapacity: true)
        }
        Self.inlineCache[key] = built
        return built
    }

    @MainActor private static var inlineCache: [String: NSAttributedString] = [:]
    private static let inlineCacheCap = 600
}

private struct CodeBlockView: View {
    let language: String
    let content: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if !language.isEmpty {
                    Text(language.lowercased())
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(content, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.secondary.opacity(0.10))

            // No horizontal ScrollView: it proposes unbounded width, which
            // collapsed the code body to nothing. Long lines wrap instead —
            // preferable to invisible code.
            Text(highlighted)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(MarvinTheme.elevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(MarvinTheme.border, lineWidth: 0.5)
        )
    }

    /// Syntax-highlight via the same tree-sitter path the file viewer uses.
    /// Falls back to plain monospace when the language is unknown or parsing
    /// fails — broken highlighting must never hide the code.
    private var highlighted: AttributedString {
        let base: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.labelColor,
        ]
        guard
            let ext = ChatMarkdown.fileExtension(forLanguage: language),
            let spans = SyntaxHighlighter.highlight(content: content, fileExtension: ext),
            !spans.isEmpty
        else { return AttributedString(content) }

        // NSRange-based attribution: the highlighter already speaks NSRange
        // (UTF-16), so building an NSAttributedString and converting once is
        // both simpler and safer than translating every span into
        // AttributedString indices.
        let ns = NSMutableAttributedString(string: content, attributes: base)
        let isDark = NSApp.effectiveAppearance
            .bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let length = (content as NSString).length
        for span in spans {
            guard span.range.location >= 0,
                  span.range.location + span.range.length <= length,
                  let color = HighlightTheme.color(
                    forCapture: span.captureName,
                    isDark: isDark
                  )
            else { continue }
            ns.addAttribute(.foregroundColor, value: color, range: span.range)
        }
        return AttributedString(ns)
    }
}

// MARK: - Table

/// Row layout that distributes the PROPOSED width across columns by weight.
///
/// Every GeometryReader-based attempt at this failed the same way: the measured
/// width came from a view whose size depended on the content being measured, so
/// once the table grew it could never observe a narrower parent — shrinking the
/// panel left stale column widths and clipped the right-hand columns. A custom
/// `Layout` is handed `proposal.width` directly on every pass, so it always
/// knows the real available width and cannot feed back into itself.
private struct TableRowLayout: Layout {
    /// Relative column weights (same length as the subview list).
    let weights: [CGFloat]
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let widths = columnWidths(for: proposal.width ?? 0, count: subviews.count)
        var height: CGFloat = 0
        for (idx, sub) in subviews.enumerated() {
            let w = widths[idx]
            let size = sub.sizeThatFits(.init(width: w, height: nil))
            height = max(height, size.height)
        }
        return CGSize(width: proposal.width ?? widths.reduce(0, +), height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard !subviews.isEmpty else { return }
        let widths = columnWidths(for: bounds.width, count: subviews.count)
        var x = bounds.minX
        for (idx, sub) in subviews.enumerated() {
            let w = widths[idx]
            sub.place(
                at: CGPoint(x: x, y: bounds.minY),
                anchor: .topLeading,
                proposal: .init(width: w, height: nil)
            )
            x += w + spacing
        }
    }

    /// Split `total` (minus gaps) by weight, honouring a per-column minimum so
    /// a one-character column stays legible.
    private func columnWidths(for total: CGFloat, count: Int) -> [CGFloat] {
        let gaps = spacing * CGFloat(max(count - 1, 0))
        let usable = max(total - gaps, 0)
        let w = weights.count == count ? weights : [CGFloat](repeating: 1, count: count)
        let sum = w.reduce(0, +)
        guard sum > 0, usable > 0 else {
            return [CGFloat](repeating: usable / CGFloat(count), count: count)
        }
        let minWidth = min(CGFloat(30), usable / CGFloat(count))
        let floorTotal = minWidth * CGFloat(count)
        let flexible = max(usable - floorTotal, 0)
        return w.map { minWidth + flexible * ($0 / sum) }
    }
}

private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    let attributed: (String, NSFont) -> NSAttributedString
    let onLink: (URL) -> Bool

    static let cellFont = NSFont.preferredFont(forTextStyle: .caption1)
    static let headerFont = NSFont.systemFont(
        ofSize: NSFont.preferredFont(forTextStyle: .caption1).pointSize,
        weight: .semibold
    )

    private var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    /// Weight = longest cell in the column, clamped so a `#` column stays
    /// legible and one prose cell can't swallow the table.
    private var weights: [CGFloat] {
        (0..<columnCount).map { idx in
            var longest = idx < headers.count ? headers[idx].count : 0
            for row in rows where idx < row.count {
                longest = max(longest, row[idx].count)
            }
            return CGFloat(min(max(longest, 4), 55))
        }
    }

    var body: some View {
        let gap: CGFloat = 12
        let w = weights
        VStack(alignment: .leading, spacing: 0) {
            TableRowLayout(weights: w, spacing: gap) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, h in
                    RichText(
                        attributed: attributed(h, Self.headerFont),
                        onLink: onLink
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.vertical, 6)
            MarvinDivider()
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                TableRowLayout(weights: w, spacing: gap) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        RichText(
                            attributed: attributed(cell, Self.cellFont),
                            onLink: onLink
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.vertical, 6)
                if rowIdx < rows.count - 1 { MarvinDivider() }
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
    }
}

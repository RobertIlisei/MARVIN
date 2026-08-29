// MarkdownFilePreview — the rendered view of a Markdown file in the editor
// pane, toggled from the file viewer's toolbar (⇧⌘V).
//
// Antigravity opens a "Preview <file>.md" tab beside the source; MARVIN
// replaces the editor in place instead. The editor is already one column of a
// three-pane window, and splitting it again leaves two columns too narrow to
// read prose in — the reason the user wanted a preview at all. The toggle is
// per-tab, so a source tab and a preview tab can sit side by side simply by
// opening the file twice.
//
// Rendering reuses `ChatMarkdown` + `MarkdownView`, the same parser and
// renderer the chat uses. That is deliberate: a second Markdown implementation
// would drift from the first, and the chat's renderer is already exercised on
// every assistant reply.
//
// YAML front matter is rendered as a definition list rather than dumped as
// text. A design-token file (`DESIGN.md`) opens with 60 lines of it, and
// `ChatMarkdown` would otherwise show the `---` fences as horizontal rules
// with the keys as one run-on paragraph.

import MARVINLogic
import SwiftUI

struct MarkdownFilePreview: View {
    let text: String
    var workDir: String?

    private var split: (frontMatter: [(key: String, value: String)], body: String) {
        MarkdownFrontMatterParser.split(text)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                let parts = split
                if !parts.frontMatter.isEmpty {
                    frontMatterTable(parts.frontMatter)
                }
                MarkdownView(
                    text: parts.body,
                    fillWidth: true,
                    baseFont: .system(size: 14),
                    baseColor: MarvinTheme.textPrimary,
                    workDir: workDir
                )
            }
            // A measured line length. Full-bleed prose across a wide pane is
            // the thing that makes rendered Markdown harder to read than the
            // source it replaced.
            .frame(maxWidth: 820, alignment: .leading)
            .padding(.horizontal, 28)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(MarvinTheme.panel)
    }

    private func frontMatterTable(_ pairs: [(key: String, value: String)]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                HStack(alignment: .top, spacing: 10) {
                    Text(pair.key)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .frame(width: 120, alignment: .leading)
                    // Colour values get their swatch here too, so a token
                    // file reads the same rendered as it does in the editor.
                    if let color = ColorSwatch.scan(pair.value).first?.color {
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color(nsColor: color))
                                .frame(width: 11, height: 11)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 2)
                                        .stroke(MarvinTheme.border, lineWidth: 0.5)
                                )
                            Text(pair.value)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(MarvinTheme.textPrimary)
                        }
                    } else {
                        Text(pair.value)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(MarvinTheme.textPrimary)
                            .textSelection(.enabled)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .background(MarvinTheme.elevated, in: RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6).stroke(MarvinTheme.border, lineWidth: 1)
        )
    }
}

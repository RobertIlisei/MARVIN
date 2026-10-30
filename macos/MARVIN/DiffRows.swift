// DiffRows — the one vocabulary for drawing a diff line, shared by the Source
// Control diff sheet and Review Changes (critique U16).
//
// They were two renderers: the sheet coloured raw `git diff` text (green and
// red TEXT on a faint wash, so added code was pale green on pale green in
// light), Review Changes washed the row and drew signs. Now both take the same
// washes, signs and type, so a line reads the same wherever it is seen:
//
//   - the row carries a wash of the git colour; the text stays primary, so
//     contrast never depends on a hue;
//   - the +/− sign carries the git colour AND the meaning without it;
//   - the numbers, hunk bars and "no newline" notes look identical.
//
// The colours are `GitDecorationColor`, the adaptive pair that already passes
// 4.5:1 on every light surface (audit L4), not the system red and green.

import MARVINLogic
import SwiftUI

enum DiffStyle {
    static let font = Font.system(size: 11.5, design: .monospaced)
    static let numberFont = Font.system(size: 10, design: .monospaced)

    static var addedWash: Color { GitDecorationColor.added.opacity(0.14) }
    static var removedWash: Color { GitDecorationColor.deleted.opacity(0.14) }
    /// The empty side of a split row: where the other file has a line this one does not.
    static var gapWash: Color { Color.primary.opacity(0.03) }

    static func wash(_ kind: UnifiedDiffLine.Kind) -> Color {
        switch kind {
        case .added: return addedWash
        case .removed: return removedWash
        case .context, .noNewline: return .clear
        }
    }

    static func sign(_ kind: UnifiedDiffLine.Kind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "\u{2212}"
        case .context, .noNewline: return " "
        }
    }

    static func signColor(_ kind: UnifiedDiffLine.Kind) -> Color {
        switch kind {
        case .added: return GitDecorationColor.added
        case .removed: return GitDecorationColor.deleted
        case .context, .noNewline: return .secondary
        }
    }

    static func spoken(_ kind: UnifiedDiffLine.Kind, _ text: String) -> String {
        let body = text.isEmpty ? "blank line" : text
        switch kind {
        case .added: return "added: \(body)"
        case .removed: return "removed: \(body)"
        case .context: return body
        case .noNewline: return "no newline at end of file"
        }
    }
}

/// One line of a unified diff: optional line number, sign, text. Long lines
/// wrap rather than scroll sideways, so the sheet and Review Changes' inline
/// mode behave the same.
struct DiffLineRow: View {
    let kind: UnifiedDiffLine.Kind
    let text: String
    /// nil hides the number gutter (Review Changes' inline lines carry none).
    var number: Int? = nil
    var showsNumbers = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if showsNumbers {
                Text(number.map(String.init) ?? "")
                    .font(DiffStyle.numberFont)
                    .foregroundStyle(.tertiary)
                    .frame(width: 40, alignment: .trailing)
                    .padding(.trailing, 4)
            }
            Text(DiffStyle.sign(kind))
                .font(DiffStyle.font)
                .foregroundStyle(DiffStyle.signColor(kind))
                .frame(width: 14, alignment: .center)
                .accessibilityHidden(true)
            Text(kind == .noNewline ? text : (text.isEmpty ? " " : text))
                .font(kind == .noNewline ? DiffStyle.font.italic() : DiffStyle.font)
                .foregroundStyle(kind == .noNewline ? Color.secondary : Color.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DiffStyle.wash(kind))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(DiffStyle.spoken(kind, text))
    }
}

/// The bar over each hunk: its `@@` header and, where the surface offers any,
/// actions. The sheet passes none.
struct DiffHunkBar<Actions: View>: View {
    let header: String
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: 8) {
            Text(header)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            actions()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(MarvinTheme.background)
    }
}

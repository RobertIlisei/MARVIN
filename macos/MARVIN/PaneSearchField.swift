// PaneSearchField — the one search field of a pane or panel: a magnifier, a
// plain text field, a clear button once there is text, and a focus ring.
//
// Esc clears a search before it does anything else (it closes a window only
// when the field is already empty), the way the search field of every Mac
// list works. The caller owns the focus state so ⌘F can reach it.
//
// Kit addition from the Backlog / Plans pass (25.11.2026): both surfaces
// searched with their own field. The kit's standard can absorb this one.

import SwiftUI

@MainActor struct PaneSearchField: View {
    @Binding var text: String
    var prompt = "Search"
    var width: CGFloat? = 210
    var focus: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10.5))
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 11.5))
                .focused(focus)
                .onKeyPress(.escape) {
                    if text.isEmpty { return .ignored }
                    text = ""
                    return .handled
                }
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
                    .help("Clear search")
                    .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous).fill(MarvinTheme.elevated))
        .overlay(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                .strokeBorder(focus.wrappedValue ? Color.accentColor.opacity(0.6) : MarvinTheme.border, lineWidth: 1)
        )
    }
}

// PaneFilterField — the filter a list-shaped pane puts above its rows.
//
// Added by Source Control (25.11.2026) because a hundred changed files need a
// filter and the kit had none: Plugins used a rounded-border `TextField` inside
// its catalog, Find in Files its own. One shape for a pane's list filter —
// magnifier, plain field, a clear button once there is text, Escape clears,
// the down arrow hands focus to the list below — so the kit agent can fold it
// into the standard. It holds no state of its own beyond focus.

import MARVINLogic
import SwiftUI

@MainActor struct PaneFilterField: View {
    @Binding var text: String
    var prompt: String = "Filter"
    /// How many rows the filter leaves, when it is active — said aloud and shown.
    var matchCount: Int? = nil
    /// ↓ in the field: the caller moves focus into the list.
    var onDown: (() -> Void)? = nil

    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 11.5))
                .focused($focused)
                .onKeyPress(.escape) {
                    guard !text.isEmpty else { return .ignored }
                    text = ""
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    guard let onDown else { return .ignored }
                    onDown()
                    return .handled
                }
                .accessibilityLabel(prompt)
            if !text.isEmpty {
                if let matchCount {
                    Text(PaneBadge.text(matchCount))
                        .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                        .foregroundStyle(MarvinTheme.textMuted)
                }
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .paneIconButton(9)
                    .help("Clear filter (Esc)")
                    .accessibilityLabel("Clear filter")
            }
        }
        .padding(.horizontal, 7)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                .fill(MarvinTheme.elevated)
                .overlay(
                    RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                        .stroke(focused ? Color.accentColor.opacity(0.6) : MarvinTheme.border, lineWidth: 1)
                )
        )
        .padding(.horizontal, 10)
    }
}

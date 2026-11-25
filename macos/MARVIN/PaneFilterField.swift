// PaneFilterField — the search a pane puts directly under its header.
//
// One place, one shape: a 26 pt field with a magnifier, a clear button that
// appears only when there is text, Escape to clear, and an accessible name.
// Before, Plugins had a rounded-border `TextField` at the bottom of its catalog,
// Search had its own, Skills had none, and the 2026-11-24 review asked for it.
//
// The matching rule is `PaneFilter` (MARVINLogic): every word, any field, case
// and accents folded. The field only holds the text.

import MARVINLogic
import SwiftUI

@MainActor struct PaneFilterField: View {
    @Binding var text: String
    /// "Filter skills" — also the VoiceOver name.
    let prompt: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: PaneSpace.compact) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(PaneFont.field)
                .focused($focused)
                .onExitCommand {
                    if PaneFilter.isActive(text) { text = "" } else { focused = false }
                }
                .accessibilityLabel(prompt)
            if !text.isEmpty {
                Button { text = ""; focused = true } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Clear the filter (Esc)")
                .accessibilityLabel("Clear filter")
            }
        }
        .padding(.horizontal, PaneSpace.standard)
        .frame(height: 26)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                .fill(MarvinTheme.rowHover)
        )
        .overlay(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(focused ? 0.7 : 0), lineWidth: 1.5)
        )
        .padding(.horizontal, PaneSpace.gutter)
        .padding(.bottom, PaneSpace.compact)
    }
}

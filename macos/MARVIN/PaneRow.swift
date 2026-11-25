// paneRow — the shape of a row in a left pane (ADR-0114).
//
// A MODIFIER, not a container, and that is the whole design decision. The
// seven panes' rows share a rectangle, a hover, a selection fill and their
// padding — and nothing else. A skill row carries a toggle, a version and a
// contribution list; a git file row carries a status letter and a path; a
// finding row carries a score and eight possible states. A
// `PaneRow(title:subtitle:badge:trailing:)` covering all of them would need
// nine parameters and would still be wrong for the tenth row someone adds.
//
// So the caller builds its own `HStack` and wears this for the parts that are
// genuinely common.

import SwiftUI

/// Whether the list a row sits in has keyboard focus (set by `PaneScrollList`).
/// A selected row in a focused list is drawn with the accent; in an unfocused
/// one it is the quiet grey, exactly as a macOS source list does.
private struct PaneListFocusKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var paneListHasFocus: Bool {
        get { self[PaneListFocusKey.self] }
        set { self[PaneListFocusKey.self] = newValue }
    }
}

@MainActor private struct PaneRowModifier: ViewModifier {
    let selected: Bool
    let hovering: Bool
    @Environment(\.paneListHasFocus) private var listFocused

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, PaneSpace.gutter)
            .padding(.vertical, 3)
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .clipped()
            .background(
                RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                    .fill(selected ? MarvinTheme.rowSelected : (hovering ? MarvinTheme.rowHover : .clear))
            )
            // Keyboard focus is shown, not implied: an inner accent hairline on
            // the selected row while its list owns the keyboard. (The system
            // focus ring is off — it drew a box round the whole pane, twice.)
            .overlay(
                RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(selected && listFocused ? 0.8 : 0), lineWidth: 1.5)
            )
            .contentShape(Rectangle())
    }
}

@MainActor extension View {
    /// Common row padding, hover and selection. Hover is the caller's `@State`
    /// because a row that owns it re-renders its whole list on every pointer
    /// move.
    func paneRow(selected: Bool = false, hovering: Bool = false) -> some View {
        modifier(PaneRowModifier(selected: selected, hovering: hovering))
    }
}

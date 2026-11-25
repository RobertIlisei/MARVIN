// PaneOverflowMenu — the "…" every pane and row uses for everything that is not
// its one visible action.
//
// Before, four shapes of this existed: a 22×22 `Menu` in Skills, a 20×18 one in
// Plugins, a 19×19 one in Practice, and none at all in Sessions. Same glyph,
// four hit targets, no hover in any of them. One shape, 24×24 (the smallest
// target a pointer should be asked to hit), with the platform hover fill.
//
// In a header it sits last, after at most one other action. In a row it sits
// at the far right and rests dimmed until the row is hovered, selected or
// focused, so fifty rows are not fifty bright ellipses (Mail does the same).

import SwiftUI

@MainActor struct PaneOverflowMenu<Content: View>: View {
    /// Read by VoiceOver and shown as the tooltip: "More actions for graphify".
    let label: String
    /// Draw at full strength. A row passes its hover / selection here.
    var emphasised: Bool = true
    @ViewBuilder var content: () -> Content

    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Menu {
            content()
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(MarvinTheme.textMuted)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                        .fill(hovering && isEnabled ? MarvinTheme.rowHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .opacity(emphasised || hovering ? 1 : 0.5)
        .onHover { hovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

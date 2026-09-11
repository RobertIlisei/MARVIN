// PaneSectionHeader — one section header for all seven panes (ADR-0114).
//
// Five private implementations existed: uppercase 9.5pt with a tinted capsule
// (Sessions), `.headline` with a grey capsule (Skills), a chevron with an
// elevated capsule (Source Control), and two more inlined in Plugins and
// Practice. The same idea, five weights, five badge styles.
//
// This is Sessions' shape, which was the most legible of the five: small,
// uppercase, tracked, with the count as a tinted capsule that only appears
// when there is something to count.

import MARVINLogic
import SwiftUI

struct PaneSectionHeader<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    var tint: Color = MarvinTheme.textMuted
    /// Set for a collapsible section; nil draws no chevron.
    var collapsed: Bool? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 6) {
            if let collapsed {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .frame(width: 10)
            }
            Text(title)
                .font(.system(size: 9.5, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.4)
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(1)
            if let count, PaneBadge.shows(count) {
                Text(PaneBadge.text(count))
                    .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(tint.opacity(0.18)))
                    .foregroundStyle(tint)
            }
            Spacer(minLength: 0)
            HStack(spacing: 2) { trailing() }.layoutPriority(1)
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 3)
    }
}

extension PaneSectionHeader where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil, tint: Color = MarvinTheme.textMuted, collapsed: Bool? = nil) {
        self.init(title: title, count: count, tint: tint, collapsed: collapsed, trailing: { EmptyView() })
    }
}

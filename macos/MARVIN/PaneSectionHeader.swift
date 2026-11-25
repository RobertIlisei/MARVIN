// PaneSectionHeader — the group header: one for all panes (ADR-0114, standard
// 2026-11-25).
//
// Five private implementations existed: uppercase 9.5pt with a tinted capsule
// (Sessions), `.headline` with a grey capsule (Skills), a chevron with an
// elevated capsule (Source Control), and two more inlined in Plugins and
// Practice. The same idea, five weights, five badge styles.
//
// A group header is: [disclosure chevron] label [count] ........ [one bulk action].
// 11 pt semibold, in the muted colour, not uppercase — the pane's own title is
// the uppercase line, and two shouting lines in one column fight. The count is
// a tinted capsule that only appears when there is something to count (the tint
// is how a group says "this one needs you": orange for a failure, accent for
// an update).
//
// With `onToggle` the label side is one button: click, Space and Return open
// and close it, VoiceOver reads "Finished, 12 items, collapsed". The trailing
// slot stays OUTSIDE that button so a bulk action is its own target.
//
// `PaneGroup` is the usual way to use this (it also remembers the state).

import MARVINLogic
import SwiftUI

@MainActor struct PaneSectionHeader<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    var tint: Color = MarvinTheme.textMuted
    /// Set for a collapsible section; nil draws no chevron.
    var collapsed: Bool? = nil
    /// Makes the label side a button that opens and closes the group.
    var onToggle: (() -> Void)? = nil
    /// What the group is, for the hover tooltip — where the paragraph under
    /// the header used to be.
    var help: String? = nil
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: some View {
        HStack(spacing: PaneSpace.compact) {
            if let collapsed {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .animation(reduceMotion ? nil : .snappy(duration: 0.14, extraBounce: 0), value: collapsed)
                    .frame(width: 10)
            }
            Text(title)
                .font(PaneFont.group)
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(1)
            if let count, PaneBadge.shows(count) {
                Text(PaneBadge.text(count))
                    .font(PaneFont.count)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(tint.opacity(0.18)))
                    .foregroundStyle(tint)
            }
        }
        .contentShape(Rectangle())
    }

    var body: some View {
        HStack(spacing: PaneSpace.compact) {
            if let onToggle {
                Button(action: onToggle) { label }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(accessibilityTitle)
                    .accessibilityValue((collapsed ?? false) ? "collapsed" : "expanded")
                    .accessibilityHint("Shows or hides the rows in this group")
                    .accessibilityAddTraits(.isHeader)
            } else {
                label.accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            HStack(spacing: PaneSpace.tight) { trailing() }.layoutPriority(1)
        }
        .padding(.horizontal, PaneSpace.gutter)
        .padding(.top, PaneSpace.standard + 2)
        .padding(.bottom, PaneSpace.tight)
        .frame(minHeight: 28, alignment: .bottom)
        .help(help ?? "")
    }

    private var accessibilityTitle: String {
        guard let count, PaneBadge.shows(count) else { return title }
        return "\(title), \(count) item\(count == 1 ? "" : "s")"
    }
}

extension PaneSectionHeader where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil, tint: Color = MarvinTheme.textMuted, collapsed: Bool? = nil,
         onToggle: (() -> Void)? = nil, help: String? = nil) {
        self.init(title: title, count: count, tint: tint, collapsed: collapsed, onToggle: onToggle, help: help,
                  trailing: { EmptyView() })
    }
}

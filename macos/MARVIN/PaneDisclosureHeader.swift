// PaneDisclosureHeader — a group header that folds (pane-standard round,
// 25.11.2026). A kit addition: `PaneSectionHeader` draws a chevron when given
// `collapsed:` but is not a control — no hit target, no keyboard, nothing a
// screen reader can press.
//
// The Mac source-list shape: the chevron, the title and the count are one
// button (the whole line folds the group, not a 10 pt glyph); the count stays
// visible when folded, so a closed "Finished 45" still says what is inside; an
// optional trailing slot carries the group's one bulk action OUTSIDE that
// button, never nested in it.
//
// Keyboard is the owner's, not this view's: a pane that keeps its own focus
// model (Sessions: ↑ ↓ walk headers and rows) passes `focused` to draw the ring
// and handles ← → Space ⏎ itself. A pane without one gets the system's: the
// button is focusable and Space presses it.
//
// Nothing below 11 pt. No view is inserted to measure, no animation on the
// rows: only the chevron turns, and not at all under Reduce Motion (ADR-0062).

import MARVINLogic
import SwiftUI

@MainActor struct PaneDisclosureHeader<Trailing: View>: View {
    let title: String
    let count: Int
    var tint: Color = MarvinTheme.textMuted
    let collapsed: Bool
    /// Draw the keyboard-focus ring (the pane owns the focus model).
    var focused: Bool = false
    let onToggle: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: collapsed)
                        .frame(width: 12)
                    Text(title)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .lineLimit(1)
                    // Always shown, folded or not: the count is what a closed
                    // group still has to say. Zero never reaches here (an
                    // empty group draws no header).
                    Text(PaneBadge.text(count))
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(tint.opacity(0.18)))
                        .foregroundStyle(tint)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(count)")
            .accessibilityValue(collapsed ? "collapsed" : "expanded")
            .accessibilityHint("Shows or hides this group")
            .accessibilityAddTraits(.isHeader)
            .help(collapsed ? "Show \(title.lowercased())" : "Hide \(title.lowercased())")
            HStack(spacing: 4) { trailing() }.layoutPriority(1)
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(hovering ? MarvinTheme.rowSelected.opacity(0.5) : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(focused ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1)
                )
        )
        .onHover { hovering = $0 }
    }
}

extension PaneDisclosureHeader where Trailing == EmptyView {
    init(title: String, count: Int, tint: Color = MarvinTheme.textMuted, collapsed: Bool, focused: Bool = false,
         onToggle: @escaping () -> Void) {
        self.init(title: title, count: count, tint: tint, collapsed: collapsed, focused: focused,
                  onToggle: onToggle, trailing: { EmptyView() })
    }
}

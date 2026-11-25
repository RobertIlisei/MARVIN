// PaneFilterChips — the filters that are narrowing a list, shown where the list
// is, each one removable, with one "Clear filters".
//
// A filter that lives only inside a menu is invisible: the owner's backlog showed
// 251 open items and a person who had hidden Low and Docs a week ago read the
// shorter list as the whole truth. The filter button wears a count (that was
// already so); this strip says WHICH, and takes them off with one click each.
//
// It draws nothing when nothing narrows the list, so an unfiltered pane pays no
// height for it. Wraps rather than scrolls: a left pane or a narrow window must
// not be asked for width (ADR-0114).

import MARVINLogic
import SwiftUI

@MainActor struct PaneFilterChips: View {
    let chips: [BacklogFilterChip]
    let onRemove: (String) -> Void
    let onClearAll: () -> Void

    var body: some View {
        if !chips.isEmpty {
            HStack(alignment: .top, spacing: PaneSpace.compact) {
                WrapLayout(spacing: PaneSpace.tight, lineSpacing: PaneSpace.tight) {
                    ForEach(chips) { chip in
                        Button { onRemove(chip.id) } label: {
                            HStack(spacing: PaneSpace.tight) {
                                Text(chip.label)
                                    .font(PaneFont.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Image(systemName: "xmark")
                                    .font(.system(size: 8, weight: .semibold))
                            }
                            .foregroundStyle(MarvinTheme.textPrimary)
                            .padding(.horizontal, PaneSpace.compact + 2)
                            .padding(.vertical, PaneSpace.hairline + 1)
                            .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .help("Remove the filter “\(chip.label)”")
                        .accessibilityLabel("Filter: \(chip.label)")
                        .accessibilityHint("Removes this filter")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Clear filters", action: onClearAll)
                    .buttonStyle(.plain)
                    .font(PaneFont.secondary)
                    .foregroundStyle(Color.accentColor)
                    .padding(.vertical, PaneSpace.hairline + 1)
                    .help("Remove every filter. The scope and the search text stay.")
                    .accessibilityLabel("Clear filters")
            }
            .padding(.horizontal, PaneSpace.gutter)
            .padding(.vertical, PaneSpace.compact)
        }
    }
}

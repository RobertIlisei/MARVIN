// PaneGroup — a titled, countable, collapsible group of rows, with memory.
//
// The owner's first complaint, in his words: "there is no way to minimise, or
// make those sessions disappear". A group is the answer, and it is the same
// answer in every pane: a header with a disclosure chevron, a count and at most
// one bulk action; click it (or Space / Return when it has focus) and the rows
// go; the choice is remembered per pane and per group.
//
// Rules the kit enforces so no pane has to remember them:
//   - while a filter is active a closed group shows its matches (a search that
//     hides its own results behind a chevron looks broken);
//   - an empty group draws nothing, not a header over nothing (the caller
//     simply does not make one — `InstalledGrouping` drops them);
//   - collapsing is instant, not animated: a height transition inside a mounted
//     pane slot re-lays out the whole sidebar (ADR-0062). Only the chevron turns.

import MARVINLogic
import Observation
import SwiftUI

/// What a pane has closed. One per pane; persisted under
/// `marvin.pane.<pane>.collapsedGroups`.
@MainActor @Observable final class PaneCollapseStore {
    private(set) var state: PaneCollapseState
    @ObservationIgnored private let key: String
    @ObservationIgnored private let defaults: UserDefaults

    init(pane: String, defaults: UserDefaults = .standard) {
        self.key = PaneCollapseState.defaultsKey(pane: pane)
        self.defaults = defaults
        let raw = defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
        self.state = PaneCollapseState(storage: raw)
    }

    func isCollapsed(_ group: String, default d: Bool) -> Bool { state.isCollapsed(group, default: d) }

    func toggle(_ group: String, default d: Bool) {
        state = state.toggled(group, default: d)
        defaults.set(state.storage, forKey: key)
    }
}

@MainActor struct PaneGroup<Content: View, Trailing: View>: View {
    let store: PaneCollapseStore
    /// Stable key — not the title, which may be reworded or localised.
    let id: String
    let title: String
    var count: Int? = nil
    var tint: Color = MarvinTheme.textMuted
    var help: String? = nil
    var startsCollapsed: Bool = false
    /// A filter is active: show the matches whatever the person closed.
    var filterActive: Bool = false
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        let collapsed = store.isCollapsed(id, default: startsCollapsed)
        VStack(alignment: .leading, spacing: 0) {
            PaneSectionHeader(
                title: title, count: count, tint: tint, collapsed: collapsed && !filterActive,
                onToggle: filterActive ? nil : { store.toggle(id, default: startsCollapsed) },
                help: help, trailing: trailing)
            if PaneCollapseState.isShown(collapsed: collapsed, filterActive: filterActive) {
                content()
            }
        }
    }
}

/// One quiet sentence inside a group — what an empty group is for. Not a row:
/// it is not selectable and has no actions. Use `PaneEmptyView` when the whole
/// pane is empty.
@MainActor struct PaneNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(PaneFont.hint)
            .foregroundStyle(MarvinTheme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, PaneSpace.gutter)
            .padding(.vertical, PaneSpace.tight)
    }
}

extension PaneGroup where Trailing == EmptyView {
    init(store: PaneCollapseStore, id: String, title: String, count: Int? = nil, tint: Color = MarvinTheme.textMuted,
         help: String? = nil, startsCollapsed: Bool = false, filterActive: Bool = false,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(store: store, id: id, title: title, count: count, tint: tint, help: help,
                  startsCollapsed: startsCollapsed, filterActive: filterActive,
                  trailing: { EmptyView() }, content: content)
    }
}

// PaneScrollList — the scrolling body of a pane, with the keyboard behaviour
// every list in the app shares.
//
//   Up / Down      move the selection through the visible rows (stops at the ends)
//   Home / End     first / last
//   Return         activate: open the row's detail, run its primary action
//   Space          toggle (the switch, a group's disclosure) — the pane decides
//   Escape         clear the selection
//   letters        type-ahead: jump to the next title that starts with them
//
// The rules (what moves where, the 1 s type-ahead pause) are `PaneKeyNav` and
// `PaneTypeAhead` in MARVINLogic, tested. This is only the wiring.
//
// Focus: the list is focusable so it receives keys, but the SYSTEM focus ring
// is off (`focusEffectDisabled`) — it drew a box round the whole pane, reported
// twice (see PaneHeader). The selected row shows focus itself, through the
// `paneListHasFocus` environment value `paneRow` reads. A click on a row, and
// a change of selection from the keyboard, both give the list focus.

import MARVINLogic
import SwiftUI

@MainActor struct PaneScrollList<Content: View>: View {
    /// The rows in on-screen order: the ids to move through, and the titles
    /// type-ahead matches against. Only the VISIBLE rows (a closed group's rows
    /// are not in the list).
    let rows: [(id: String, title: String)]
    @Binding var selection: String?
    var onActivate: ((String) -> Void)? = nil
    var onSpace: ((String) -> Void)? = nil
    /// Return true if it used the key (cleared a filter); false lets the list
    /// clear its own selection.
    var onEscape: (() -> Bool)? = nil
    @ViewBuilder var content: () -> Content

    @FocusState private var focused: Bool
    @State private var ahead = PaneTypeAhead()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) { content() }
                    .padding(.bottom, PaneSpace.section)
            }
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .environment(\.paneListHasFocus, focused)
            .onKeyPress(phases: [.down, .repeat]) { press in handle(press, proxy: proxy) }
            .onChange(of: selection) { _, new in
                if new != nil { focused = true }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
    }

    private func handle(_ press: KeyPress, proxy: ScrollViewProxy) -> KeyPress.Result {
        // Never swallow a shortcut: ⌘F, ⌘W and the rest belong to the window.
        if press.modifiers.contains(.command) || press.modifiers.contains(.control) { return .ignored }
        func select(_ id: String?) -> KeyPress.Result {
            guard let id else { return .ignored }
            selection = id
            proxy.scrollTo(id)
            return .handled
        }
        let ids = rows.map { $0.id }
        switch press.key {
        case .downArrow: return select(PaneKeyNav.move(.down, from: selection, in: ids))
        case .upArrow: return select(PaneKeyNav.move(.up, from: selection, in: ids))
        case .home: return select(PaneKeyNav.move(.first, from: selection, in: ids))
        case .end: return select(PaneKeyNav.move(.last, from: selection, in: ids))
        case .return:
            guard let sel = selection, let onActivate else { return .ignored }
            onActivate(sel); return .handled
        case .space:
            guard let sel = selection, let onSpace else { return .ignored }
            onSpace(sel); return .handled
        case .escape:
            if onEscape?() == true { return .handled }
            guard selection != nil else { return .ignored }
            selection = nil; return .handled
        default:
            guard press.modifiers.isEmpty || press.modifiers == .shift, press.characters.count == 1,
                  press.characters.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "." }) else { return .ignored }
            guard let hit = ahead.type(press.characters, at: Date(), rows: rows, from: selection) else { return .handled }
            return select(hit)
        }
    }
}

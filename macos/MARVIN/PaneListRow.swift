// PaneListRow — the row anatomy every pane uses (standard 2026-11-25).
//
//   [leading]  Title ..................... trailing state   [action]  […]
//              one secondary line, truncated
//
//   - leading: a glyph (a shape, never colour alone) or the enable switch;
//   - title: one line, the name of the thing, truncated in the middle;
//   - secondary: ONE line. What would be a second and third line is a detail,
//     shown under the row when it is selected (`showsDetail` + `detail`);
//   - trailing: state as TEXT, with a glyph when the state is a warning, so a
//     colour-blind person and VoiceOver both get it;
//   - at most ONE visible action (the first `.primary` item); every other
//     verb is in the "…" menu, which is also the row's context menu, so a
//     right-click and the ellipsis offer exactly the same list.
//
// `PaneRow.swift`'s `paneRow` modifier remains the shared rectangle (padding,
// hover, selection, focus); this view is what goes inside it for the rows that
// fit the anatomy. A row that genuinely does not (a git file with a status
// letter) wears `paneRow` directly. What it may not do is invent a second
// header or a private row builder: `PaneSourceScan` fails the build.

import MARVINLogic
import SwiftUI

/// A verb a row offers. `role == .primary` makes it the visible one (the first
/// such item wins); `.destructive` is never visible and sorts to the end.
struct PaneRowItem: Identifiable {
    let id: String
    let title: String
    var systemImage: String? = nil
    var role: PaneRowAction.Role = .normal
    var enabled: Bool = true
    var help: String? = nil
    let perform: () -> Void

    var action: PaneRowAction { PaneRowAction(id: id, role: role) }
}

/// The leading slot.
enum PaneRowLeading {
    case none
    /// A symbol that says what the row IS. Tinted, but the shape carries it.
    case glyph(String, Color = MarvinTheme.textMuted)
    /// The enable switch (skills, plugins).
    case toggle(isOn: Bool, name: String, help: String?, onToggle: (Bool) -> Void)
}

/// How the one secondary line reads.
enum PaneRowSecondaryStyle { case normal, placeholder, warning, error }

@MainActor struct PaneListRow<Detail: View>: View {
    let rowID: String
    let title: String
    /// A name that is an identifier (skill, plugin, rule id) draws monospaced.
    var titleIsIdentifier: Bool = false
    var leading: PaneRowLeading = .none
    var secondary: String? = nil
    var secondaryStyle: PaneRowSecondaryStyle = .normal
    var trailingText: String? = nil
    /// A glyph before the trailing text — required for warnings and errors.
    var trailingSymbol: String? = nil
    var trailingTint: Color = MarvinTheme.textMuted
    /// Tooltip on the trailing state — where a score or a state word is explained.
    var trailingHelp: String? = nil
    var selected: Bool = false
    /// The row's work is in flight (an update, an install): a spinner takes the
    /// place of its action.
    var busy: Bool = false
    var items: [PaneRowItem] = []
    /// What the "…" menu is called, for VoiceOver and the tooltip.
    var menuLabel: String? = nil
    var onSelect: (() -> Void)? = nil
    var showsDetail: Bool = false
    @ViewBuilder var detail: () -> Detail

    @State private var hovering = false

    private var plan: PaneRowActionPlan { PaneRowActionPlan.plan(items.map { $0.action }) }
    private var visibleItem: PaneRowItem? { plan.visible.flatMap { id in items.first { $0.id == id } } }
    private var menuItems: [PaneRowItem] { plan.menu.compactMap { id in items.first { $0.id == id } } }

    var body: some View {
        VStack(alignment: .leading, spacing: PaneSpace.tight) {
            HStack(alignment: .center, spacing: PaneSpace.standard) {
                leadingView
                textBlock
                if busy {
                    ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 18, height: 18)
                        .accessibilityLabel("Working")
                } else if let item = visibleItem {
                    PaneActionButton(title: item.title, role: .primary, help: item.help, disabled: !item.enabled, action: item.perform)
                }
                if !menuItems.isEmpty {
                    PaneOverflowMenu(label: menuLabel ?? "More actions for \(title)", emphasised: hovering || selected) {
                        menuContent
                    }
                }
            }
            if showsDetail {
                detail()
                    .padding(.leading, detailIndent)
                    .padding(.bottom, PaneSpace.tight)
            }
        }
        .frame(minHeight: PaneSpace.rowMinHeight)
        .paneRow(selected: selected, hovering: hovering)
        .onHover { hovering = $0 }
        .onTapGesture { onSelect?() }
        .contextMenu { menuContent }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .id(rowID)
    }

    // MARK: Pieces

    @ViewBuilder private var leadingView: some View {
        switch leading {
        case .none:
            EmptyView()
        case .glyph(let symbol, let tint):
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 18)
                .accessibilityHidden(true)
        case .toggle(let isOn, let name, let help, let onToggle):
            PaneEnableToggle(isOn: isOn, name: name, help: help, onToggle: onToggle)
        }
    }

    /// Where a detail block starts, so it lines up under the title.
    private var detailIndent: CGFloat {
        switch leading {
        case .none: return 0
        case .glyph: return 26
        case .toggle: return 36
        }
    }

    private var textBlock: some View {
        VStack(alignment: .leading, spacing: 1) {
            // The title is the row's identity, so it keeps its room first. The
            // state text is offered whole, then as its glyph alone: at 260 pt a
            // long name beside "Not loaded" used to squeeze the word to
            // "Not lo…" and keep neither.
            ViewThatFits(in: .horizontal) {
                titleLine(showText: true)
                titleLine(showText: false)
            }
            if let secondary {
                Text(secondary)
                    .font(PaneFont.secondary)
                    .italic(secondaryStyle == .placeholder)
                    .foregroundStyle(secondaryColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func titleLine(showText: Bool) -> some View {
        HStack(spacing: PaneSpace.compact) {
            Text(title)
                .font(titleIsIdentifier ? PaneFont.rowTitleMono : PaneFont.rowTitle)
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            if trailingText != nil || trailingSymbol != nil {
                Spacer(minLength: 0)
                HStack(spacing: 3) {
                    if let trailingSymbol {
                        Image(systemName: trailingSymbol).font(.system(size: 11, weight: .semibold))
                    }
                    if showText, let trailingText {
                        Text(trailingText).font(PaneFont.secondary).lineLimit(1).fixedSize()
                    }
                }
                .foregroundStyle(trailingTint)
                .help(trailingHelp ?? trailingText ?? "")
                .accessibilityLabel(trailingText ?? "")
            }
        }
    }

    private var secondaryColor: Color {
        switch secondaryStyle {
        case .normal, .placeholder: return MarvinTheme.textMuted
        case .warning: return .orange
        case .error: return GitDecorationColor.deleted
        }
    }

    @ViewBuilder private var menuContent: some View {
        let list = menuItems
        let firstDestructive = list.firstIndex { $0.role == .destructive }
        ForEach(Array(list.enumerated()), id: \.element.id) { index, item in
            if index == firstDestructive, index > 0 { Divider() }
            Button(role: item.role == .destructive ? .destructive : nil, action: item.perform) {
                if let img = item.systemImage { Label(item.title, systemImage: img) } else { Text(item.title) }
            }
            .disabled(!item.enabled)
            .help(item.help ?? "")
        }
    }
}

extension PaneListRow where Detail == EmptyView {
    init(rowID: String, title: String, titleIsIdentifier: Bool = false, leading: PaneRowLeading = .none,
         secondary: String? = nil, secondaryStyle: PaneRowSecondaryStyle = .normal,
         trailingText: String? = nil, trailingSymbol: String? = nil, trailingTint: Color = MarvinTheme.textMuted,
         trailingHelp: String? = nil, selected: Bool = false, busy: Bool = false, items: [PaneRowItem] = [], menuLabel: String? = nil,
         onSelect: (() -> Void)? = nil) {
        self.init(rowID: rowID, title: title, titleIsIdentifier: titleIsIdentifier, leading: leading,
                  secondary: secondary, secondaryStyle: secondaryStyle, trailingText: trailingText,
                  trailingSymbol: trailingSymbol, trailingTint: trailingTint, trailingHelp: trailingHelp,
                  selected: selected, busy: busy,
                  items: items, menuLabel: menuLabel, onSelect: onSelect, showsDetail: false, detail: { EmptyView() })
    }
}

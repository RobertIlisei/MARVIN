// SourceControlRows — the rows of the first scope's list: a group header, a
// directory, a file. One view for the three, because they share the anatomy the
// pane standard asks of every row — a title line, trailing state, at most ONE
// visible action (stage, or unstage, never both and never a destructive one),
// the rest in a menu — and differ only in what they print.
//
// Discard is never beside stage. It is in the row's menu, in the destructive
// role, and its confirmation names the tree (`SourceControlConfirmText`).
//
// The list is one focus target, not a hundred: arrow keys move `selection`
// (`ChangeTree.move`), so Tab leaves the list in one press. The rows are plain
// views with a hover; keyboard users see the same actions on the selected row.

import AppKit
import MARVINLogic
import SwiftUI

struct ChangeRowHandlers {
    var toggle: (ChangeTreeRow) -> Void
    var select: (ChangeTreeRow) -> Void
    var open: (ChangeItem) -> Void
    var stage: (ChangeTreeRow) -> Void
    var unstage: (ChangeTreeRow) -> Void
    var discard: (ChangeTreeRow) -> Void
    var reveal: (ChangeItem) -> Void
}

@MainActor struct SourceControlChangeRow: View {
    let row: ChangeTreeRow
    let selected: Bool
    let busy: Bool
    let handlers: ChangeRowHandlers

    @State private var hovering = false

    private static let rowHeight: CGFloat = 22
    private var showActions: Bool { hovering || selected }

    var body: some View {
        Group {
            switch row.kind {
            case .group: groupRow
            case .directory: directoryRow
            case .file: fileRow
            }
        }
        .frame(height: row.kind == .group ? nil : Self.rowHeight)
        .background(
            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                .fill(selected ? MarvinTheme.rowSelected : (hovering ? MarvinTheme.rowHover : .clear))
                .padding(.horizontal, 4)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { handlers.select(row) }
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            if let item = row.item { handlers.open(item) }
        })
        .contextMenu { menu }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default) { activate() }
        .accessibilityIdentifier("scm-row:\(row.id)")
    }

    private func activate() {
        if row.kind == .file, let item = row.item { handlers.open(item) } else { handlers.toggle(row) }
    }

    private var accessibilityLabel: String {
        switch row.kind {
        case .group: return "\(row.name), \(row.count) files, \(row.collapsed ? "collapsed" : "expanded")"
        case .directory: return "\(row.name), folder, \(row.count) files, \(row.collapsed ? "collapsed" : "expanded")"
        case .file: return "\(row.name), \(badge.tooltip)"
        }
    }

    // MARK: Group header

    private var groupRow: some View {
        PaneSectionHeader(
            title: row.name, count: row.count,
            tint: row.group == .conflicts ? GitDecorationColor.deleted : MarvinTheme.textMuted,
            collapsed: row.collapsed
        ) {
            if busy {
                ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 14, height: 14)
            } else if showActions {
                actions
            }
        }
        .padding(.top, -2)
    }

    // MARK: Directory

    private var directoryRow: some View {
        HStack(spacing: 5) {
            Image(systemName: row.collapsed ? "chevron.right" : "chevron.down")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.tertiary)
                .frame(width: 10)
            Image(systemName: "folder")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 14)
            Text(row.name)
                .font(.system(size: 12))
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            if busy {
                ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 14, height: 14)
            } else if showActions {
                actions
            }
            Text(PaneBadge.text(row.count))
                .font(.system(size: 10, weight: .medium).monospacedDigit())
                .foregroundStyle(MarvinTheme.textMuted)
                .frame(minWidth: 16, alignment: .trailing)
        }
        .padding(.leading, indent)
        .padding(.trailing, 10)
        .help(row.path)
    }

    // MARK: File

    private var fileRow: some View {
        HStack(spacing: 6) {
            icon
            Text(row.name)
                .font(.system(size: 12))
                .foregroundStyle(nameColor)
                .lineLimit(1)
                .truncationMode(.middle)
                .strikethrough(badge == .deleted, color: nameColor)
            Spacer(minLength: 4)
            if busy {
                ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 14, height: 14)
            } else if showActions {
                actions
            }
            Text(badge.label)
                .font(.system(size: 11, weight: .semibold).monospaced())
                .foregroundStyle(badge.colour)
                .frame(width: 12)
        }
        .padding(.leading, indent + 15)
        .padding(.trailing, 10)
        .help(helpText)
    }

    private var helpText: String {
        if let from = row.item?.renamedFrom { return "\(row.path)\nrenamed from \(from)" }
        return row.path
    }

    private var indent: CGFloat { 10 + CGFloat(max(0, row.depth - 1)) * 12 }

    @ViewBuilder
    private var icon: some View {
        if let glyph = SymbolsIcon.image(forPath: row.path, isDirectory: false, size: 15) {
            Image(nsImage: glyph).frame(width: 16)
        } else {
            Image(systemName: "doc").font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 16)
        }
    }

    private var badge: GitStatusBadge {
        guard let item = row.item else { return .other }
        if item.group == .untracked { return .untracked }
        if item.group == .conflicts { return .conflicted }
        return GitStatusBadge.category(forCode: item.code)
    }

    private var nameColor: Color { badge == .deleted ? .secondary : badge.colour }

    // MARK: The one visible action, and the menu

    private var canStage: Bool { row.group == .changes || row.group == .untracked }

    /// What the row's one visible action is for this group: stage, unstage, or none.
    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 0) {
            if row.group == .staged {
                Button { handlers.unstage(row) } label: { Image(systemName: "minus") }
                    .paneIconButton(9)
                    .help(row.kind == .file ? "Unstage" : "Unstage \(row.count) files")
                    .accessibilityLabel("Unstage")
            } else if canStage {
                Button { handlers.stage(row) } label: { Image(systemName: "plus") }
                    .paneIconButton(9)
                    .help(row.kind == .file ? "Stage" : "Stage \(row.count) files")
                    .accessibilityLabel("Stage")
            }
            Menu { menu } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 22, height: 22)
                .foregroundStyle(MarvinTheme.textMuted)
                .accessibilityLabel("More actions")
        }
    }

    @ViewBuilder
    private var menu: some View {
        if let item = row.item {
            Button("Open Diff") { handlers.open(item) }
            Button("Reveal in Finder") { handlers.reveal(item) }
            Button("Copy Path") { copy(item.path) }
        } else if row.kind == .directory {
            Button(row.collapsed ? "Expand" : "Collapse") { handlers.toggle(row) }
            Button("Copy Path") { copy(row.path) }
        } else {
            Button(row.collapsed ? "Expand" : "Collapse") { handlers.toggle(row) }
        }
        if row.group == .staged {
            Divider()
            Button(row.kind == .file ? "Unstage" : "Unstage \(row.count) Files") { handlers.unstage(row) }
        } else if canStage {
            Divider()
            Button(row.kind == .file ? "Stage" : "Stage \(row.count) Files") { handlers.stage(row) }
            // Last, apart, and confirmed with the tree named.
            Divider()
            if row.group == .untracked {
                Button(row.kind == .file ? "Delete File…" : "Delete \(row.count) Untracked Files…", role: .destructive) { handlers.discard(row) }
            } else {
                Button(row.kind == .file ? "Discard Changes…" : "Discard \(row.count) Files…", role: .destructive) { handlers.discard(row) }
            }
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

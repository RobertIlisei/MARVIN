// SourceControlChangesView — the first scope: ONE working tree.
//
//   Viewing: B54 security · marvin/tab/b54 · .marvin/worktrees/tab-b54   [pin]
//   ⎇ marvin/tab/b54 ↑2                                          ⟳
//   [ Message (⌘⏎ to commit on "…")                       ✨ Generate ]
//   [ ✓ Commit 3                                                    ▾ ]
//   ⌕ Filter
//   ▾ STAGED 3
//   ▾ CHANGES 97
//      ▸ 📁 Sources/App/Services                                  12
//   ▸ UNTRACKED 4
//   ── preview of the selected file ──
//   ▸ HISTORY
//
// Everything here reads and writes `target.path` and nothing else; the
// project-level work is the other scope. A hundred files read as a tree with
// counts and closed folders, a filter, and the keyboard (↑↓ move, ←→ fold,
// ⏎ opens the diff, Space stages). The selected file's diff is a lazy preview,
// not a sheet that blocks.

import AppKit
import MARVINLogic
import SwiftUI

@MainActor struct SourceControlChangesView: View {
    let model: SourceControlModel
    let graphModel: GitGraphModel
    let preview: SourceControlPreviewModel
    let target: SourceControlTarget
    @Binding var pin: SourceControlPin
    @Binding var collapsed: Set<String>
    @Binding var folderOverrides: [String: Bool]
    @Binding var filter: String
    @Binding var selection: String?
    let openDiff: (ChangeItem) -> Void
    let pickBranch: () -> Void
    let toggleCollapsed: (String) -> Void

    @FocusState private var listFocused: Bool
    @FocusState private var composerFocused: Bool
    private let graphHeight: CGFloat = 200

    // MARK: Rows

    private var collapsedGroups: Set<String> {
        Set(ChangeGroup.allCases.map(\.rawValue).filter { collapsed.contains("group.\($0)") })
    }

    private var rows: [ChangeTreeRow] {
        ChangeTree.flatten(
            groups: ChangeGroup.allCases.map { ($0, model.items($0)) },
            filter: filter, collapsedGroups: collapsedGroups, overrides: folderOverrides)
    }

    private var matchCount: Int {
        ChangeGroup.allCases.reduce(0) { $0 + ChangeTree.filter(model.items($1), query: filter).count }
    }

    private var isFiltering: Bool { !filter.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            viewingStrip
            noticeStrip
            if model.response?.enabled == true, model.response?.error?.isEmpty != false {
                branchRow
            }
            state
        }
        .onChange(of: selection) { _, id in showPreview(for: id) }
        .onChange(of: model.groups) { _, _ in refreshSelection() }
    }

    // MARK: Which tree

    private var viewingStrip: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: target.kind == .tab ? "square.stack.3d.up" : "folder")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(target.differsFromTab ? Color.orange : MarvinTheme.textMuted)
                .frame(width: 12)
                .padding(.top, 1)
            Text(target.viewingLine)
                .font(.system(size: 10.5))
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(3)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(target.path)
            if target.canPin {
                Button { pin = target.isPinned ? .followTab : .project } label: {
                    Image(systemName: target.isPinned ? "pin.fill" : "pin")
                }
                .paneIconButton(10)
                .help(target.isPinned
                    ? "Following is off. Go back to the selected tab's own tree."
                    : "Pin this view to the project checkout, whichever tab is selected.")
                .accessibilityLabel(target.isPinned ? "Follow the selected tab" : "Pin to the project checkout")
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var noticeStrip: some View {
        if let note = target.notice {
            PaneNoticeStrip(
                notice: PaneNotice(kind: .warning, text: note),
                actionTitle: "Follow tab",
                onAction: target.isPinned ? { pin = .followTab } : nil)
                .padding(.bottom, 4)
        }
    }

    // MARK: Branch

    private var branchRow: some View {
        HStack(spacing: 6) {
            branchChip
            Spacer(minLength: 4)
            Button { model.sync() } label: { Image(systemName: "arrow.triangle.2.circlepath") }
                .paneIconButton(10)
                .disabled(!model.hasUpstream || model.runner.isBusy)
                .help(syncHelp)
                .accessibilityLabel(syncHelp)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private var syncHelp: String {
        guard model.hasUpstream else { return "No upstream — publish the branch first" }
        if !model.isDiverged { return "Sync — up to date with \(model.branch?.upstream ?? "upstream")" }
        return "Sync — pull \(model.behind) and push \(model.ahead)"
    }

    private var branchChip: some View {
        Button(action: pickBranch) {
            HStack(spacing: 3) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9))
                Text(model.branchName)
                    .font(.system(size: 10.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if model.isDiverged {
                    Text(divergenceLabel).font(.system(size: 9).monospaced())
                }
                Image(systemName: "chevron.down").font(.system(size: 7))
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(MarvinTheme.elevated))
        }
        .buttonStyle(.plain)
        .help("Checkout, create or delete a branch \(target.actionPhrase)")
    }

    private var divergenceLabel: String {
        var parts: [String] = []
        if model.behind > 0 { parts.append("\(model.behind)↓") }
        if model.ahead > 0 { parts.append("\(model.ahead)↑") }
        return parts.joined(separator: " ")
    }

    // MARK: States

    @ViewBuilder
    private var state: some View {
        if let response = model.response {
            if response.enabled == false {
                // Three parenthesised lowercase fragments, one of which meant "still
                // trying" and read like a failure (ADR-0114).
                if response.reason == "not-a-git-repo" {
                    PaneEmptyView(state: .notARepo())
                } else if response.reason == "probe-failed" {
                    PaneLoadingView(label: "Git is busy — retrying…")
                } else {
                    PaneEmptyView(
                        state: PaneEmptyState(headline: "Git is unavailable here", hint: "MARVIN could not run git in this folder.", symbol: "exclamationmark.triangle"),
                        actionTitle: "Try again",
                        action: { model.refresh(cwd: target.path, force: true) })
                }
            } else if let error = response.error, !error.isEmpty {
                PaneEmptyView(
                    state: PaneEmptyState(headline: "Git reported an error", hint: error, symbol: "exclamationmark.triangle"),
                    actionTitle: "Try again",
                    action: { model.refresh(cwd: target.path, force: true) })
            } else if model.isClean {
                clean
            } else {
                if model.conflictCount > 0 {
                    PaneNoticeStrip(notice: PaneNotice(
                        kind: .warning,
                        headline: "\(model.conflictCount) file\(model.conflictCount == 1 ? " has" : "s have") merge conflicts",
                        detail: "Resolve them, then stage them, before committing."))
                        .padding(.bottom, 4)
                }
                composer
                filterField
                list
                previewPanel
                history
            }
        } else if model.lastError != nil && !model.isLoading {
            // The fetch failed and nothing is retrying — the banner says why. A
            // pulsing skeleton here would claim it is still loading.
            EmptyView()
        } else {
            // First status fetch in flight: the shape of the file list, not a
            // spinner on an empty pane.
            SkeletonRows(count: 5, detailLines: 0)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
    }

    private var clean: some View {
        ScrollView {
            VStack(spacing: 0) {
                PaneEmptyView(state: PaneEmptyState(
                    headline: "Working tree clean",
                    hint: "Nothing to commit \(target.actionPhrase).",
                    symbol: "checkmark.circle"))
                if model.isDiverged || !model.hasUpstream {
                    primaryAction.padding(.horizontal, 10)
                }
                if !model.stashes.isEmpty { stashes }
                history
            }
        }
    }

    // MARK: Filter + list

    private var filterField: some View {
        PaneFilterField(
            text: $filter,
            prompt: "Filter \(model.totalFiles) files",
            matchCount: isFiltering ? matchCount : nil,
            onDown: { listFocused = true; if selection == nil { selection = rows.first?.id } })
            .padding(.bottom, 4)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let all = rows
                    if all.isEmpty {
                        PaneEmptyView(
                            state: PaneEmptyState(headline: "No changed file matches “\(filter)”", symbol: "magnifyingglass"),
                            actionTitle: "Clear filter", action: { filter = "" })
                    }
                    ForEach(all) { row in
                        SourceControlChangeRow(
                            row: row, selected: selection == row.id, busy: busy(row), handlers: handlers)
                            .id(row.id)
                    }
                    if !model.stashes.isEmpty && !isFiltering { stashes }
                }
                .padding(.bottom, 8)
            }
            .frame(maxHeight: .infinity)
            .focusable()
            .focused($listFocused)
            .focusEffectDisabled()
            .onKeyPress(.upArrow) { apply(.up, proxy); return .handled }
            .onKeyPress(.downArrow) { apply(.down, proxy); return .handled }
            .onKeyPress(.leftArrow) { apply(.left, proxy); return .handled }
            .onKeyPress(.rightArrow) { apply(.right, proxy); return .handled }
            .onKeyPress(.home) { apply(.home, proxy); return .handled }
            .onKeyPress(.end) { apply(.end, proxy); return .handled }
            .onKeyPress(.return) { activateSelection() }
            .onKeyPress(.space) { toggleStageOfSelection() }
        }
    }

    private func apply(_ key: ChangeTreeKey, _ proxy: ScrollViewProxy) {
        let current = rows
        switch ChangeTree.move(key, from: selection, rows: current) {
        case .select(let id):
            selection = id
            proxy.scrollTo(id)
        case .toggle(let id, _):
            if let row = current.first(where: { $0.id == id }) { toggle(row) }
        case .none:
            break
        }
    }

    private func selectedRow() -> ChangeTreeRow? {
        guard let id = selection else { return nil }
        return rows.first { $0.id == id }
    }

    private func activateSelection() -> KeyPress.Result {
        guard let row = selectedRow() else { return .ignored }
        if let item = row.item { openDiff(item) } else { toggle(row) }
        return .handled
    }

    private func toggleStageOfSelection() -> KeyPress.Result {
        guard let row = selectedRow(), row.group != .conflicts else { return .ignored }
        if row.group == .staged { handlers.unstage(row) } else { handlers.stage(row) }
        return .handled
    }

    private func toggle(_ row: ChangeTreeRow) {
        switch row.kind {
        case .group: toggleCollapsed("group.\(row.group.rawValue)")
        case .directory: folderOverrides[row.id] = !row.collapsed
        case .file: break
        }
    }

    private var handlers: ChangeRowHandlers {
        ChangeRowHandlers(
            toggle: { toggle($0) },
            select: { row in
                selection = row.id
                listFocused = true
                if row.kind != .file { toggle(row) }
            },
            open: { openDiff($0) },
            stage: { model.stage(paths(for: $0)) },
            unstage: { model.unstage(paths(for: $0)) },
            discard: { model.discard(paths(for: $0), untracked: $0.group == .untracked) },
            reveal: { item in
                NSWorkspace.shared.selectFile(
                    (target.path as NSString).appendingPathComponent(item.path), inFileViewerRootedAtPath: target.path)
            })
    }

    /// The files an act on a row covers: the file, a directory's subtree, a whole group.
    private func paths(for row: ChangeTreeRow) -> [String] {
        let items = model.items(row.group)
        switch row.kind {
        case .file: return [row.path]
        case .directory: return ChangeTree.paths(under: row.path, in: items)
        case .group: return items.map(\.path)
        }
    }

    private func busy(_ row: ChangeTreeRow) -> Bool {
        let verbs = ["stage", "unstage", "discard"]
        if row.kind == .file { return verbs.contains { model.runner.isRunning("\($0):\(row.path)") } }
        return verbs.contains { model.runner.isRunning("\($0):*") }
    }

    // MARK: Preview

    private func showPreview(for id: String?) {
        guard let id, let row = rows.first(where: { $0.id == id }), let item = row.item else {
            preview.clear()
            return
        }
        preview.show(cwd: target.path, item: item)
    }

    /// The status moved (a stage, a commit, a turn wrote files): keep the selection
    /// if the row is still there, and reload its diff; drop it if not.
    private func refreshSelection() {
        guard let id = selection else { return }
        if let row = rows.first(where: { $0.id == id }), let item = row.item {
            preview.show(cwd: target.path, item: item, force: true)
        } else if !rows.contains(where: { $0.id == id }) {
            selection = nil
            preview.clear()
        }
    }

    @ViewBuilder
    private var previewPanel: some View {
        if let item = preview.item, selection == "\(item.group.rawValue)|f|\(item.path)" {
            SourceControlPreviewView(
                model: preview, name: item.path,
                onOpen: { openDiff(item) },
                onClose: { selection = nil })
        }
    }

    // MARK: Stashes + history

    private var stashes: some View {
        VStack(alignment: .leading, spacing: 0) {
            groupHeader("Stashes", count: model.stashes.count, id: "section.stashes")
            if !collapsed.contains("section.stashes") {
                ForEach(model.stashes) { entry in
                    HStack(spacing: 6) {
                        Text(entry.message)
                            .font(.system(size: 11.5))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(MarvinTheme.textPrimary)
                        Spacer(minLength: 4)
                        Text(entry.relativeDate)
                            .font(.system(size: 9.5))
                            .foregroundStyle(.tertiary)
                    }
                    .paneRow()
                    .padding(.leading, 6)
                    .contextMenu {
                        Button("Pop") { model.stashAction("pop", index: entry.index) }
                        Button("Apply") { model.stashAction("apply", index: entry.index) }
                        Divider()
                        Button("Drop…", role: .destructive) { model.stashAction("drop", index: entry.index) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var history: some View {
        VStack(spacing: 0) {
            MarvinDivider()
            groupHeader("History", count: nil, id: "section.history") {
                Button { graphModel.refresh(cwd: target.path, force: true) } label: { Image(systemName: "arrow.clockwise") }
                    .paneIconButton(9)
                    .help("Refresh history")
                    .accessibilityLabel("Refresh history")
            }
            if !collapsed.contains("section.history") {
                GitGraphView(cwd: target.path, model: graphModel)
                    .frame(height: graphHeight)
            }
        }
    }

    private func groupHeader(_ title: String, count: Int?, id: String) -> some View {
        groupHeader(title, count: count, id: id) { EmptyView() }
    }

    private func groupHeader<T: View>(_ title: String, count: Int?, id: String, @ViewBuilder trailing: () -> T) -> some View {
        let actions = trailing()
        return Button { toggleCollapsed(id) } label: {
            PaneSectionHeader(title: title, count: count, collapsed: collapsed.contains(id)) { actions }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                TextField(
                    "Message (⌘⏎ to commit on \"\(model.branchName)\")",
                    text: Bindable(model).commitMessage,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...6)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .padding(.trailing, 74)
                .focused($composerFocused)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(MarvinTheme.elevated)
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(MarvinTheme.border, lineWidth: 1))
                )
                .onSubmit { if model.canCommit { model.commit() } }

                generateButton
                    .padding(.top, 4)
                    .padding(.trailing, 4)
            }
            primaryAction
            if let err = model.generateError {
                Text(err)
                    .font(.system(size: 10))
                    .foregroundStyle(GitDecorationColor.modified)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }

    private var generateButton: some View {
        Button { model.generateCommitMessage() } label: {
            HStack(spacing: 3) {
                if model.isGenerating {
                    ProgressView().controlSize(.small).scaleEffect(0.55)
                } else {
                    Image(systemName: "sparkles").font(.system(size: 9))
                }
                Text("Generate").lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
        }
        .rowChip(.primary)
        .disabled(model.isGenerating || model.stagedCount == 0)
        .help(model.stagedCount == 0 ? "Stage something to draft a message from" : "Draft a commit message from the staged diff")
    }

    /// One primary button whose identity depends on state — Commit when there is
    /// something to commit, Sync when there is not and the branch has diverged.
    @ViewBuilder
    private var primaryAction: some View {
        if model.stagedCount == 0 && model.isDiverged {
            wideButton("Sync Changes \(divergenceLabel)", symbol: "arrow.triangle.2.circlepath") { model.sync() }
        } else if !model.hasUpstream && model.isClean {
            wideButton("Publish Branch", symbol: "arrow.up.to.line") { model.publish() }
        } else {
            HStack(spacing: 1) {
                Button { model.commit() } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 10))
                        Text(commitLabel).font(.system(size: 12, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.borderedProminent)
                // ⌘⏎ only while the message box has focus, which is what the
                // placeholder promises and what VS Code does. Declared
                // unconditionally it is a GLOBAL key equivalent while this pane is
                // visible — so ⌘⏎ aimed at the chat composer could commit instead.
                .modifier(CommitReturnShortcut(enabled: composerFocused))
                .disabled(!model.canCommit)
                .help("Commit \(target.actionPhrase)")

                Menu {
                    Button("Commit & Push") { model.commit(then: .push) }.disabled(!model.canCommit)
                    Button("Commit & Sync") { model.commit(then: .sync) }.disabled(!model.canCommit || !model.hasUpstream)
                    Divider()
                    Button("Stage All & Commit") { model.stageAllAndCommit() }
                    Button("Commit (Amend)") { model.commit(amend: true) }.disabled(!model.canAmend)
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 22)
                .padding(.vertical, 5)
                // Follows the Commit button beside it: with nothing to commit the
                // button reads disabled, and a saturated chevron next to it was
                // the only live-looking control in the pane (U15).
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(model.canCommit ? Color.accentColor.opacity(0.85) : Color.primary.opacity(0.08))
                )
                .foregroundStyle(model.canCommit ? Color.white : Color.secondary)
                .help("Commit variants")
            }
        }
    }

    private func wideButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10))
                Text(title).font(.system(size: 12, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.runner.isBusy)
    }

    private var commitLabel: String {
        if model.runner.isRunning("commit") { return "Committing…" }
        if model.stagedCount == 0 { return "Commit" }
        return "Commit \(model.stagedCount)"
    }
}

/// Applies ⌘⏎ only while `enabled`. SwiftUI has no conditional `.keyboardShortcut`,
/// and passing `nil` is not available on the deployment target, so the branch is
/// on the view itself.
@MainActor private struct CommitReturnShortcut: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.keyboardShortcut(.return, modifiers: [.command])
        } else {
            content
        }
    }
}

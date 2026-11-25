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
    /// The height of the band under the composer, measured (never a fixed number):
    /// the list, the preview and the history share it by `PaneBandPlan`.
    @State private var bandHeight: CGFloat = 0

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
                .font(PaneFont.secondary)
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help("\(target.viewingLine)\n\(target.path)")
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
                band(sections: dirtySections) { heights in
                    list.frame(height: heights["list"] ?? 0)
                    previewPanel(bodyHeight: heights["preview"] ?? 0)
                    history(bodyHeight: heights["history"] ?? 0)
                }
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

    /// A clean tree is one line, not a poster: the History under it is what a person
    /// came for, and it takes every point the line and the button leave.
    private var clean: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: PaneSpace.compact) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: PaneSpace.hairline) {
                    Text("Working tree clean")
                        .font(PaneFont.emptyHeadline)
                        .foregroundStyle(MarvinTheme.textMuted)
                    Text("Nothing to commit \(target.actionPhrase).")
                        .font(PaneFont.hint)
                        .foregroundStyle(MarvinTheme.textMuted)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, PaneSpace.gutter)
            .padding(.vertical, PaneSpace.standard)
            .accessibilityElement(children: .combine)
            if model.isDiverged || !model.hasUpstream {
                primaryAction
                    .padding(.horizontal, PaneSpace.gutter)
                    .padding(.bottom, PaneSpace.compact)
            }
            band(sections: cleanSections) { heights in
                if !model.stashes.isEmpty { stashes(bodyHeight: heights["stashes"] ?? 0) }
                history(bodyHeight: heights["history"] ?? 0)
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
                    if !model.stashes.isEmpty && !isFiltering { stashes(bodyHeight: nil) }
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
        // A group header folds on Space; staging a whole group is a deliberate click on its button.
        guard let row = selectedRow(), row.group != .conflicts else { return .ignored }
        if row.kind == .group { toggle(row); return .handled }
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
    private func previewPanel(bodyHeight: CGFloat) -> some View {
        if let item = preview.item, selection == "\(item.group.rawValue)|f|\(item.path)" {
            SourceControlPreviewView(
                model: preview, name: item.path, maxBodyHeight: bodyHeight,
                onOpen: { openDiff(item) },
                onClose: { selection = nil })
            .frame(height: Self.previewChrome + bodyHeight, alignment: .top)
        }
    }

    // MARK: The band: list, preview, stashes, history

    private static let rowHeight: CGFloat = 22
    private static let groupRowHeight: CGFloat = 26
    private static let stashRowHeight: CGFloat = 26
    private static let graphRowHeight: CGFloat = 24
    private static let headerHeight: CGFloat = 30
    private static let previewBodyMax: CGFloat = 150
    private static let previewChrome: CGFloat = 27

    private var historyOpen: Bool { !collapsed.contains("section.history") }
    private var stashesOpen: Bool { !collapsed.contains("section.stashes") }

    private var historyNatural: Double {
        graphModel.rows.isEmpty ? 40 : Double(graphModel.rows.count) * Double(Self.graphRowHeight)
    }

    private var historySection: PaneBandSection {
        PaneBandSection(
            id: "history", chrome: Double(Self.headerHeight), isOpen: historyOpen,
            natural: historyNatural, minimum: min(historyNatural, 5 * Double(Self.graphRowHeight)))
    }

    /// The change list, the preview of the selected file, and History. The list is weighted
    /// 2:1 over History; the preview never grows past its diff; the last open one that can
    /// grow takes what is left, so there is no empty grey under it.
    private var dirtySections: [PaneBandSection] {
        let stashNatural = model.stashes.isEmpty || isFiltering ? 0
            : Double(Self.headerHeight) + (stashesOpen ? Double(model.stashes.count) * Double(Self.stashRowHeight) : 0)
        let listNatural = rows.reduce(0.0) { $0 + ($1.kind == .group ? Double(Self.groupRowHeight) : Double(Self.rowHeight)) }
            + stashNatural + 8
        var out = [PaneBandSection(id: "list", chrome: 0, isOpen: true, natural: listNatural,
                                   minimum: min(listNatural, 4 * Double(Self.rowHeight)), weight: 2)]
        if let item = preview.item, selection == "\(item.group.rawValue)|f|\(item.path)" {
            var ready = false
            if case .ready = preview.state { ready = true }
            out.append(PaneBandSection(
                id: "preview", chrome: Double(Self.previewChrome), isOpen: true,
                natural: ready ? Double(Self.previewBodyMax) : 34, minimum: ready ? 60 : 34, grows: false))
        }
        out.append(historySection)
        return out
    }

    private var cleanSections: [PaneBandSection] {
        var out: [PaneBandSection] = []
        if !model.stashes.isEmpty {
            let natural = Double(model.stashes.count) * Double(Self.stashRowHeight)
            out.append(PaneBandSection(
                id: "stashes", chrome: Double(Self.headerHeight) - 2, isOpen: stashesOpen,
                natural: natural, minimum: min(natural, 2 * Double(Self.stashRowHeight)), grows: false))
        }
        out.append(historySection)
        return out
    }

    /// The region under the composer. It is a clear rectangle that takes the pane's
    /// remaining height, measured with `onGeometryChange` (a `GeometryReader` in the
    /// background adds views and trips AppKit's constraint-pass breaker, ADR-0062); the
    /// sections are drawn in an overlay, so what they ask for never feeds back into the
    /// measurement. Heights are NOT animated: a collapse is instant.
    private func band<Content: View>(
        sections: [PaneBandSection], @ViewBuilder content: @escaping ([String: CGFloat]) -> Content
    ) -> some View {
        let plan = PaneBandPlan.contentHeights(available: Double(bandHeight), sections: sections)
        let heights = plan.mapValues { CGFloat($0) }
        return Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { bandHeight = $0 }
            .overlay(alignment: .top) {
                VStack(spacing: 0) { content(heights) }
                    .frame(maxWidth: .infinity, alignment: .top)
                    .transaction { $0.animation = nil }
            }
            .clipped()
    }

    @ViewBuilder
    private func stashes(bodyHeight: CGFloat?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            groupHeader("Stashes", count: model.stashes.count, id: "section.stashes")
            if stashesOpen {
                if let bodyHeight {
                    ScrollView { stashRows }.frame(height: bodyHeight)
                } else {
                    stashRows
                }
            }
        }
    }

    private var stashRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.stashes) { entry in
                HStack(spacing: 6) {
                    Text(entry.message)
                        .font(PaneFont.rowTitle)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(MarvinTheme.textPrimary)
                    Spacer(minLength: 4)
                    Text(entry.relativeDate)
                        .font(PaneFont.secondary)
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

    @ViewBuilder
    private func history(bodyHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            MarvinDivider()
            groupHeader("History", count: nil, id: "section.history") {
                Button { graphModel.refresh(cwd: target.path, force: true) } label: { Image(systemName: "arrow.clockwise") }
                    .paneIconButton(9)
                    .help("Refresh history")
                    .accessibilityLabel("Refresh history")
            }
            if historyOpen {
                GitGraphView(cwd: target.path, model: graphModel)
                    .frame(height: bodyHeight, alignment: .top)
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

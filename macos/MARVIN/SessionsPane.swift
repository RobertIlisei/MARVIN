// SessionsPane — every session of the project at a glance (ADR-0107).
//
// A left-pane tab, the same shape as PracticePane (a ScrollView root with a
// LazyVStack — ADR-0062: nothing here inserts measurement views or nested
// split views). It is an OBSERVER over `SessionRegistry`: rows come from the
// ledger the project feed maintains, and every action goes back through the
// registry or the bridge's one-shot tab request. One transcript stays on
// screen; this pane tells you which one deserves it next.
//
// Groups follow attention: Needs you, Working, Waiting, Finished, Ready to
// integrate, Idle (collapsing after a timeout, like Claude Code's agent panel),
// History. Every group folds from a disclosure header that keeps its count
// visible, the fold is remembered per project, and the keyboard walks headers
// and rows together (left/right fold, Space and Return on a header, up/down
// move). Finished is quiet by default: five rows, "Show all", one bulk "Mark
// all reviewed" with an Undo (`FinishedPolicy`, `ReviewMarks`).

import AppKit
import MARVINLogic
import SwiftUI

@MainActor struct SessionsPane: View {
    @Environment(MarvinBridge.self) private var bridge
    private let registry = SessionRegistry.shared
    /// ADR-0127 M6 — the supervisor's state; `fixture` lets the snapshot
    /// harness mount the pane with a model it filled itself.
    var supervisor: SupervisorModel = .shared
    @State private var expandedIdle = false
    /// "Show all N" in Finished. Per launch: the quiet view is the default one.
    @State private var showAllFinished: Bool

    init(supervisor: SupervisorModel? = nil, showAllFinished: Bool = false) {
        self.supervisor = supervisor ?? .shared
        _showAllFinished = State(initialValue: showAllFinished)
    }
    @Namespace private var escalationRotor
    /// ADR-0112 — keyboard focus in the list: ↑ ↓ move, ⏎ switches.
    @State private var focusedId: String? = nil
    @FocusState private var listFocused: Bool
    /// The kept branch a context-menu "Discard branch…" is asking about (audit L12).
    @State private var discardCandidate: String? = nil
    /// The pane's width, from `onGeometryChange` (never a measuring view, ADR-0062).
    @State private var paneWidth: CGFloat = 420
    /// Below this a row's state sentence moves to line 2 so the name keeps line 1:
    /// at the 260 pt default the sentence, the delegation ring and the name
    /// together left the name about six characters.
    private static let compactBelow: CGFloat = 340
    private var compact: Bool { paneWidth < Self.compactBelow }

    var body: some View {
        content
            .modifier(PaneGeometryProbe(name: "SessionsPane"))
            .confirmationDialog(
                "Discard this branch?",
                isPresented: Binding(
                    get: { discardCandidate != nil },
                    set: { if !$0 { discardCandidate = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Discard Branch", role: .destructive) {
                    if let id = discardCandidate { Task { await registry.discardKept(id) } }
                    discardCandidate = nil
                }
                Button("Cancel", role: .cancel) { discardCandidate = nil }
            } message: {
                Text("The branch and its worktree are deleted. Commits that are not merged anywhere else cannot be recovered from here.")
            }
        // A pane absorbs compression and clips; it never negotiates for
        // width. All seven stay mounted in one ZStack, so the widest
        // intrinsic minimum among them becomes the sidebar's, and the
        // overflow pushes the 44pt rail off the left edge (ADR-0114).
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                header
                restartBanner
                reviewUndoStrip
                // Brief §13.7 — one line; the settings, the log and the
                // conversation live in the Supervisor workspace it opens.
                if bridge.activeProjectId != nil, let line = SupervisorPaneLine.make(supervisorStrip) {
                    SupervisorPaneLineView(model: supervisor, line: line)
                }
                if rows.isEmpty && supervisorLayout.tabless.isEmpty {
                    if bridge.activeProjectId == nil {
                        PaneEmptyView(state: .noProject("sessions"))
                    } else {
                        PaneEmptyView(
                            state: PaneEmptyState(
                                headline: "No sessions yet",
                                hint: "Each chat tab is a session. Start one and it appears here with what it is doing.",
                                symbol: "rectangle.stack"
                            ),
                            actionTitle: "New chat tab",
                            action: { bridge.requestChatTab(.new) }
                        )
                    }
                } else {
                    // ADR-0112 — five sections. Interrupted and Failed fold into
                    // Needs you: both mean a human is required, and each keeps
                    // its own glyph.
                    needsYouSection
                    workingSection
                    waitingSection
                    finishedSection
                    integrateSection
                    idleSection
                    recentSection
                }
                if let projectId = bridge.activeProjectId { ProjectNoticesSection(projectId: projectId) }
                supervisorFooter
            }
            .layoutOscillationProbe("sessions-stack")
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { paneWidth = $0 })
        .focusable()
        .focused($listFocused)
        // The pane keeps keyboard focus for ↑ ↓ ⏎; it must not draw a ring
        // around itself for it. The focused ROW carries the ring instead
        // (`sessionRow`), which is also the only place it answers "where am
        // I" (2026-09-11).
        .focusEffectDisabled()
        .onKeyPress(.upArrow) { moveFocus(-1); return .handled }
        .onKeyPress(.downArrow) { moveFocus(1); return .handled }
        .onKeyPress(.return) {
            if let g = focusedGroup { toggle(g); return .handled }
            guard let id = focusedId, !id.hasPrefix("sup:") else { return .ignored }
            supervisor.showTab(id)
            return .handled
        }
        // Source-list behaviour: right opens a folded group (then steps into
        // it), left folds an open one, and from a row goes to its group's header.
        .onKeyPress(.rightArrow) {
            guard let g = focusedGroup else { return .ignored }
            if registry.isGroupCollapsed(g) { registry.setGroup(g, collapsed: false) } else { moveFocus(1) }
            return .handled
        }
        .onKeyPress(.leftArrow) {
            if let g = focusedGroup {
                if !registry.isGroupCollapsed(g) { registry.setGroup(g, collapsed: true) }
                return .handled
            }
            guard let id = focusedId, let g = groups.first(where: { $0.rowIds.contains(id) }) else { return .ignored }
            focusedId = Self.headerId(g.id)
            return .handled
        }
        // Space folds the focused header; on a row it expands or collapses the
        // row's escalation card — how an outward act's chip becomes
        // available. Never a consent (§9.1).
        .onKeyPress(.space) {
            if let g = focusedGroup { toggle(g); return .handled }
            guard let item = focusedEscalation else { return .ignored }
            toggleCard(item.id)
            return .handled
        }
        .onKeyPress(.escape) {
            guard let item = focusedEscalation, supervisor.expandedCards.contains(item.id) else { return .ignored }
            toggleCard(item.id)
            return .handled
        }
        .accessibilityRotor("Escalations") {
            ForEach(supervisorLayout.tabless + supervisorLayout.sessionIds.flatMap { supervisorLayout.items(for: $0) }) { item in
                AccessibilityRotorEntry(item.tabTitle.map { "\($0): \(item.escalatedBecause.label)" } ?? "Supervisor: \(item.escalatedBecause.label)",
                                        id: item.id, in: escalationRotor)
            }
        }
        .sheet(item: Binding(get: { supervisor.answerSheetItem }, set: { supervisor.answerSheetItem = $0 })) { item in
            if let req = item.asQuestionConfirm {
                AskQuestionSheet(request: req, onSubmit: { updated in
                    let answers = updated["answers"] ?? [:]
                    supervisor.answerSheetItem = nil
                    Task { await supervisor.act(item, actionId: "answer-edit", edits: ["answers": answers]) }
                }, onSkip: { supervisor.answerSheetItem = nil })
            }
        }
        .sheet(item: Binding(get: { supervisor.newTabEditItem }, set: { supervisor.newTabEditItem = $0 })) { item in
            SupervisorNewTabEditSheet(model: supervisor, item: item, onClose: { supervisor.newTabEditItem = nil })
        }
        .sheet(item: Binding(get: { supervisor.sendEditItem }, set: { supervisor.sendEditItem = $0 })) { item in
            SupervisorSendEditSheet(model: supervisor, item: item, onClose: { supervisor.sendEditItem = nil })
        }
        .sheet(item: Binding(get: { supervisor.raiseCapItem }, set: { supervisor.raiseCapItem = $0 })) { item in
            SupervisorRaiseCapSheet(model: supervisor, item: item, onClose: { supervisor.raiseCapItem = nil })
        }
        .task {
            registry.refreshSnapshot()
            registry.refreshIntegrationPreview()
        }
    }

    // MARK: - Data

    private struct Row: Identifiable {
        let id: String
        let entry: SessionEntry
        let state: SessionRowState
    }

    /// Open tabs plus anything live that is not a tab, attention first.
    private var rows: [Row] {
        var ids = registry.fleetSessionIds
        // ADR-0127 M6 — an escalation about a tab that is neither open nor
        // live still needs its row: the header counted it, and an item the
        // user cannot see is the one failure this inbox must not have.
        for id in supervisor.layout.sessionIds where !ids.contains(id) {
            ids.append(id)
        }
        return ids.compactMap { id -> Row? in
            let entry = registry.entry(id) ?? SessionEntry(id: id)
            return Row(id: id, entry: entry, state: registry.rowState(id))
        }
    }

    private func rows(where match: (SessionRowState) -> Bool) -> [Row] {
        // ADR-0127 M6 — a tab with an open escalation lives in Needs you.
        let escalated = Set(supervisorLayout.sessionIds)
        return rows.filter { match($0.state) && !escalated.contains($0.id) }
    }
    // MARK: - Groups, as displayed

    /// One group as the pane draws it: its count (header) and the rows the
    /// keyboard can land on, in display order (a folded group offers none).
    private struct GroupModel {
        let id: SessionGroupId
        let count: Int
        let rowIds: [String]
    }

    static func headerId(_ id: SessionGroupId) -> String { "grp:" + id.rawValue }

    private var focusedGroup: SessionGroupId? {
        guard let f = focusedId, f.hasPrefix("grp:") else { return nil }
        return SessionGroupId(rawValue: String(f.dropFirst(4)))
    }

    private func toggle(_ id: SessionGroupId) {
        focusedId = Self.headerId(id)
        listFocused = true
        registry.toggleGroup(id)
    }

    private var workingRows: [Row] { rows(where: { $0 == .working }).sorted { $0.state.sortRank < $1.state.sortRank } }
    private var waitingRows: [Row] { SessionWait.oldestFirst(rows(where: { $0 == .waiting })) { $0.entry.waitSince } }
    private var finishedRows: [Row] { rows(where: { $0 == .finished }) }
    private var finishedPlan: FinishedPolicy.Plan {
        FinishedPolicy.plan(finishedRows.map {
            FinishedPolicy.Row(id: $0.id, endedAt: $0.entry.lastTurnAt, hasTab: registry.isOpenTab($0.id), merged: $0.entry.isMergedOrGone)
        }, showAll: showAllFinished)
    }
    private var idleRows: [Row] { rows(where: { $0 == .idle || $0 == .draft || $0 == .done }) }
    private var idlePartition: SessionIdleCollapse.Partition {
        SessionIdleCollapse.partition(
            idleRows.map { SessionIdleCollapse.Row(id: $0.id, state: $0.state, idleSince: $0.entry.lastTurnAt) },
            selected: bridge.activeMarvinSessionId,
            now: registry.now,
            expanded: expandedIdle
        )
    }

    /// Every group with something in it, in `SessionGroupId.displayOrder`. The
    /// drawing and the keyboard both read this, so they cannot disagree.
    private var groups: [GroupModel] {
        SessionGroupId.displayOrder.compactMap { id -> GroupModel? in
            let open = !registry.isGroupCollapsed(id)
            func model(_ count: Int, _ ids: @autoclosure () -> [String]) -> GroupModel? {
                count > 0 ? GroupModel(id: id, count: count, rowIds: open ? ids() : []) : nil
            }
            switch id {
            case .needsYou:
                let tabless = supervisorLayout.tabless
                guard !needsYouRows.isEmpty || !tabless.isEmpty else { return nil }
                let plain = needsYouRows.filter { supervisorLayout.byTab[$0.id] == nil }.count
                let sorted = needsYouRows.sorted { $0.state.sortRank < $1.state.sortRank }
                return GroupModel(id: id, count: supervisorLayout.total + plain,
                                  rowIds: open ? tabless.map { "sup:" + $0.id } + sorted.map(\.id) : [])
            case .working: return model(workingRows.count, workingRows.map(\.id))
            case .waiting: return model(waitingRows.count, waitingRows.map(\.id))
            case .finished: return model(finishedRows.count, finishedPlan.shown)
            case .integrate: return model(registry.readyEntries.count, registry.readyEntries.map(\.id))
            case .idle:
                let partition = idlePartition
                return model(idleRows.count, idleRows.filter { partition.visible.contains($0.id) }.map(\.id))
            case .history: return model(recent.count, [])
            }
        }
    }

    /// ADR-0112 — the order the keyboard walks: as displayed, headers included.
    private var keyboardOrder: [String] {
        groups.flatMap { [Self.headerId($0.id)] + $0.rowIds }
    }
    private func moveFocus(_ delta: Int) {
        let ids = keyboardOrder
        guard !ids.isEmpty else { return }
        let current = focusedId.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
        let next = min(max(current + delta, 0), ids.count - 1)
        focusedId = ids[next]
    }

    private var recent: [SessionEntry] {
        registry.ledger.entries.values
            // ADR-0111 — a closed tab whose branch holds work lives in the
            // integration section, not here.
            .filter { $0.closedAt != nil && $0.worktree?.state != "ready" }
            .sorted { ($0.closedAt ?? .distantPast) > ($1.closedAt ?? .distantPast) }
            .prefix(8)
            .map { $0 }
    }

    // MARK: - Supervisor (ADR-0127 M6)

    private var supervisorStrip: SupervisorStrip {
        supervisor.strip(feedConnected: supervisor.fixtureFeedConnected ?? registry.feedConnected, now: registry.now)
    }
    private var supervisorLayout: SupervisorInboxLayout { supervisor.layout }
    /// Items stay readable but not actionable while the state is unknown (§7).
    private var itemsEnabled: Bool { supervisorStrip.itemsEnabled }

    private var needsYouRows: [Row] {
        let escalated = Set(supervisorLayout.sessionIds)
        return rows.filter { r in
            if escalated.contains(r.id) { return true }
            if case .needsYou = r.state { return true }
            return r.state == .interrupted || r.state == .failed
        }
    }

    /// Needs you is the inbox (brief §3): supervisor rows first (guardrails
    /// sort first among them), then tab rows that grow their escalations.
    /// The header counts every item, not only the rows.
    @ViewBuilder
    private var needsYouSection: some View {
        let tabRows = needsYouRows
        let tabless = supervisorLayout.tabless
        if !tabRows.isEmpty || !tabless.isEmpty {
            let plain = tabRows.filter { supervisorLayout.byTab[$0.id] == nil }.count
            group(.needsYou, count: supervisorLayout.total + plain, tint: .orange) {
                ForEach(tabless) { item in
                    SupervisorInboxRow(model: supervisor, item: item, enabled: itemsEnabled,
                                       focused: focusedId == "sup:" + item.id && listFocused)
                        .accessibilityRotorEntry(id: item.id, in: escalationRotor)
                        .onTapGesture { focusedId = "sup:" + item.id }
                }
                ForEach(tabRows.sorted { $0.state.sortRank < $1.state.sortRank }) { row in
                    sessionRow(row)
                }
            }
        }
    }

    /// The off line at the bottom of the pane (§6.7). The log moved to the
    /// workspace's inspector (§13.7).
    @ViewBuilder
    private var supervisorFooter: some View {
        if bridge.activeProjectId != nil, !supervisor.isEnabled, supervisor.tokenError == nil {
            SupervisorOffLine(model: supervisor)
        }
    }

    private var focusedEscalation: SupervisorInboxItem? {
        guard let id = focusedId else { return nil }
        if id.hasPrefix("sup:") { return supervisorLayout.tabless.first { "sup:" + $0.id == id } }
        return supervisorLayout.byTab[id]?.shown.first
    }

    private func toggleCard(_ id: String) {
        if supervisor.expandedCards.contains(id) { supervisor.expandedCards.remove(id) }
        else { supervisor.expandedCards.insert(id); supervisor.fullActShown.insert(id) }
    }

    /// The tab's escalations under its row: the oldest as a card, the rest
    /// behind "+N more for this tab" (§7 Burst). No batch accept, ever.
    @ViewBuilder
    private func escalations(for row: Row) -> some View {
        if let group = supervisorLayout.byTab[row.id] {
            ForEach(group.shown) { item in
                SupervisorEscalationCard(model: supervisor, item: item, enabled: itemsEnabled)
                    .accessibilityRotorEntry(id: item.id, in: escalationRotor)
                    .padding(.leading, 16)
            }
            if group.hiddenCount > 0 {
                Button("+\(group.hiddenCount) more for this tab") { supervisor.expandedTabs.insert(row.id) }
                    .rowChip(.neutral)
                    .padding(.leading, 16)
                    .accessibilityLabel("\(group.hiddenCount) more escalations for this tab")
            } else if supervisor.expandedTabs.contains(row.id), group.all.count > 1 {
                Button("Show only the oldest") { supervisor.expandedTabs.remove(row.id) }
                    .rowChip(.neutral)
                    .padding(.leading, 16)
            }
        }
    }

    // MARK: - Sections

    /// R-01 — one sentence naming the tabs a restart cut off, until dismissed
    /// or until they run again. The rows themselves say it too (`subtitle`).
    @ViewBuilder
    private var restartBanner: some View {
        let ids = registry.restartCutOffs
        if !ids.isEmpty {
            let titles = ids.map { title(registry.entry($0) ?? SessionEntry(id: $0)) }
            PaneNoticeStrip(
                notice: PaneNotice(kind: .warning, text: SessionRestartTrace.message(titles: titles)),
                onDismiss: { registry.dismissRestartBanner() }
            )
        }
    }

    private var header: some View {
        PaneHeader(title: "Sessions", symbol: "rectangle.stack") {
            if !registry.feedConnected, bridge.activeProjectId != nil {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .help("Live feed disconnected — reconnecting")
            }
            Button {
                bridge.requestChatTab(.new)
            } label: {
                Image(systemName: "plus")
            }
            .paneIconButton()
            .help("New chat tab (⌘⇧N)")
            Button {
                registry.refreshSnapshot()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .paneIconButton(10)
            .help("Refresh")
        }
    }

    @ViewBuilder
    private var workingSection: some View {
        let working = workingRows
        if !working.isEmpty {
            group(.working, count: working.count, tint: GitDecorationColor.modified) {
                ForEach(working) { row in sessionRow(row) }
            }
        }
    }

    /// W-08 — a turn that ended with a result and has not been looked at stays
    /// here until it has (selecting the tab counts). Quiet by default: the five
    /// most recent, merged ones behind "Show all", and one bulk action in the
    /// header that writes reviewed marks and nothing else. A result nobody can
    /// select (no tab) leaves by itself, `FinishedPolicy`.
    @ViewBuilder
    private var finishedSection: some View {
        let all = finishedRows
        if !all.isEmpty {
            let plan = finishedPlan
            let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            group(.finished, count: all.count, tint: Color.accentColor, trailing: {
                if all.count > 1 {
                    ViewThatFits(in: .horizontal) {
                        markAllChip("Mark all reviewed", all)
                        markAllChip("Mark all", all)
                    }
                }
            }) {
                ForEach(plan.shown.compactMap { byId[$0] }) { row in sessionRow(row) }
                if plan.hiddenCount > 0 {
                    disclosureLink("Show all \(all.count)") { showAllFinished = true }
                } else if showAllFinished, all.count > FinishedPolicy.quietLimit {
                    disclosureLink("Show fewer") { showAllFinished = false }
                }
            }
        }
    }

    private func markAllChip(_ label: String, _ rows: [Row]) -> some View {
        Button(label) { registry.markAllReviewed(rows.map(\.id)) }
            .rowChip(.neutral)
            .fixedSize()
            .help("Mark all \(rows.count) finished sessions as reviewed. Nothing is closed or deleted, and Undo stays for a few seconds.")
            .accessibilityLabel("Mark all \(rows.count) finished sessions as reviewed")
    }

    /// "Show all 45", "Show fewer", "3 more idle sessions": the quiet text
    /// button under a group that holds some rows back.
    private func disclosureLink(_ text: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(minHeight: 22, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 14)
    }

    /// After "Mark all reviewed": what was done and the way back, for a few
    /// seconds. Above the groups, because the group it came from may be gone.
    @ViewBuilder
    private var reviewUndoStrip: some View {
        if let pending = registry.reviewUndo {
            PaneNoticeStrip(
                notice: PaneNotice(kind: .success, text: "Marked \(pending.count) as reviewed."),
                actionTitle: "Undo",
                onAction: { registry.undoMarkAllReviewed() }
            )
        }
    }

    /// W-04 — its own group above Finished, never folded behind "N more", oldest
    /// wait first: the one that has waited longest is the one most likely stuck.
    @ViewBuilder
    private var waitingSection: some View {
        let waiting = waitingRows
        if !waiting.isEmpty {
            group(.waiting, count: waiting.count, tint: MarvinTheme.textMuted) {
                ForEach(waiting) { row in sessionRow(row) }
            }
        }
    }

    @ViewBuilder
    private var idleSection: some View {
        let idle = idleRows
        if !idle.isEmpty {
            let partition = idlePartition
            group(.idle, count: idle.count, tint: MarvinTheme.textMuted) {
                ForEach(idle.filter { partition.visible.contains($0.id) }) { row in
                    sessionRow(row)
                }
                if !partition.collapsed.isEmpty {
                    disclosureLink("\(partition.collapsed.count) more idle session\(partition.collapsed.count == 1 ? "" : "s")") { expandedIdle = true }
                } else if expandedIdle, idle.count > SessionIdleCollapse.alwaysVisibleIdle {
                    disclosureLink("Show fewer") { expandedIdle = false }
                }
            }
        }
    }

    @ViewBuilder
    private var recentSection: some View {
        let items = recent
        if !items.isEmpty {
            group(.history, count: items.count, tint: MarvinTheme.textMuted) {
                ForEach(items) { e in
                    HStack(spacing: 6) {
                        Circle().fill(Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(title(e))
                                .font(.system(size: 11))
                                .foregroundStyle(MarvinTheme.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(e.tree?.mode == .worktree ? "kept: \(e.tree?.branch ?? "worktree")" : "closed")
                                .font(.system(size: 11))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Button("Reopen") { Task { await registry.reopen(e.id) } }
                            .rowChip(.primary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 3)
                }
            }
        }
    }

    // MARK: - Ready to integrate (ADR-0111)

    /// Closed tabs whose branch holds commits: the day's deliverables, with
    /// the dry-run verdict per row and the two integration flows in the
    /// footer. Nothing here runs a merge without a click.
    @ViewBuilder
    private var integrateSection: some View {
        let items = registry.readyEntries
        if !items.isEmpty {
            group(.integrate, count: items.count, tint: GitDecorationColor.added, trailing: {
                if let target = registry.integrationTarget {
                    Text("→ \(target)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Button {
                    registry.refreshIntegrationPreview()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Re-run the dry-run preview")
                .accessibilityLabel("Re-run the preview")
            }) {
                ForEach(items) { e in integrateRow(e) }
                integrateFooter(items)
            }
        }
    }

    private func integrateRow(_ e: SessionEntry) -> some View {
        let w = e.worktree
        let preview = w.flatMap { registry.integrationPreview[$0.slug] }
        let needsSync = preview.map { $0.isConflict || $0.behind > 0 } ?? false
        return HStack(spacing: 6) {
            Circle()
                .fill(preview?.isConflict == true ? Color.orange : GitDecorationColor.added)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(shortBranch(w?.branch) ?? title(e))
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(integrateSubtitle(e, preview: preview))
                    .font(.system(size: 11))
                    .foregroundStyle(preview?.isConflict == true ? Color.orange : MarvinTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if needsSync {
                smallAction("Sync", role: .neutral) { Task { await registry.sync(e.id) } }
                    .help("Ask this tab to merge \(registry.integrationTarget ?? "the current branch") into its branch in its own worktree, resolve conflicts, test, and commit. Never pushes.")
            }
            smallAction("Merge", role: .neutral) { Task { await registry.mergeKept(e.id) } }
                .help("Merge \(w?.branch ?? "this branch") into \(registry.integrationTarget ?? "the current branch"), locally. Never pushes.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { focusedId = e.id }
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(focusedId == e.id && listFocused ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1)
        )
        .help([title(e), w?.branch, e.tree?.path].compactMap { $0 }.joined(separator: "\n"))
        .contextMenu {
            Button("Reopen tab") { Task { await registry.reopen(e.id) } }
            if let branch = w?.branch {
                Button("Copy branch name") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(branch, forType: .string)
                }
            }
            if let path = e.tree?.path {
                Button("Reveal worktree in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                }
            }
            Divider()
            Button("Discard branch…", role: .destructive) { discardCandidate = e.id }
        }
        .disabled(registry.integrationBusy)
    }

    private func integrateSubtitle(_ e: SessionEntry, preview: IntegrationPreviewRow?) -> String {
        var parts: [String] = []
        if let w = e.worktree {
            parts.append(w.branch.hasPrefix("marvin/tab/") ? String(w.branch.dropFirst("marvin/tab/".count)) : w.branch)
            parts.append("\(w.commits) commit\(w.commits == 1 ? "" : "s")")
            if w.dirty { parts.append("uncommitted") }
        }
        if let p = preview {
            if p.added + p.removed > 0 { parts.append("+\(p.added) −\(p.removed)") }
            parts.append(p.verdictLabel)
        } else if let w = e.worktree, let behind = w.behind, behind > 0 {
            parts.append("behind by \(behind)")
        }
        return parts.joined(separator: " · ")
    }

    /// The result of a Merge / Sync / Prepare MR, with its kind. It rendered
    /// as 9.5pt tertiary text, so a refused merge and a finished one looked
    /// the same (ADR-0114).
    @ViewBuilder
    private var integrationNoticeStrip: some View {
        if let text = registry.integrationNotice, !text.isEmpty {
            PaneNoticeStrip(
                notice: PaneNotice(kind: PaneNotice.kind(forOutcome: text), text: text),
                onDismiss: { registry.integrationNotice = nil }
            )
        }
    }

    @ViewBuilder
    private func integrateFooter(_ items: [SessionEntry]) -> some View {
        let conflicts = items.filter { e in e.worktree.flatMap { registry.integrationPreview[$0.slug] }?.isConflict == true }.count
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                if items.count > 1 {
                    Button("Merge all") { Task { await registry.mergeAllKept() } }
                        .chip(.primary)
                        .disabled(registry.integrationBusy)
                        .help("Fold all \(items.count) branches into \(registry.integrationTarget ?? "the current branch"), oldest first, locally. Stops at the first conflict. Never pushes.")
                }
                // Neutral, and the tooltip says why: this is the one that spends
                // CI minutes, so it must not read as the default action (U22).
                Button("Prepare MR…") { bridge.requestSourceControl(.prepareMR) }
                    .chip(.neutral)
                    .disabled(registry.integrationBusy)
                    .help("Squash the branches you pick into one commit on a new mr/… branch, then push and open one merge request. Spends CI minutes; Merge all stays local.")
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 2)
            // Its own line: beside the buttons it got the width they left over
            // and wrapped one word per line at a 260 pt sidebar (U4). A status
            // colour carries a glyph (DESIGN.md Outcome Color Rule).
            if conflicts > 0 {
                Label("\(conflicts) would conflict — Sync first", systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 14)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // No `.textSelection(.enabled)` anywhere below: SwiftUI's
            // selection overlay is an AppKit view that re-lays out during
            // layout, and inside this ScrollView it looped the window into the
            // fatal "more Layout Window passes than views" (2026-09-10).
            // `PaneNoticeStrip` carries that rule in its own file.
            integrationNoticeStrip
        }
    }

    /// A group: a disclosure header that carries the count (visible folded
    /// or open), then its rows unless the person folded it. The fold is the
    /// registry's, so it is remembered per project.
    @ViewBuilder
    private func group<Content: View, Trailing: View>(
        _ id: SessionGroupId, count: Int, tint: Color,
        @ViewBuilder trailing: @escaping () -> Trailing, @ViewBuilder content: () -> Content
    ) -> some View {
        let folded = registry.isGroupCollapsed(id)
        VStack(alignment: .leading, spacing: 4) {
            PaneDisclosureHeader(
                title: id.title, count: count, tint: tint, collapsed: folded,
                focused: focusedId == Self.headerId(id) && listFocused,
                onToggle: { toggle(id) }, trailing: trailing
            )
            if !folded { content() }
        }
    }

    @ViewBuilder
    private func group<Content: View>(_ id: SessionGroupId, count: Int, tint: Color, @ViewBuilder content: () -> Content) -> some View {
        group(id, count: count, tint: tint, trailing: { EmptyView() }, content: content)
    }

    // MARK: - Row

    private func sessionRow(_ row: Row) -> some View {
        let e = row.entry
        let selected = row.id == bridge.activeMarvinSessionId
        let focused = row.id == focusedId
        let name = title(e)
        let long = isLongWait(e)
        let sentence = compact ? SessionRowText.narrowSentence(row.state, e, now: registry.now) : SessionRowText.stateSentence(row.state, e, now: registry.now)
        let isTab = registry.isOpenTab(row.id)
        // ADR-0112 — answer a waiting tab here, without switching to it.
        // A question (AskUserQuestion) is a form and still opens the tab.
        // ADR-0127 M6 — an escalation card replaces the inline confirm it
        // concerns, so the pending item is never shown twice.
        let covered = Set(supervisorLayout.items(for: row.id).compactMap { $0.linkedConfirm?.toolUseId })
        let head = e.pendingConfirms.values.sorted(by: { ($0.since ?? "") < ($1.since ?? "") }).first
        var inline: PendingConfirmInfo?
        if case .needsYou = row.state, let c = head, !covered.contains(c.toolUseId), c.toolName != "AskUserQuestion" { inline = c }
        // The inline card says what is asked, so line 2 does not say it twice.
        let fact = inline == nil ? SessionRowText.keyFact(row.state, e, now: registry.now) : nil
        return VStack(alignment: .leading, spacing: 4) {
            // R2-11 / W-03 / W-10 — two lines. Line 1: the name, then the state
            // sentence, which is never cut before the name is. Line 2: the one
            // fact that matters for that state, and the row's action. Graph,
            // reads, skills, cost and the rest are on the hover card. In a
            // narrow pane (the 260 pt default) the state sentence moves to the
            // front of line 2 so the name keeps the whole of line 1.
            HStack(alignment: .top, spacing: 6) {
                stateGlyph(row.state, longWait: long).frame(height: 16)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(name)
                            .font(.system(size: 12, weight: selected ? .semibold : .medium))
                            .foregroundStyle(MarvinTheme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                        if !compact { stateText(sentence, state: row.state, long: long) }
                        delegationChip(row, e, name: name)
                    }
                    .frame(minHeight: 16)
                    // A measurement (changes, plan, where it works) on a finished or
                    // idle row is the first thing to give way in a narrow pane: whole
                    // or not at all, never "5…". A wait's own label stays and truncates.
                    if compact, row.state == .finished || row.state == .idle || row.state == .done, fact != nil {
                        ViewThatFits(in: .horizontal) {
                            secondLine(row, sentence: sentence, fact: fact, long: long, isTab: isTab, factFixed: true)
                            secondLine(row, sentence: sentence, fact: nil, long: long, isTab: isTab)
                        }
                    } else {
                        secondLine(row, sentence: sentence, fact: fact, long: long, isTab: isTab)
                    }
                }
            }
            if let c = inline { inlineConfirm(c, sessionId: row.id) }
            if supervisor.isEnabled, let c = head, !covered.contains(c.toolUseId), let p = c.supervisorProposal {
                SupervisorProposalLine(model: supervisor, proposal: p, revealedOnServer: c.proposalRevealed ?? false)
            }
            if let a = e.attention { attentionLine(a, sessionId: row.id) }
            escalations(for: row)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { focusedId = row.id; supervisor.showTab(row.id) }
        // The row is a tap gesture; give VoiceOver the same act (L24), and keep
        // the Allow / Deny chips inside it individually reachable.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: "Switch to tab") { focusedId = row.id; supervisor.showTab(row.id) }
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(selected ? MarvinTheme.rowSelected : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(focused && listFocused ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1)
                )
        )
        .help(hoverCard(e, state: row.state, name: name, isOpenTab: isTab))
        .contextMenu {
            Button(isTab ? "Switch to" : "Open tab") { supervisor.showTab(row.id) }
            if row.state == .finished {
                Button("Mark reviewed") { registry.markReviewed(row.id) }
            }
            if e.isLive {
                Button("Stop") { Task { await registry.stop(row.id) } }
            }
            Button("Close tab") { bridge.requestChatTab(.close(row.id)) }
            if let branch = e.tree?.branch {
                Divider()
                Button("Copy branch name") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(branch, forType: .string)
                }
                if let path = e.tree?.path {
                    Button("Reveal worktree in Finder") {
                        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                    }
                }
            }
        }
    }

    /// Line 2 of a row: the state sentence (narrow panes only), the one fact,
    /// "no tab", and the row's one action.
    private func secondLine(_ row: Row, sentence: String, fact: String?, long: Bool, isTab: Bool, factFixed: Bool = false) -> some View {
        HStack(spacing: 6) {
            if compact { stateText(sentence, state: row.state, long: long) }
            if let fact {
                Text(fact)
                    .font(.system(size: 11))
                    .foregroundStyle(factTint(row.state, long: long))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: factFixed, vertical: false)
            }
            Spacer(minLength: 0)
            if !isTab && !compact {
                // Short on the row; the hover card says it in full.
                Text("no tab")
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel("not open as a tab")
            }
            action(for: row, isTab: isTab)
        }
    }

    /// The state sentence: never cut, never the first thing to give way.
    private func stateText(_ sentence: String, state: SessionRowState, long: Bool) -> some View {
        Text(sentence)
            .font(.system(size: 11, weight: state == .waiting && !long ? .regular : .medium))
            .foregroundStyle(stateTint(state, long: long))
            .lineLimit(1)
            .fixedSize()
            .layoutPriority(1)
    }

    /// The supervisor-delegation menu, with its words on hover (R2-11).
    @ViewBuilder
    private func delegationChip(_ row: Row, _ e: SessionEntry, name: String) -> some View {
        if supervisor.isEnabled, let sup = e.supervisor {
            SupervisorDelegationChip(model: supervisor, sessionId: row.id, tabTitle: name,
                                     level: sup.delegation, sharedCheckout: sup.sharedCheckout ?? (e.mode == .shared),
                                     lastActAt: sup.lastActAt)
        }
    }

    /// ADR-0112 — a glyph per state so colour is never the only signal.
    @ViewBuilder
    private func stateGlyph(_ state: SessionRowState, longWait: Bool = false) -> some View {
        switch state {
        case .working:
            ProgressView().controlSize(.mini).frame(width: 12, height: 12)
        case .needsYou:
            Image(systemName: "hand.raised.fill").font(.system(size: 11)).foregroundStyle(.orange).frame(width: 12)
        case .interrupted:
            Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)).foregroundStyle(.orange).frame(width: 12)
        case .failed:
            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(GitDecorationColor.deleted).frame(width: 12)
        case .waiting:
            Image(systemName: "clock").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ChatPreviewView.tabTint(state, longWait: longWait)).frame(width: 12)
                .accessibilityLabel(longWait ? "Waiting for a long time" : "Waiting")
        case .done:
            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(ChatPreviewView.tabTint(state)).frame(width: 12)
        case .finished:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ChatPreviewView.tabTint(state)).frame(width: 12)
                .accessibilityLabel("Finished, not reviewed")
        case .idle, .draft:
            Circle().fill(ChatPreviewView.tabTint(state)).frame(width: 6, height: 6).frame(width: 12)
        }
    }

    /// ADR-0130 — what a stopped tab is waiting on (its closing question, or the
    /// job the chain cap refused) and a Dismiss that clears it. Answering it is
    /// sending the tab a message, which clears it too.
    private func attentionLine(_ a: SessionWatchRowWire.Attention, sessionId: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(a.excerpt)
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(a.excerpt)
            Button("Dismiss") { Task { await registry.dismissAttention(sessionId) } }
                .rowChip(.neutral)
                .help("Clear this without answering. Sending the tab a message clears it too.")
                .accessibilityLabel("Dismiss the waiting note for this tab")
        }
        .padding(.leading, 16)
    }

    /// The pending tool, its one-line excerpt, and Allow / Deny — the same
    /// decision the tray card offers, from here.
    private func inlineConfirm(_ c: PendingConfirmInfo, sessionId: String) -> some View {
        let excerpt = c.excerpt ?? "wants to run"
        let toolBadge = Text(ToolLabel.plain(c.toolName))
            .font(.system(size: 11))
            .help(c.toolName)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3).fill(Color.orange.opacity(0.16)))
        let deny = Button("Deny") { Task { await registry.answer(c, in: sessionId, allow: false) } }
            .rowChip(.tinted(GitDecorationColor.deleted))
            .help("Refuse this tool call. The tab is told no and carries on.")
            .accessibilityLabel("Deny \(ToolLabel.plain(c.toolName))")
        let allow = Button("Allow") { Task { await registry.answer(c, in: sessionId, allow: true) } }
            .rowChip(.tinted(GitDecorationColor.added))
            .help("Let this tool call run, without switching to that tab.")
            .accessibilityLabel("Allow \(ToolLabel.plain(c.toolName))")
        return VStack(alignment: .leading, spacing: 3) {
            // What is being approved, in full where it fits (L7). This was one
            // line, middle-truncated, with the whole text only in a tooltip — a
            // decision made on the part of a command that survived the
            // ellipsis. A short command keeps the compact one-line row; one
            // that does not fit gets its own lines (four, cut at the end,
            // selectable) with the buttons below, so it never squeezes them.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    toolBadge
                    Text(excerpt)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Spacer(minLength: 4)
                    deny
                    allow
                }
                VStack(alignment: .leading, spacing: 3) {
                    toolBadge
                    Text(excerpt)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .help(excerpt)
                    HStack(spacing: 6) {
                        Spacer(minLength: 4)
                        deny
                        allow
                    }
                }
            }
            if let r = c.reason, !r.isEmpty {
                Text(r).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(2)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 2)
    }

    /// The row's one action. A session that is not open as a tab and has no
    /// action of its own gets "Open": selecting it opens it as a tab, the same
    /// path every other "go to this session" takes (R2-01).
    @ViewBuilder
    private func action(for row: Row, isTab: Bool) -> some View {
        switch row.state {
        case .needsYou:
            smallAction("Answer", role: .primary) { supervisor.showTab(row.id) }
        case .working:
            smallAction("Stop", role: .neutral) { Task { await registry.stop(row.id) } }
        case .interrupted:
            smallAction("Resume", role: .neutral) { Task { await registry.resume(row.id) } }
        case .failed:
            smallAction("Open", role: .neutral) { supervisor.showTab(row.id) }
        case .finished:
            smallAction("Reviewed", role: .neutral) { registry.markReviewed(row.id) }
                .help("Mark this as looked at. Opening the tab does the same.")
        case .waiting, .done, .idle, .draft:
            if !isTab {
                smallAction(compact ? "Open" : "Open tab", role: .neutral) { supervisor.showTab(row.id) }
                    .help("This session is not open as a tab. Open it to read the conversation.")
            }
        }
    }

    /// A row action. A chip, not tinted text: this pane is full of tinted
    /// STATUS text (`+880 −13`, `clean`, counts), so a tinted word carried no
    /// information about whether it could be clicked (2026-09-11).
    /// `marvin/tab/fix-flags-thread-p-source` → `fix-flags-thread-p-source`.
    /// The prefix is the same on every row, so it is noise where identity is
    /// the job.
    private func shortBranch(_ branch: String?) -> String? {
        guard let branch, !branch.isEmpty else { return nil }
        guard branch.hasPrefix("marvin/tab/") else { return branch }
        return String(branch.dropFirst("marvin/tab/".count))
    }

    private func smallAction(_ label: String, role: ChipRole, _ action: @escaping () -> Void) -> some View {
        Button(label, action: action).rowChip(role)
    }

    // MARK: - Text

    /// The one name for the session, the same on every surface (R2-02): what the
    /// tab strip prints, from `SessionRegistry.displayName`. The supervisor
    /// inbox keeps a title for a tab this pane never loaded.
    private func title(_ e: SessionEntry) -> String {
        registry.displayName(e.id, fallbackTitle: supervisor.inbox.first(where: { $0.sessionId == e.id })?.tabTitle)
    }

    /// Colour for the state sentence: a person wanted and a long wait are warm,
    /// a result nobody has looked at is the accent, a failure is red.
    private func stateTint(_ state: SessionRowState, long: Bool) -> Color {
        switch state {
        case .needsYou, .interrupted: return .orange
        case .failed: return GitDecorationColor.deleted
        case .waiting: return long ? .orange : MarvinTheme.textPrimary.opacity(0.8)
        case .finished: return Color.accentColor
        case .working: return MarvinTheme.textPrimary.opacity(0.8)
        case .done, .idle, .draft: return MarvinTheme.textMuted
        }
    }

    private func factTint(_ state: SessionRowState, long: Bool) -> Color {
        state == .waiting ? (long ? .orange : MarvinTheme.textPrimary.opacity(0.8)) : MarvinTheme.textMuted
    }

    /// W-10 — what used to be printed on every row: branch, commits, plan,
    /// graph and reads, skills, cost, what the tab holds. A measurement of the
    /// work is not a status, so it waits for a hover.
    private func hoverCard(_ e: SessionEntry, state: SessionRowState, name: String, isOpenTab: Bool) -> String {
        SessionRowText.details(state, e, now: registry.now, name: name,
                               claim: registry.claimsBySession[e.id]?.first, supervisorEnabled: supervisor.isEnabled,
                               isOpenTab: isOpenTab)
            .joined(separator: "\n")
    }

    private func isLongWait(_ e: SessionEntry) -> Bool { e.isLongWait(now: registry.now) }
}

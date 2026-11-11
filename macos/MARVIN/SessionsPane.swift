// SessionsPane — every session of the project at a glance (ADR-0107).
//
// A left-pane tab, the same shape as PracticePane (a ScrollView root with a
// LazyVStack — ADR-0062: nothing here inserts measurement views or nested
// split views). It is an OBSERVER over `SessionRegistry`: rows come from the
// ledger the project feed maintains, and every action goes back through the
// registry or the bridge's one-shot tab request. One transcript stays on
// screen; this pane tells you which one deserves it next.
//
// Sections follow attention: Needs you, Working, Interrupted, Failed, Idle
// (collapsing after a timeout, like Claude Code's agent panel), Recent.

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
    @Namespace private var escalationRotor
    /// ADR-0112 — keyboard focus in the list: ↑ ↓ move, ⏎ switches.
    @State private var focusedId: String? = nil
    @FocusState private var listFocused: Bool
    /// The kept branch a context-menu "Discard branch…" is asking about (audit L12).
    @State private var discardCandidate: String? = nil

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
                    section("Working", rows(where: { $0 == .working }), tint: GitDecorationColor.modified)
                    section("Waiting", rows(where: { $0 == .waiting }), tint: MarvinTheme.textMuted)
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
            guard let id = focusedId, !id.hasPrefix("sup:") else { return .ignored }
            supervisor.showTab(id)
            return .handled
        }
        // Space expands or collapses the focused row's escalation card — how an
        // outward act's chip becomes available. Never a consent (§9.1).
        .onKeyPress(.space) {
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
        var ids = registry.openTabs
        for (id, e) in registry.ledger.entries where e.isLive && !ids.contains(id) && e.closedAt == nil {
            ids.append(id)
        }
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
    /// ADR-0112 — the order the keyboard walks: as displayed.
    private var keyboardOrder: [String] {
        supervisorLayout.tabless.map { "sup:" + $0.id } + needsYouRows.map(\.id)
            + rows.filter { r in !needsYouRows.contains { $0.id == r.id } }
                .sorted { $0.state.sortRank < $1.state.sortRank }.map(\.id)
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
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader("Needs you", count: supervisorLayout.total + plain, tint: .orange)
                    .accessibilityAddTraits(.isHeader)
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

    private var header: some View {
        PaneHeader(title: "Sessions", symbol: "rectangle.stack") {
            if !registry.feedConnected, bridge.activeProjectId != nil {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 10))
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
    private func section(_ title: String, _ items: [Row], tint: Color) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader(title, count: items.count, tint: tint)
                ForEach(items.sorted { $0.state.sortRank < $1.state.sortRank }) { row in
                    sessionRow(row)
                }
            }
        }
    }

    @ViewBuilder
    private var idleSection: some View {
        let idle = rows(where: { $0 == .idle || $0 == .draft || $0 == .done })
        if !idle.isEmpty {
            let partition = SessionIdleCollapse.partition(
                idle.map { SessionIdleCollapse.Row(id: $0.id, state: $0.state, idleSince: $0.entry.lastTurnAt) },
                selected: bridge.activeMarvinSessionId,
                now: registry.now,
                expanded: expandedIdle
            )
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader("Idle", count: idle.count, tint: MarvinTheme.textMuted)
                ForEach(idle.filter { partition.visible.contains($0.id) }) { row in
                    sessionRow(row)
                }
                if !partition.collapsed.isEmpty {
                    Button {
                        expandedIdle = true
                    } label: {
                        Text("\(partition.collapsed.count) more idle session\(partition.collapsed.count == 1 ? "" : "s")")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 14)
                } else if expandedIdle, idle.count > SessionIdleCollapse.alwaysVisibleIdle {
                    Button {
                        expandedIdle = false
                    } label: {
                        Text("Collapse idle")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 14)
                }
            }
        }
    }

    @ViewBuilder
    private var recentSection: some View {
        let items = recent
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader("History", count: items.count, tint: .secondary)
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
                                .font(.system(size: 9.5))
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
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    sectionHeader("Ready to integrate", count: items.count, tint: GitDecorationColor.added)
                    Spacer()
                    if let target = registry.integrationTarget {
                        Text("→ \(target)")
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Button {
                        registry.refreshIntegrationPreview()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 9, weight: .medium))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Re-run the dry-run preview")
                    .accessibilityLabel("Re-run the preview")
                }
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
                    .font(.system(size: 9.5))
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
                    .font(.system(size: 9.5))
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

    /// This pane's own shape, now the shared one: it was the most legible of
    /// the five that existed, so `PaneSectionHeader` is it (ADR-0114).
    private func sectionHeader(_ title: String, count: Int, tint: Color) -> some View {
        PaneSectionHeader(title, count: count, tint: tint)
    }

    // MARK: - Row

    private func sessionRow(_ row: Row) -> some View {
        let e = row.entry
        let selected = row.id == bridge.activeMarvinSessionId
        let focused = row.id == focusedId
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                stateGlyph(row.state)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title(e))
                        .font(.system(size: 11, weight: selected ? .semibold : .regular))
                        .foregroundStyle(MarvinTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(subtitle(e, state: row.state))
                        .font(.system(size: 9.5))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if supervisor.isEnabled, let sup = e.supervisor {
                    SupervisorDelegationChip(model: supervisor, sessionId: row.id, tabTitle: title(e),
                                             level: sup.delegation, sharedCheckout: sup.sharedCheckout ?? (e.mode == .shared),
                                             lastActAt: sup.lastActAt)
                }
                action(for: row)
            }
            // ADR-0112 — answer a waiting tab here, without switching to it.
            // A question (AskUserQuestion) is a form and still opens the tab.
            // ADR-0127 M6 — an escalation card replaces the inline confirm it
            // concerns, so the pending item is never shown twice.
            let covered = Set(supervisorLayout.items(for: row.id).compactMap { $0.linkedConfirm?.toolUseId })
            let head = e.pendingConfirms.values.sorted(by: { ($0.since ?? "") < ($1.since ?? "") }).first
            if case .needsYou = row.state, let c = head, !covered.contains(c.toolUseId), c.toolName != "AskUserQuestion" {
                inlineConfirm(c, sessionId: row.id)
            }
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
        .help(help(e))
        .contextMenu {
            Button("Switch to") { supervisor.showTab(row.id) }
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

    /// ADR-0112 — a glyph per state so colour is never the only signal.
    @ViewBuilder
    private func stateGlyph(_ state: SessionRowState) -> some View {
        switch state {
        case .working:
            ProgressView().controlSize(.mini).frame(width: 10, height: 10)
        case .needsYou:
            Image(systemName: "hand.raised.fill").font(.system(size: 9)).foregroundStyle(.orange).frame(width: 10)
        case .interrupted:
            Image(systemName: "arrow.clockwise").font(.system(size: 9, weight: .semibold)).foregroundStyle(.orange).frame(width: 10)
        case .failed:
            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(GitDecorationColor.deleted).frame(width: 10)
        case .waiting:
            Image(systemName: "clock").font(.system(size: 9, weight: .semibold)).foregroundStyle(ChatPreviewView.tabTint(state)).frame(width: 10)
        case .done:
            Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(ChatPreviewView.tabTint(state)).frame(width: 10)
        case .idle, .draft:
            Circle().fill(ChatPreviewView.tabTint(state)).frame(width: 6, height: 6).frame(width: 10)
        }
    }

    /// ADR-0130 — what a stopped tab is waiting on (its closing question, or the
    /// job the chain cap refused) and a Dismiss that clears it. Answering it is
    /// sending the tab a message, which clears it too.
    private func attentionLine(_ a: SessionWatchRowWire.Attention, sessionId: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(a.excerpt)
                .font(.system(size: 10))
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
            .font(.system(size: 9.5))
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
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Spacer(minLength: 4)
                    deny
                    allow
                }
                VStack(alignment: .leading, spacing: 3) {
                    toolBadge
                    Text(excerpt)
                        .font(.system(size: 9.5, design: .monospaced))
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
                Text(r).font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(2)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 2)
    }

    @ViewBuilder
    private func action(for row: Row) -> some View {
        switch row.state {
        case .needsYou:
            smallAction("Answer", role: .primary) { supervisor.showTab(row.id) }
        case .working:
            smallAction("Stop", role: .neutral) { Task { await registry.stop(row.id) } }
        case .interrupted:
            smallAction("Resume", role: .neutral) { Task { await registry.resume(row.id) } }
        case .failed:
            smallAction("Open", role: .neutral) { supervisor.showTab(row.id) }
        case .waiting, .done, .idle, .draft:
            EmptyView()
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

    private func title(_ e: SessionEntry) -> String {
        if e.isDraft { return "New chat" }
        if let t = e.title?.replacingOccurrences(of: "\n", with: " "), !t.trimmingCharacters(in: .whitespaces).isEmpty {
            return t.count > 40 ? String(t.prefix(38)) + "…" : t
        }
        // The inbox snapshots a tab's title, so a tab this pane never loaded keeps its name.
        if let t = supervisor.inbox.first(where: { $0.sessionId == e.id })?.tabTitle, !t.isEmpty { return t }
        return String(e.id.prefix(8))
    }

    private func subtitle(_ e: SessionEntry, state: SessionRowState) -> String {
        var parts: [String] = []
        if let tree = e.tree, tree.mode == .worktree {
            parts.append("isolated: \(tree.branch ?? "worktree")")
            if let w = e.worktree, let into = w.mergedInto {
                parts.append("merged into \(into) — close to reclaim")
            } else if let w = e.worktree, w.commits > 0 {
                parts.append("\(w.commits) commit\(w.commits == 1 ? "" : "s")")
                if let b = w.behind, b > 0 { parts.append("behind by \(b)") }
            }
        } else if e.isDraft {
            parts.append("draft")
        } else {
            parts.append("shared")
        }
        if let held = registry.claimsBySession[e.id]?.first {
            parts.append("on: " + (held.count > 34 ? String(held.prefix(32)) + "…" : held))
        }
        if let d = e.diff, d.files > 0 { parts.append("+\(d.added) −\(d.removed)") }
        if let p = e.plan, p.total > 0 { parts.append(planLabel(p, e)) }
        if let u = e.graphUsage { parts.append(graphUsageLabel(u)) }
        if let c = e.costUsd, c > 0 { parts.append(String(format: "$%.2f", c)) }
        if supervisor.isEnabled, let sup = e.supervisor, sup.delegation != .off {
            if sup.stoppedByUser == true { parts.append("stopped — supervisor waits for you") }
            else if let w = sup.waitingOnOwn { parts.append("supervisor waits — tab waiting on its \(w == "job" ? "build" : "wakeup")") }
        }
        if case .needsYou = state, let first = e.pendingConfirms.values.first {
            parts.append("waiting: \(ToolLabel.plain(first.toolName))")
        } else if let a = e.attention {
            parts.append(a.kind == "chain-cap" ? "stopped at the chain cap" : "asked you a question")
        } else if state == .waiting, let w = e.waitingOn {
            let what = w.kind == "wakeup" ? "a wakeup" : "a job"
            if let since = w.since.flatMap(SessionLedger.parseISO) {
                parts.append("Waiting on \(what) · \(elapsed(since))")
            } else {
                parts.append("Waiting on \(what)")
            }
        } else if state == .done {
            parts.append(e.lastTurnAt.map { "Done · \(elapsed($0)) ago" } ?? "Done")
        } else if e.isLive, let since = e.liveSince {
            parts.append("\(e.activityLabel ?? "running") \(elapsed(since))")
        } else if e.isLive, let label = e.activityLabel {
            parts.append(label)
        } else if let at = e.lastTurnAt {
            parts.append(elapsed(at) + " ago")
        }
        return parts.joined(separator: " · ")
    }

    /// ADR-0124 — "3/8 steps · updated 12m ago", with a ⚠︎ when the list has
    /// stopped moving while the tab kept working.
    private func planLabel(_ p: SessionPlanProgress, _ e: SessionEntry) -> String {
        var label = "\(p.done)/\(p.total) steps"
        if let at = p.lastTodoAt, let d = SessionLedger.parseISO(at) {
            label += " · updated \(elapsed(d)) ago"
            let activity = e.isLive ? registry.now : e.lastTurnAt
            if p.isStale(now: registry.now, lastActivity: activity) { label = "⚠︎ " + label }
        }
        return label
    }

    /// ADR-0124 — "graph 12 · reads 30 (2.5×)". Reads are Read/Grep and shell
    /// reads together; the ratio is reads per graph call.
    private func graphUsageLabel(_ u: SessionGraphUsage) -> String {
        let reads = u.fileReads + u.bashReads
        guard let r = u.ratio else { return "graph 0 · reads \(reads)" }
        return "graph \(u.graphCalls) · reads \(reads) (\(String(format: "%.1f", r))×)"
    }

    private func help(_ e: SessionEntry) -> String {
        var lines = [e.id]
        if let path = e.tree?.path { lines.append(path) }
        if let u = e.graphUsage {
            lines.append("graph calls \(u.graphCalls) · Read/Grep \(u.fileReads) · shell reads \(u.bashReads)")
        }
        if let p = e.plan, p.seeded == true { lines.append("plan seeded by MARVIN from the brief") }
        return lines.joined(separator: "\n")
    }

    private func elapsed(_ date: Date) -> String {
        let s = Int(max(0, registry.now.timeIntervalSince(date)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }
}

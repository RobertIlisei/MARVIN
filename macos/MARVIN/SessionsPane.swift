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

struct SessionsPane: View {
    @Environment(MarvinBridge.self) private var bridge
    private let registry = SessionRegistry.shared
    @State private var expandedIdle = false

    var body: some View {
        content
            .modifier(PaneGeometryProbe(name: "SessionsPane"))
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                header
                if rows.isEmpty {
                    Text(bridge.activeProjectId == nil ? "Open a project to see its sessions." : "No sessions yet — press + in the chat to start one.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                } else {
                    section("Needs you", rows(where: { if case .needsYou = $0 { return true } else { return false } }), tint: .orange)
                    section("Working", rows(where: { $0 == .working }), tint: GitDecorationColor.modified)
                    section("Interrupted", rows(where: { $0 == .interrupted }), tint: .orange)
                    section("Failed", rows(where: { $0 == .failed }), tint: GitDecorationColor.deleted)
                    idleSection
                    integrateSection
                    recentSection
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
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
        return ids.compactMap { id -> Row? in
            let entry = registry.entry(id) ?? SessionEntry(id: id)
            return Row(id: id, entry: entry, state: registry.rowState(id))
        }
    }

    private func rows(where match: (SessionRowState) -> Bool) -> [Row] {
        rows.filter { match($0.state) }
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

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.stack")
                .font(.system(size: 12, weight: .semibold))
            Text("Sessions")
                .font(.system(size: 13, weight: .semibold))
            Spacer()
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
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.plain)
            .help("New chat tab (⌘⇧N)")
            Button {
                registry.refreshSnapshot()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10, weight: .medium))
            }
            .buttonStyle(.plain)
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
        let idle = rows(where: { $0 == .idle || $0 == .draft })
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
                sectionHeader("Recent", count: items.count, tint: .secondary)
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
                            .buttonStyle(.plain)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Color.accentColor)
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
                    }
                    .buttonStyle(.plain)
                    .help("Re-run the dry-run preview")
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
                Text(title(e))
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(integrateSubtitle(e, preview: preview))
                    .font(.system(size: 9.5))
                    .foregroundStyle(preview?.isConflict == true ? Color.orange : MarvinTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if needsSync {
                smallAction("Sync", tint: .orange) { Task { await registry.sync(e.id) } }
                    .help("Ask this tab to merge \(registry.integrationTarget ?? "the current branch") into its branch in its own worktree, resolve conflicts, test, and commit. Never pushes.")
            }
            smallAction("Merge", tint: GitDecorationColor.added) { Task { await registry.mergeKept(e.id) } }
                .help("Merge \(w?.branch ?? "this branch") into \(registry.integrationTarget ?? "the current branch"), locally. Never pushes.")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .help([e.id, w?.branch, e.tree?.path].compactMap { $0 }.joined(separator: "\n"))
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
            Button("Discard branch", role: .destructive) { Task { await registry.discardKept(e.id) } }
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

    @ViewBuilder
    private func integrateFooter(_ items: [SessionEntry]) -> some View {
        let conflicts = items.filter { e in e.worktree.flatMap { registry.integrationPreview[$0.slug] }?.isConflict == true }.count
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                if items.count > 1 {
                    Button("Merge all") { Task { await registry.mergeAllKept() } }
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(GitDecorationColor.added)
                        .disabled(registry.integrationBusy)
                        .help("Fold all \(items.count) branches into \(registry.integrationTarget ?? "the current branch"), oldest first, locally. Stops at the first conflict. Never pushes.")
                }
                Button("Prepare MR…") { bridge.requestSourceControl(.prepareMR) }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.accentColor)
                    .help("Squash the branches you pick into one commit on a new mr/… branch, then push and open one merge request (ADR-0109).")
                Spacer()
                if conflicts > 0 {
                    Text("\(conflicts) would conflict — Sync first")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 2)
            if let notice = registry.integrationNotice {
                Text(notice)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(3)
                    .padding(.horizontal, 14)
                    .textSelection(.enabled)
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int, tint: Color) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(.secondary)
                .tracking(0.4)
            Text("\(count)")
                .font(.system(size: 9, weight: .semibold))
                .monospacedDigit()
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Capsule().fill(tint.opacity(0.18)))
                .foregroundStyle(tint)
        }
        .padding(.top, 4)
    }

    // MARK: - Row

    private func sessionRow(_ row: Row) -> some View {
        let e = row.entry
        let selected = row.id == bridge.activeMarvinSessionId
        return HStack(spacing: 6) {
            Circle()
                .fill(ChatPreviewView.tabTint(row.state))
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(title(e))
                    .font(.system(size: 11, weight: selected ? .semibold : .regular))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle(e, state: row.state))
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            action(for: row)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture { bridge.requestChatTab(.select(row.id)) }
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(selected ? Color(nsColor: .textBackgroundColor) : Color.clear)
        )
        .help(help(e))
        .contextMenu {
            Button("Switch to") { bridge.requestChatTab(.select(row.id)) }
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

    @ViewBuilder
    private func action(for row: Row) -> some View {
        switch row.state {
        case .needsYou:
            smallAction("Answer", tint: .orange) { bridge.requestChatTab(.select(row.id)) }
        case .working:
            smallAction("Stop", tint: GitDecorationColor.deleted) { Task { await registry.stop(row.id) } }
        case .interrupted:
            smallAction("Resume", tint: .orange) { Task { await registry.resume(row.id) } }
        case .failed:
            smallAction("Open", tint: .secondary) { bridge.requestChatTab(.select(row.id)) }
        case .idle, .draft:
            EmptyView()
        }
    }

    private func smallAction(_ label: String, tint: Color, _ action: @escaping () -> Void) -> some View {
        Button(label, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(tint)
    }

    // MARK: - Text

    private func title(_ e: SessionEntry) -> String {
        if e.isDraft { return "New chat" }
        if let t = e.title?.replacingOccurrences(of: "\n", with: " "), !t.trimmingCharacters(in: .whitespaces).isEmpty {
            return t.count > 40 ? String(t.prefix(38)) + "…" : t
        }
        return String(e.id.prefix(8))
    }

    private func subtitle(_ e: SessionEntry, state: SessionRowState) -> String {
        var parts: [String] = []
        if let tree = e.tree, tree.mode == .worktree {
            parts.append("isolated: \(tree.branch ?? "worktree")")
            if let w = e.worktree, w.commits > 0 {
                parts.append("\(w.commits) commit\(w.commits == 1 ? "" : "s")")
                if let b = w.behind, b > 0 { parts.append("behind by \(b)") }
            }
        } else if e.isDraft {
            parts.append("draft")
        } else {
            parts.append("shared")
        }
        if let d = e.diff, d.files > 0 { parts.append("+\(d.added) −\(d.removed)") }
        if let p = e.plan, p.total > 0 { parts.append("plan \(p.done)/\(p.total)") }
        if let c = e.costUsd, c > 0 { parts.append(String(format: "$%.2f", c)) }
        if case .needsYou = state, let first = e.pendingConfirms.values.first {
            parts.append("waiting: \(first.toolName)")
        } else if e.isLive, let since = e.liveSince {
            parts.append("\(e.activityLabel ?? "running") \(elapsed(since))")
        } else if e.isLive, let label = e.activityLabel {
            parts.append(label)
        } else if let at = e.lastTurnAt {
            parts.append(elapsed(at) + " ago")
        }
        return parts.joined(separator: " · ")
    }

    private func help(_ e: SessionEntry) -> String {
        var lines = [e.id]
        if let path = e.tree?.path { lines.append(path) }
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

// AppStatusBar — Phase 5f. Global app-wide bottom strip, Cursor /
// VS Code style. Spans the full window width below all panes so the
// transition from app content to window bottom is one continuous
// chrome surface (instead of the abrupt cut where each pane ended on
// its own background).
//
// Reads everything off MarvinBridge so individual panes don't need to
// know about it — the editor's Coordinator pushes cursor row:col via
// `bridge.setCursor(...)`, the Files API pushes branch state via
// `branch-changed`, etc. One observer pattern, one source of truth.
//
// Layout mirrors Cursor's bottom bar:
//
//   ⏺ online · main● · my-project · ⊗0 ⚠0   …   Ln 1, Col 1 · Spaces: 4 · UTF-8 · LF · Swift · 🔔
//
// Sections:
//   • LEFT  — connection pip, branch (with dirty pip), project name,
//             diagnostic counters (placeholders for now — wired when
//             diagnostics land).
//   • RIGHT — cursor row:col (when a file is open), indent style,
//             encoding, line ending, file type, notification bell.
//
// Segments that drive a workflow open a menu / popover on click —
// project name opens the project switcher, connection pip refreshes
// the health probe, cost opens the daily history popover. Status-only
// segments (cursor pos, encoding, line ending, file type) stay
// passive. Cursor's bottom bar uses the same split — most segments
// are clickable shortcuts to settings, a few are read-only labels.

import SwiftUI
import MARVINLogic

/// Which edge these popovers emerge from.
///
/// `AppStatusBar` is the GLOBAL BOTTOM STRIP, so `.bottom` — the SwiftUI
/// default direction for "below the anchor" — pushes a popover off the bottom
/// of the screen and behind the Dock. Four of the five were `.bottom` and
/// opened into the Dock, clipped and unreachable: the context-window panel
/// lost its lower half, which is exactly where its per-section numbers live
/// (user, 2026-08-30). The bell was already `.top` and was the one nobody
/// reported. A bar pinned to the bottom opens UPWARD; there is no case here
/// where `.bottom` is right, so it is a constant rather than a per-call
/// choice.
private let statusBarPopoverEdge: Edge = .top



struct AppStatusBar: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(HealthMonitor.self) private var health

    @State private var costPopoverOpen = false
    @State private var bellPopoverOpen = false
    @State private var contextPopoverOpen = false
    @State private var activityPopoverOpen = false
    @State private var subagentPopoverOpen = false
    /// Branch quick-pick. Hosted here as well as in the SCM panel
    /// because the status bar is where the reference puts it — and
    /// where the user went looking for it first.
    @State private var branchPickerOpen = false
    /// Sync runs from the bar too, so it needs its own confirm plumbing
    /// rather than reaching into the panel's model (the panel may not
    /// even be the visible tab).
    @State private var statusBarRunner = GitOpRunner()

    var body: some View {
        HStack(spacing: 0) {
            leftCluster
            Spacer(minLength: 12)
            rightCluster
        }
        .padding(.horizontal, 10)
        .frame(height: 22)
        .background(MarvinTheme.background)
        .overlay(alignment: .top) {
            // Hairline divider above the bar so it reads as chrome,
            // not part of the pane that sits above it.
            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(height: 0.5)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary)
        .sheet(isPresented: $branchPickerOpen) {
            GitRefPickerSheet(cwd: bridge.projectWorkDir ?? "")
        }
        .sheet(item: Bindable(statusBarRunner).pendingConfirm) { pending in
            GitConfirmSheet(
                actionVerb: pending.actionVerb,
                reason: pending.reason,
                severity: pending.severity,
                paths: pending.paths,
                onConfirm: pending.confirm,
                onCancel: pending.cancel
            )
        }
    }

    // MARK: - Left cluster

    private var leftCluster: some View {
        HStack(spacing: 10) {
            connectionPip
            if let branch = bridge.branch, !branch.isEmpty {
                MarvinDivider().frame(height: 10)
                branchSegment(branch: branch)
                syncSegment
            }
            MarvinDivider().frame(height: 10)
            projectSegment
            if bridge.errorCount > 0 || bridge.warningCount > 0 {
                MarvinDivider().frame(height: 10)
                diagnosticCounters
            }
        }
    }

    private var diagnosticCounters: some View {
        Button {
            NativePrefs.shared.revealPane(.problems)
        } label: {
            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    Image(systemName: "xmark.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(bridge.errorCount > 0 ? Color.red : Color.secondary)
                    Text("\(bridge.errorCount)")
                        .foregroundStyle(bridge.errorCount > 0 ? Color.red : Color.secondary)
                }
                HStack(spacing: 3) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 10))
                        .foregroundStyle(bridge.warningCount > 0 ? Color.orange : Color.secondary)
                    Text("\(bridge.warningCount)")
                        .foregroundStyle(bridge.warningCount > 0 ? Color.orange : Color.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .help("\(bridge.errorCount) error\(bridge.errorCount == 1 ? "" : "s"), \(bridge.warningCount) warning\(bridge.warningCount == 1 ? "" : "s") · click to toggle Problems panel")
    }

    /// Connection status — clicking re-probes /api/health (replaces
    /// the toolbar's old refresh-on-click button).
    private var connectionPip: some View {
        Button {
            Task { await health.refreshNow() }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 7, height: 7)
                Text(connectionLabel)
            }
        }
        .buttonStyle(.plain)
        .help("Sidecar — \(ServerConfig.baseURLString) · click to re-probe")
    }

    /// Project switcher — clicking opens a Menu with project list,
    /// "Open Project…", and "Reveal in Finder" (mirrors the old
    /// ProjectPickerToolbarItem the toolbar used to host).
    @ViewBuilder
    private var projectSegment: some View {
        Menu {
            Section("Switch project") {
                if bridge.projects.isEmpty {
                    Text("(no projects yet)")
                        .foregroundStyle(.tertiary)
                } else {
                    ForEach(bridge.projects) { project in
                        Button {
                            // ADR-0021 M2: ProjectsService owns project switching.
                            Task { try? await ProjectsService.shared.setActive(id: project.id) }
                        } label: {
                            HStack {
                                if project.workDir == bridge.projectWorkDir {
                                    Image(systemName: "checkmark")
                                }
                                Text(project.name)
                            }
                        }
                    }
                }
            }
            Divider()
            Button("Open Project…") {
                openProjectWithPanel()
            }
            if let workDir = bridge.projectWorkDir {
                Divider()
                Button("Reveal in Finder") {
                    let url = URL(fileURLWithPath: workDir)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder")
                    .font(.system(size: 10))
                Text(bridge.projectName ?? "no project")
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Switch project · ⌘O to open another")
    }

    private var connectionColor: Color {
        switch health.state {
        case .connecting: return .secondary
        case .online:     return .green
        case .offline:    return .orange
        }
    }

    private var connectionLabel: String {
        switch health.state {
        case .connecting: return "connecting"
        case .online:     return "online"
        case .offline:    return "offline"
        }
    }

    /// Branch name — a BUTTON, opening the ref quick-pick.
    ///
    /// It rendered as a label until now, which is why clicking it did
    /// nothing: `/api/git/branch`, `/branch/create`, `/branch/switch`
    /// and `/branch/delete` had all shipped with ADR-0012 M2 and no
    /// Swift caller ever reached them.
    private func branchSegment(branch: String) -> some View {
        Button {
            branchPickerOpen = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10))
                Text(branch)
                    .lineLimit(1)
                    .truncationMode(.middle)
                // `*` for a dirty tree, matching the reference's
                // "chore/backlog-audit-and-easy-wins*". The old dot
                // sat in the same place and meant the same thing.
                if bridge.branchDirtyCount > 0 {
                    Text("*").foregroundStyle(GitDecorationColor.modified)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(branchHelp)
    }

    private var branchHelp: String {
        var parts = ["Checkout / create a branch"]
        if bridge.branchDirtyCount > 0 {
            parts.append(
                "\(bridge.branchDirtyCount) uncommitted change\(bridge.branchDirtyCount == 1 ? "" : "s")"
            )
        }
        if let upstream = bridge.branchUpstream {
            parts.append("tracking \(upstream)")
        }
        return parts.joined(separator: " · ")
    }

    /// Sync control — the counts plus a one-click pull-then-push. The
    /// reference shows this immediately right of the branch name and it
    /// is the single most-used git affordance in the whole bar.
    @ViewBuilder
    private var syncSegment: some View {
        if bridge.branchUpstream != nil {
            Button {
                runSync()
            } label: {
                HStack(spacing: 3) {
                    if statusBarRunner.isBusy {
                        ProgressView().controlSize(.small).scaleEffect(0.5)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 10))
                    }
                    if bridge.branchBehind > 0 {
                        Text("\(bridge.branchBehind)↓").font(.system(size: 10, design: .monospaced))
                    }
                    if bridge.branchAhead > 0 {
                        Text("\(bridge.branchAhead)↑").font(.system(size: 10, design: .monospaced))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(statusBarRunner.isBusy)
            .help(syncHelp)
        }
    }

    private var syncHelp: String {
        guard let upstream = bridge.branchUpstream else { return "No upstream" }
        if bridge.branchAhead == 0 && bridge.branchBehind == 0 {
            return "Up to date with \(upstream) · click to fetch and sync"
        }
        return "Sync with \(upstream) — pull \(bridge.branchBehind), push \(bridge.branchAhead)"
    }

    /// Pull then push, sequenced. Same reasoning as the panel's Sync:
    /// firing both at once pushes a branch the pull is still rewriting.
    private func runSync() {
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty else { return }
        Task { @MainActor in
            let pulled = await statusBarRunner.runRemoteAwaiting(
                verb: "pull", cwd: cwd
            ) { token in
                try await FilesService.shared.pull(
                    cwd: cwd, strategy: "ff-only", confirmToken: token
                )
            }
            guard pulled else { return }
            _ = await statusBarRunner.runRemoteAwaiting(
                verb: "push", cwd: cwd
            ) { token in
                try await FilesService.shared.push(cwd: cwd, confirmToken: token)
            }
        }
    }

    // MARK: - Right cluster

    private var rightCluster: some View {
        HStack(spacing: 10) {
            if bridge.selectedFilePath != nil {
                cursorSegment
                MarvinDivider().frame(height: 10)
                indentSegment
                MarvinDivider().frame(height: 10)
                segment(icon: "doc.plaintext", text: "UTF-8")
                MarvinDivider().frame(height: 10)
                segment(icon: "return", text: "LF")
                MarvinDivider().frame(height: 10)
                fileTypeSegment
                MarvinDivider().frame(height: 10)
            }
            activitySegment
            contextSegment
            toolUseSegment
            subagentSegment
            costSegment
            bellSegment
        }
    }

    /// Background activity — scheduled wakeups + running jobs + the
    /// auto-audit tail, with cancel affordances (routes added 2026-07-03;
    /// previously model-only state the UI couldn't see).
    private var activitySegment: some View {
        Button {
            activityPopoverOpen.toggle()
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.system(size: 10))
                Text("activity")
            }
        }
        .buttonStyle(.plain)
        .help("Background jobs, scheduled wakeups, and recent auto-allowed mutations")
        .popover(isPresented: $activityPopoverOpen, arrowEdge: statusBarPopoverEdge) {
            ActivityPopover(
                projectId: bridge.activeProjectId,
                sessionId: bridge.activeMarvinSessionId,
                workDir: bridge.projectWorkDir
            )
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .marvinRequestActivityPopover)
        ) { _ in
            activityPopoverOpen = true
        }
    }

    /// ADR-0022 §2 — context-pressure segment. Shows the current
    /// resident-context-token count with a 4-band colour ramp tuned
    /// for Sonnet 4.x's 200K window. The number is informational —
    /// the user reads the colour to decide whether to start a fresh
    /// session for the next logical task. Clicking the segment opens
    /// a menu with the reset affordance (§3 follow-up). Hidden until
    /// at least one assistant turn has reported usage.
    /// The resolved running model id, preferring what the sidecar actually
    /// reports (carries the `[1m]` marker) over the user's picker selection.
    /// True when Claude runs on the user's own Claude login (a Max / Pro
    /// plan) rather than an API key — then the dollar figures are API-rate
    /// estimates, not a bill, and the plan windows are the real usage.
    private var onSubscription: Bool {
        if case .online(let h) = health.state { return h.auth?.mode == "host-credentials" }
        return false
    }

    private var currentModelId: String? {
        if case .online(let h) = health.state, let m = h.model { return m }
        return bridge.executorModel
    }

    @ViewBuilder
    private var contextSegment: some View {
        if let resident = bridge.residentContextTokens {
            // Prefer what the SDK reported for the running model over an
            // estimate derived from the model id (ADR-0087).
            let window = bridge.reportedContextWindow
                ?? ContextUsageReader.contextWindow(forModelId: currentModelId)
            let band = ContextUsageReader.band(forTokens: resident, window: window)
            let kCtx = (Double(resident) / 1000.0).rounded()
            let billable = bridge.billableThisTurn
            Button {
                contextPopoverOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "gauge.with.dots.needle.50percent")
                        .font(.system(size: 10))
                    Text("ctx \(Int(kCtx))K")
                }
                .foregroundStyle(colour(for: band))
            }
            .buttonStyle(.plain)
            .help(hoverText(resident: resident, billable: billable, band: band))
            .popover(isPresented: $contextPopoverOpen, arrowEdge: statusBarPopoverEdge) {
                ContextDetailPopover(
                    resident: resident,
                    billable: billable,
                    workDir: bridge.projectWorkDir,
                    model: currentModelId,
                    reportedWindow: bridge.reportedContextWindow,
                    personality: bridge.personality,
                    graphCalls: bridge.sessionGraphCalls,
                    fileReadCalls: bridge.sessionFileReadCalls
                )
            }
            MarvinDivider().frame(height: 10)
        }
    }

    /// Map a context band to a foreground SwiftUI colour role. Healthy
    /// and climbing stay in the secondary/tertiary palette so the
    /// segment fades into the bar; high and critical break out into
    /// orange / red so the user notices.
    private func colour(for band: ContextBand) -> AnyShapeStyle {
        switch band {
        case .healthy:  return AnyShapeStyle(.tertiary)
        case .climbing: return AnyShapeStyle(.secondary)
        case .high:     return AnyShapeStyle(Color.orange)
        case .critical: return AnyShapeStyle(Color.red)
        }
    }

    /// 2026-05-27 graphify-drift audit — live counter of graph_* MCP
    /// calls vs Read/Grep/Glob calls in the current SDK session. The
    /// colour signals when MARVIN is bypassing the graphify protocol.
    /// Hidden until at least 5 total tool calls have landed so we don't
    /// distract on idle / trivial turns.
    @ViewBuilder
    private var toolUseSegment: some View {
        let counts = ToolUseCounts(
            graphCalls: bridge.sessionGraphCalls,
            fileReadCalls: bridge.sessionFileReadCalls,
            graphSummaryCalls: bridge.sessionGraphSummaryCalls
        )
        let band = ToolUseCounter.band(counts)
        if band != .idle {
            HStack(spacing: 4) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 10))
                Text("graph \(bridge.sessionGraphCalls) · reads \(bridge.sessionFileReadCalls)")
            }
            .foregroundStyle(toolUseColour(for: band))
            .help(toolUseHover(band: band, counts: counts))
            MarvinDivider().frame(height: 10)
        }
    }

    /// ADR-0080/0081 — live subagent activity: how many were dispatched this
    /// session (by type), how many are running right now. Hidden until the
    /// first dispatch. The user asked to SEE how subagents are used; before
    /// this the only trace was a telemetry line in the sidecar log.
    @ViewBuilder
    private var subagentSegment: some View {
        let s = bridge.subagents.summary
        if s.dispatched > 0 {
            Button {
                subagentPopoverOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "person.2.wave.2")
                        .font(.system(size: 10))
                    Text(s.running > 0 ? "agents \(s.dispatched) · \(s.running) running" : "agents \(s.dispatched)")
                }
                .foregroundStyle(s.running > 0 ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.secondary))
            }
            .buttonStyle(.plain)
            .help("Subagents dispatched this session · click for the breakdown")
            .popover(isPresented: $subagentPopoverOpen, arrowEdge: statusBarPopoverEdge) {
                SubagentStatsPopover(summary: s)
            }
            MarvinDivider().frame(height: 10)
        }
    }

    private func toolUseColour(for band: ToolUseBand) -> AnyShapeStyle {
        switch band {
        case .idle:     return AnyShapeStyle(.tertiary)
        case .healthy:  return AnyShapeStyle(.secondary)
        case .drifting: return AnyShapeStyle(Color.orange)
        case .critical: return AnyShapeStyle(Color.red)
        }
    }

    private func toolUseHover(band: ToolUseBand, counts: ToolUseCounts) -> String {
        var text = "\(band.hint)\n"
        text += "graph: \(counts.graphCalls) (summary \(counts.graphSummaryCalls)) · "
        text += "reads: \(counts.fileReadCalls)\n"
        text += "graphify-first protocol — see CLAUDE.md golden rule 7"
        return text
    }

    private func hoverText(resident: Int, billable: Int?, band: ContextBand) -> String {
        let kCtx = Int((Double(resident) / 1000.0).rounded())
        var text = "\(band.hint)\nctx \(kCtx)K (driving latency)"
        if let b = billable {
            let kB = Int((Double(b) / 1000.0).rounded())
            text += " · \(kB)K new this turn (billable)"
        }
        text += "\nmemory.md auto-loaded · click chat ⌘⇧N to start fresh"
        return text
    }

    /// Indent picker — clicking cycles through 2 / 4 / 8 spaces / Tab.
    /// Persisted via NativePrefs → UserDefaults.
    private var indentSegment: some View {
        Menu {
            Button("2 Spaces")  { NativePrefs.shared.setIndentSize(2) }
            Button("4 Spaces")  { NativePrefs.shared.setIndentSize(4) }
            Button("8 Spaces")  { NativePrefs.shared.setIndentSize(8) }
            Divider()
            Button("Tab")       { NativePrefs.shared.setIndentSize(0) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.right.to.line")
                    .font(.system(size: 10))
                Text(bridge.indentSize == 0 ? "Tab" : "Spaces: \(bridge.indentSize)")
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Indent style — click to change")
    }

    private var cursorSegment: some View {
        let row = bridge.cursorRow
        let col = bridge.cursorCol
        let sel = bridge.cursorSelectionLength
        let lines = bridge.cursorTotalLines
        let cursorText = sel > 0
            ? "Ln \(row), Col \(col) (\(sel) sel)"
            : "Ln \(row), Col \(col)"
        return HStack(spacing: 4) {
            Image(systemName: "text.cursor")
                .font(.system(size: 10))
            Text(cursorText)
            if lines > 0 {
                Text("· \(lines) line\(lines == 1 ? "" : "s")")
                    .foregroundStyle(.tertiary)
            }
        }
        .help("Cursor position")
    }

    private var fileTypeSegment: some View {
        let path = bridge.selectedFilePath ?? ""
        let kind = FileTypeIcon.kind(for: path)
        return HStack(spacing: 4) {
            Image(systemName: FileTypeIcon.symbol(for: kind))
                .font(.system(size: 10))
                .foregroundStyle(FileTypeIcon.color(for: kind))
            Text(fileKindLabel(kind))
        }
        .help("File type")
    }

    @ViewBuilder
    private var costSegment: some View {
        if let cost = bridge.costSummary {
            Button {
                // Opening the panel asks for current numbers — the background
                // poll is paused whenever MARVIN is not frontmost, which is
                // most of the time for a terminal-driven session.
                if !costPopoverOpen { CostService.shared.refreshNow() }
                costPopoverOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "dollarsign.circle")
                        .font(.system(size: 10))
                    Text(fmtCost(cost.today))
                }
            }
            .buttonStyle(.plain)
            .help("Spend today (this project) · click for history")
            .popover(isPresented: $costPopoverOpen, arrowEdge: statusBarPopoverEdge) {
                CostHistoryPopover(summary: cost, subscription: onSubscription)
            }
        }
    }

    private var bellSegment: some View {
        Button {
            bridge.markAllNotificationsRead()
            bellPopoverOpen.toggle()
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: bridge.unreadNotificationCount > 0 ? "bell.badge" : "bell")
                    .font(.system(size: 11))
                    .foregroundStyle(bridge.unreadNotificationCount > 0 ? Color.blue : Color.secondary)
            }
        }
        .buttonStyle(.plain)
        .help("Notifications (\(bridge.unreadNotificationCount) unread)")
        .popover(isPresented: $bellPopoverOpen, arrowEdge: statusBarPopoverEdge) {
            NotificationLogPopover(notifications: bridge.notifications)
        }
    }

    // MARK: - Generic segment

    private func segment(
        icon: String,
        text: String,
        tint: Color = .secondary
    ) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(tint)
            Text(text)
        }
    }

    // MARK: - Formatting

    private func fmtCost(_ v: Double) -> String {
        if v < 0.01 { return String(format: "$%.4f", v) }
        return String(format: "$%.2f", v)
    }

    private func fileKindLabel(_ k: FileTypeIcon.Kind) -> String {
        switch k {
        case .swiftCode:    return "Swift"
        case .typescript:   return "TypeScript"
        case .javascript:   return "JavaScript"
        case .go:           return "Go"
        case .rust:         return "Rust"
        case .python:       return "Python"
        case .ruby:         return "Ruby"
        case .java:         return "Java"
        case .kotlin:       return "Kotlin"
        case .csharp:       return "C#"
        case .cpp:          return "C++"
        case .c:            return "C"
        case .php:          return "PHP"
        case .shell:        return "Shell"
        case .sql:          return "SQL"
        case .markdown:     return "Markdown"
        case .readme:       return "Readme"
        case .json:         return "JSON"
        case .yaml:         return "YAML"
        case .toml:         return "TOML"
        case .xml:          return "XML"
        case .html:         return "HTML"
        case .css:          return "CSS"
        case .scss:         return "SCSS"
        case .dockerfile:   return "Dockerfile"
        case .makefile:     return "Makefile"
        case .envFile:      return "Env"
        case .gitFile:      return "Git"
        case .lockFile:     return "Lockfile"
        case .license:      return "License"
        case .image:        return "Image"
        case .font:         return "Font"
        case .archive:      return "Archive"
        case .binary:       return "Binary"
        case .pdf:          return "PDF"
        case .audio:        return "Audio"
        case .video:        return "Video"
        case .data:         return "Data"
        case .text:         return "Text"
        case .directory:    return "Folder"
        case .unknown:      return "Plain Text"
        }
    }
}

// MARK: - Notification log popover

struct NotificationLogPopover: View {
    let notifications: [MarvinBridge.NotificationEntry]

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Notifications")
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)

            MarvinDivider()

            if notifications.isEmpty {
                Text("No notifications yet.")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .padding(16)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(notifications.reversed().enumerated()), id: \.element.id) { _, entry in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                    .font(.system(size: 12))
                                    .padding(.top, 2)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.message)
                                        .font(.callout)
                                        .lineLimit(2)
                                    Text(Self.timeFormatter.string(from: entry.timestamp))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            MarvinDivider()
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
        .frame(width: 300)
    }
}


/// Breakdown of this session's subagent use (ADR-0080/0081).
struct SubagentStatsPopover: View {
    let summary: SubagentSummary

    private static let order = ["scout", "advisor", "implementer", "graph-extractor", "Explore", "Plan", "general-purpose"]

    private var rows: [(String, Int)] {
        let known = Self.order.compactMap { k in summary.dispatchedByType[k].map { (k, $0) } }
        let other = summary.dispatchedByType.filter { !Self.order.contains($0.key) }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        return known + other
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("subagents this session")
                .font(.caption.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)
            VStack(spacing: 4) {
                ForEach(rows, id: \.0) { name, n in
                    HStack {
                        Text(name)
                        Spacer()
                        Text(n.formatted())
                    }
                }
                MarvinDivider().padding(.vertical, 2)
                HStack { Text("running"); Spacer(); Text(summary.running.formatted()).foregroundStyle(summary.running > 0 ? Color.accentColor : Color.secondary) }
                HStack { Text("in background"); Spacer(); Text(summary.background.formatted()) }
                HStack { Text("completed"); Spacer(); Text(summary.completed.formatted()) }
                if summary.failed > 0 {
                    HStack { Text("failed / stopped"); Spacer(); Text(summary.failed.formatted()).foregroundStyle(.orange) }
                }
            }
            .font(.callout.monospaced())
            Text("scout · advisor · graph-extractor are read-only; implementer writes only in its own worktree (ADR-0081).")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: 300)
    }
}

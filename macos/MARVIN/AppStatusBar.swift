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

struct AppStatusBar: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(HealthMonitor.self) private var health

    @State private var costPopoverOpen = false
    @State private var bellPopoverOpen = false

    var body: some View {
        HStack(spacing: 0) {
            leftCluster
            Spacer(minLength: 12)
            rightCluster
        }
        .padding(.horizontal, 10)
        .frame(height: 22)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .top) {
            // Hairline divider above the bar so it reads as chrome,
            // not part of the pane that sits above it.
            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(height: 0.5)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary)
    }

    // MARK: - Left cluster

    private var leftCluster: some View {
        HStack(spacing: 10) {
            connectionPip
            if let branch = bridge.branch, !branch.isEmpty {
                Divider().frame(height: 10)
                branchSegment(branch: branch)
            }
            Divider().frame(height: 10)
            projectSegment
            if bridge.errorCount > 0 || bridge.warningCount > 0 {
                Divider().frame(height: 10)
                diagnosticCounters
            }
        }
    }

    private var diagnosticCounters: some View {
        Button {
            NativePrefs.shared.togglePane("problems")
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

    private func branchSegment(branch: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10))
            Text(branch)
            if bridge.branchDirtyCount > 0 {
                Text("●")
                    .foregroundStyle(.orange)
                    .help("\(bridge.branchDirtyCount) uncommitted change\(bridge.branchDirtyCount == 1 ? "" : "s")")
            }
        }
    }

    // MARK: - Right cluster

    private var rightCluster: some View {
        HStack(spacing: 10) {
            if bridge.selectedFilePath != nil {
                cursorSegment
                Divider().frame(height: 10)
                indentSegment
                Divider().frame(height: 10)
                segment(icon: "doc.plaintext", text: "UTF-8")
                Divider().frame(height: 10)
                segment(icon: "return", text: "LF")
                Divider().frame(height: 10)
                fileTypeSegment
                Divider().frame(height: 10)
            }
            contextSegment
            toolUseSegment
            costSegment
            bellSegment
        }
    }

    /// ADR-0022 §2 — context-pressure segment. Shows the current
    /// resident-context-token count with a 4-band colour ramp tuned
    /// for Sonnet 4.x's 200K window. The number is informational —
    /// the user reads the colour to decide whether to start a fresh
    /// session for the next logical task. Clicking the segment opens
    /// a menu with the reset affordance (§3 follow-up). Hidden until
    /// at least one assistant turn has reported usage.
    @ViewBuilder
    private var contextSegment: some View {
        if let resident = bridge.residentContextTokens {
            let band = ContextUsageReader.band(forTokens: resident)
            let kCtx = (Double(resident) / 1000.0).rounded()
            let billable = bridge.billableThisTurn
            Menu {
                Section("Context — \(Int(kCtx))K resident") {
                    Text(band.hint)
                    if let b = billable {
                        Text("\(Int((Double(b) / 1000.0).rounded()))K new this turn (billable)")
                    }
                    Text("memory.md auto-loads on every fresh session")
                }
                Divider()
                Button {
                    NotificationCenter.default.post(
                        name: .marvinRequestSdkReset,
                        object: nil
                    )
                } label: {
                    Label("Reset context for next message", systemImage: "arrow.counterclockwise")
                }
                .help("Drops the SDK cache that's making decisions slow. The visible chat stays intact; only the next turn starts fresh.")
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "gauge.with.dots.needle.50percent")
                        .font(.system(size: 10))
                    Text("ctx \(Int(kCtx))K")
                }
                .foregroundStyle(colour(for: band))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(hoverText(resident: resident, billable: billable, band: band))
            Divider().frame(height: 10)
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
            Divider().frame(height: 10)
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
            .popover(isPresented: $costPopoverOpen, arrowEdge: .bottom) {
                CostHistoryPopover(summary: cost)
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
        .popover(isPresented: $bellPopoverOpen, arrowEdge: .top) {
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

            Divider()

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
                            Divider()
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
        .frame(width: 300)
    }
}

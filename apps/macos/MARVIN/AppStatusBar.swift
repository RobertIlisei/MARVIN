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
//   ⏺ online · main● · agri-saas · ⊗0 ⚠0   …   Ln 1, Col 1 · Spaces: 4 · UTF-8 · LF · Swift · 🔔
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

struct AppStatusBar: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(HealthMonitor.self) private var health

    /// Cost popover state — clicking the cost segment opens the
    /// same daily-history popover that used to live behind the
    /// toolbar pill. Local @State because the popover is anchored
    /// to a single segment, not the whole bar.
    @State private var costPopoverOpen = false

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
        }
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
        .help("Sidecar — http://localhost:3030 · click to re-probe")
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
                WebViewCommands.shared.dispatchWebCommand("open-project-picker")
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
                segment(icon: "arrow.right.to.line", text: "Spaces: 4")
                Divider().frame(height: 10)
                segment(icon: "doc.plaintext", text: "UTF-8")
                Divider().frame(height: 10)
                segment(icon: "return", text: "LF")
                Divider().frame(height: 10)
                fileTypeSegment
                Divider().frame(height: 10)
            }
            costSegment
            bellSegment
        }
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
        // Placeholder — no notification system wired yet. Renders as
        // a passive icon so the visual mass of the bar matches Cursor's
        // layout (where the bell sits flush against the right edge).
        Image(systemName: "bell")
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .help("Notifications")
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

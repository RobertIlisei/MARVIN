// DiagnosticsPanelView — the Problems tab.
//
// Modelled on VS Code's PROBLEMS panel, which every fork (Cursor,
// Antigravity, Windsurf) inherits essentially unchanged. What that panel
// actually gives you, and where this now stands:
//
//   • Grouped by FILE, collapsible, with a per-file count      — done here
//   • Severity counts in the header, filterable                — done here
//   • A text filter over messages and paths                    — done here
//   • Click a row → jump to file:line:col                      — done here
//   • Copy a problem / copy all                                — done here
//   • Squiggles in the editor + gutter markers                 — not yet
//   • Quick fixes / code actions on a problem                  — needs LSP
//   • Live push per keystroke                                  — needs LSP
//
// The last three are the same missing piece: VS Code's panel is a passive
// renderer over a diagnostics collection that LANGUAGE SERVERS push into.
// MARVIN shells out to CLIs and parses stdout, so the list is as fresh as
// the last run and can never carry a code action. Closing that gap is a
// real LSP client and its own ADR — not something to sneak in here.
//
// The three empty states are deliberately distinct. The old panel rendered
// one clean checkmark for all of them, which is precisely why a discovery
// bug that ran NO tools read as "your project is clean" (2026-08-31).

import AppKit
import SwiftUI

struct DiagnosticsPanelView: View {
    @Environment(MarvinBridge.self) private var bridge
    /// A computed reference, not `@State`: the service is a singleton the
    /// view observes, not state the view owns. `@Observable` tracks any
    /// property read inside `body` regardless of how the object is held.
    private var service: DiagnosticsService { DiagnosticsService.shared }

    @State private var filterText = ""
    @State private var enabled: Set<DiagnosticItem.Severity> = [.error, .warning, .info, .hint]
    @State private var collapsedFiles: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            header
            MarvinDivider()
            content
        }
        .background(MarvinTheme.panel)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Text("PROBLEMS")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)

            severityChip(.error, "xmark.circle.fill", GitDecorationColor.deleted)
            severityChip(.warning, "exclamationmark.triangle.fill", GitDecorationColor.modified)
            if infoCount > 0 {
                severityChip(.info, "info.circle.fill", .secondary)
            }

            filterField

            Spacer(minLength: 4)

            if service.isRunning {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                    Text(runningLabel)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Button("Stop") { service.cancel() }
                    .buttonStyle(.plain)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            } else {
                // Always visible. It used to render only when the list was
                // NON-empty, so the one state where you most want to re-run —
                // "it says there's nothing, is that true?" — had no button.
                Button {
                    guard let cwd = bridge.projectWorkDir else { return }
                    service.runAll(workDir: cwd)
                } label: {
                    Image(systemName: "play.circle").font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(bridge.projectWorkDir == nil)
                .help("Run all diagnostics, including slow builds")
            }

            Menu {
                Button("Copy All Problems") { copyAll() }
                    .disabled(filtered.isEmpty)
                Divider()
                Button("Collapse All") { collapsedFiles = Set(grouped.map(\.file)) }
                Button("Expand All") { collapsedFiles.removeAll() }
                Divider()
                ForEach(service.discovered) { runner in
                    Text("\(runner.toolchain.id) — \(relative(runner.directory))")
                }
                if service.discovered.isEmpty {
                    Text("No toolchain detected")
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 16)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(MarvinTheme.background)
    }

    private var runningLabel: String {
        let names = service.activeRunners.map { $0.split(separator: "@").first.map(String.init) ?? $0 }
        return names.isEmpty ? "running…" : "running \(names.joined(separator: ", "))…"
    }

    /// Count + toggle in one control, like VS Code's severity filters.
    private func severityChip(
        _ sev: DiagnosticItem.Severity, _ symbol: String, _ tint: Color
    ) -> some View {
        let n = bridge.diagnosticItems.filter { $0.severity == sev }.count
        let on = enabled.contains(sev)
        return Button {
            if on { enabled.remove(sev) } else { enabled.insert(sev) }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 9))
                Text("\(n)").font(.system(size: 10, design: .monospaced))
            }
            .foregroundStyle(on && n > 0 ? AnyShapeStyle(tint) : AnyShapeStyle(.tertiary))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(on ? MarvinTheme.elevated : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .help(on ? "Hide \(sev.rawValue)s" : "Show \(sev.rawValue)s")
    }

    private var filterField: some View {
        HStack(spacing: 4) {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
            TextField("Filter", text: $filterText)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .frame(width: 130)
            if !filterText.isEmpty {
                Button { filterText = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 4).fill(MarvinTheme.elevated))
    }

    // MARK: - Body

    @ViewBuilder
    private var content: some View {
        if bridge.projectWorkDir == nil {
            empty("checkmark.seal", "No project active", nil)
        } else if filtered.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(grouped, id: \.file) { group in
                        fileHeader(group)
                        if !collapsedFiles.contains(group.file) {
                            ForEach(group.items) { row($0) }
                        }
                    }
                }
            }
        }
    }

    /// Three distinct empty states. Collapsing them into one checkmark is
    /// what let a discovery bug masquerade as a clean project for months.
    @ViewBuilder
    private var emptyState: some View {
        if service.isRunning {
            empty("hourglass", runningLabel, nil)
        } else if service.lastRunAt == nil {
            empty(
                "play.circle",
                "Diagnostics haven't run yet",
                "Run diagnostics"
            )
        } else if service.noToolchainFound {
            empty(
                "questionmark.folder",
                "No toolchain detected in this project",
                nil,
                detail: "Looked up to 3 levels down for: "
                    + Toolchain.all.flatMap(\.markers).prefix(8).joined(separator: ", ")
                    + "… Nothing matched, so nothing was run."
            )
        } else if !bridge.diagnosticItems.isEmpty {
            empty("line.3.horizontal.decrease", "No problems match the filter", nil)
        } else {
            empty(
                "checkmark.seal",
                "No problems detected",
                "Run diagnostics",
                detail: ranDetail
            )
        }
    }

    private var ranDetail: String? {
        guard let at = service.lastRunAt else { return nil }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        let tools = service.discovered.map(\.toolchain.id).joined(separator: ", ")
        return tools.isEmpty
            ? "Last run \(f.string(from: at))."
            : "Last run \(f.string(from: at)) — \(tools)."
    }

    private func empty(
        _ symbol: String, _ title: String, _ action: String?, detail: String? = nil
    ) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(.tertiary)
            Text(title).font(.callout).foregroundStyle(.secondary)
            if let detail {
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 460)
            }
            if let action, bridge.projectWorkDir != nil {
                Button(action) {
                    guard let cwd = bridge.projectWorkDir else { return }
                    service.runAll(workDir: cwd)
                }
                .buttonStyle(.link)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    // MARK: - Grouping

    private struct FileGroup { let file: String; let items: [DiagnosticItem] }

    private var infoCount: Int {
        bridge.diagnosticItems.filter { $0.severity == .info || $0.severity == .hint }.count
    }

    private var filtered: [DiagnosticItem] {
        let needle = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        return bridge.diagnosticItems.filter { item in
            guard enabled.contains(item.severity) else { return false }
            guard !needle.isEmpty else { return true }
            return item.message.lowercased().contains(needle)
                || item.filePath.lowercased().contains(needle)
                || item.source.lowercased().contains(needle)
        }
    }

    /// Grouped by file, files ordered by their worst severity then by path —
    /// the file with errors sorts above the file with only warnings.
    private var grouped: [FileGroup] {
        var buckets: [String: [DiagnosticItem]] = [:]
        for item in filtered { buckets[item.filePath, default: []].append(item) }
        return buckets
            .map { FileGroup(file: $0.key, items: $0.value) }
            .sorted { a, b in
                let ra = a.items.map(\.severity.rank).min() ?? 9
                let rb = b.items.map(\.severity.rank).min() ?? 9
                if ra != rb { return ra < rb }
                return a.file < b.file
            }
    }

    private func fileHeader(_ group: FileGroup) -> some View {
        let collapsed = collapsedFiles.contains(group.file)
        return Button {
            if collapsed { collapsedFiles.remove(group.file) }
            else { collapsedFiles.insert(group.file) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.secondary)
                if let glyph = SymbolsIcon.image(
                    forPath: group.file, isDirectory: false, size: 13
                ) {
                    Image(nsImage: glyph).frame(width: 14)
                } else {
                    Image(systemName: "doc").font(.system(size: 10))
                }
                Text((group.file as NSString).lastPathComponent)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textPrimary)
                Text(relative((group.file as NSString).deletingLastPathComponent))
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 4)
                Text("\(group.items.count)")
                    .font(.system(size: 9, design: .monospaced))
                    .padding(.horizontal, 5)
                    .background(Capsule().fill(MarvinTheme.elevated))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .background(MarvinTheme.background)
    }

    private func row(_ item: DiagnosticItem) -> some View {
        Button {
            // `openFileFromChat` is the existing jump-to-line path — it sets
            // `pendingEditorLine`, which the viewer consumes to scroll. The
            // old panel called `setSelectedFile`, which opens the file at the
            // TOP: on a 2,000-line file with an error at line 1,840 that is
            // indistinguishable from the click doing nothing.
            bridge.openFileFromChat(
                path: item.filePath,
                line: item.line > 0 ? item.line : nil
            )
        } label: {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: symbol(for: item.severity))
                    .foregroundStyle(tint(for: item.severity))
                    .font(.system(size: 10))
                    .padding(.top, 1)
                Text(item.message)
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 6)
                Text(item.source)
                    .font(.system(size: 9))
                    .padding(.horizontal, 4)
                    .background(Capsule().fill(MarvinTheme.elevated))
                    .foregroundStyle(.tertiary)
                if item.line > 0 {
                    Text("\(item.line):\(item.col)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
            .padding(.leading, 28)
            .padding(.trailing, 10)
            .padding(.vertical, 3)
        }
        .buttonStyle(DiagnosticRowStyle())
        .contextMenu {
            Button("Copy Message") { copy(item.message) }
            Button("Copy as file:line:col") {
                copy("\(item.filePath):\(item.line):\(item.col)")
            }
            Divider()
            Button("Reveal in Finder") {
                NSWorkspace.shared.selectFile(
                    item.filePath,
                    inFileViewerRootedAtPath: bridge.projectWorkDir ?? "/"
                )
            }
        }
    }

    private func symbol(for s: DiagnosticItem.Severity) -> String {
        switch s {
        case .error: return "xmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info, .hint: return "info.circle.fill"
        }
    }

    private func tint(for s: DiagnosticItem.Severity) -> Color {
        switch s {
        case .error: return GitDecorationColor.deleted
        case .warning: return GitDecorationColor.modified
        case .info, .hint: return .secondary
        }
    }

    private func relative(_ path: String) -> String {
        guard let root = bridge.projectWorkDir else { return path }
        let base = root.hasSuffix("/") ? root : root + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func copyAll() {
        copy(filtered.map {
            "\($0.severity.rawValue.uppercased()) \(relative($0.filePath)):\($0.line):\($0.col) — \($0.message) [\($0.source)]"
        }.joined(separator: "\n"))
    }
}

private struct DiagnosticRowStyle: ButtonStyle {
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(hovering ? MarvinTheme.rowHover : Color.clear)
            .onHover { hovering = $0 }
    }
}

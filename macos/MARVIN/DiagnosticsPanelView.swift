// DiagnosticsPanelView — M8. Bottom-panel "Problems" tab.
// Shows structured diagnostics from DiagnosticsService (tsc/eslint/swift).
// Click a row to navigate to the offending file/line. Mirrors VS Code's
// PROBLEMS panel (errors grouped, then warnings, sorted by file).

import SwiftUI

struct DiagnosticsPanelView: View {
    @Environment(MarvinBridge.self) private var bridge

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            body_
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("PROBLEMS")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)
            Spacer()
            if !bridge.diagnosticItems.isEmpty {
                Button {
                    if let cwd = bridge.projectWorkDir {
                        Task { await DiagnosticsService.shared.refresh(workDir: cwd) }
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderless)
                .help("Re-run diagnostics")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    @ViewBuilder
    private var body_: some View {
        let items = bridge.diagnosticItems
        if items.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.seal")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(.tertiary)
                Text("No problems detected")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if bridge.projectWorkDir != nil {
                    Button("Run diagnostics") {
                        if let cwd = bridge.projectWorkDir {
                            Task { await DiagnosticsService.shared.refresh(workDir: cwd) }
                        }
                    }
                    .buttonStyle(.link)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let errors   = items.filter { $0.severity == .error }
            let warnings = items.filter { $0.severity == .warning }
            let others   = items.filter { $0.severity != .error && $0.severity != .warning }

            ScrollView {
                LazyVStack(spacing: 0) {
                    if !errors.isEmpty {
                        sectionHeader("Errors (\(errors.count))", color: .red)
                        ForEach(errors)   { row(item: $0) }
                    }
                    if !warnings.isEmpty {
                        sectionHeader("Warnings (\(warnings.count))", color: .orange)
                        ForEach(warnings) { row(item: $0) }
                    }
                    if !others.isEmpty {
                        sectionHeader("Info (\(others.count))", color: .secondary)
                        ForEach(others)   { row(item: $0) }
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String, color: Color) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(color)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder
    private func row(item: DiagnosticItem) -> some View {
        Button {
            bridge.setSelectedFile(item.filePath)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: item.severity == .error ? "xmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(item.severity == .error ? Color.red : Color.orange)
                    .font(.system(size: 11))
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.message)
                        .font(.system(size: 11))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    HStack(spacing: 4) {
                        Text(item.displayPath)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                        Text(":\(item.line):\(item.col)")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(RowHoverBG())
        Divider().padding(.leading, 10)
    }
}

private struct RowHoverBG: View {
    @State private var hovered = false
    var body: some View {
        Color(nsColor: hovered ? .selectedControlColor : .clear).opacity(0.3)
            .onHover { hovered = $0 }
    }
}

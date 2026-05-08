// BuildTaskSheet — M7. ⌘⇧B palette. Lists discovered build tasks
// from the project's package.json / Makefile / Package.swift / Cargo.toml.
// Selecting a task opens the terminal pane and runs the command.

import SwiftUI

struct BuildTaskSheet: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    @State private var query: String = ""
    @State private var tasks: [BuildTask] = []
    @State private var selection: BuildTask? = nil
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 13))
                TextField("Run task…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { runSelected() }
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }.buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(nsColor: .underPageBackgroundColor))

            Divider()

            if tasks.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "hammer").font(.system(size: 28)).foregroundStyle(.tertiary)
                    Text("No tasks found")
                        .font(.headline)
                    Text("Add scripts to package.json, Makefile, Package.swift, or Cargo.toml.")
                        .font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: 280)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { task in
                            taskRow(task)
                        }
                    }
                }
                .frame(height: 320)
            }

            HStack {
                Text("\(filtered.count) task\(filtered.count == 1 ? "" : "s")")
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                Spacer()
                Text("↩ run · esc dismiss")
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(nsColor: .underPageBackgroundColor))
        }
        .frame(width: 560)
        .onAppear {
            focused = true
            if let cwd = bridge.projectWorkDir {
                tasks = BuildTaskService.discover(workDir: cwd)
            }
        }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
    }

    private func taskRow(_ task: BuildTask) -> some View {
        let isSelected = selection?.id == task.id
        return Button { run(task) } label: {
            HStack(spacing: 10) {
                // Kind badge
                Text(task.kindLabel)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(kindColor(task.kind).opacity(0.15))
                    .foregroundStyle(kindColor(task.kind))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .frame(width: 42)

                VStack(alignment: .leading, spacing: 2) {
                    Text(task.name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                    if let desc = task.description {
                        Text(desc)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(task.command)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 160)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var filtered: [BuildTask] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return tasks }
        return tasks.filter {
            $0.name.lowercased().contains(q)
            || $0.command.lowercased().contains(q)
            || ($0.description?.lowercased().contains(q) ?? false)
        }
    }

    private func moveSelection(_ delta: Int) {
        let list = Array(filtered)
        guard !list.isEmpty else { return }
        if let current = selection, let i = list.firstIndex(where: { $0.id == current.id }) {
            selection = list[max(0, min(list.count - 1, i + delta))]
        } else {
            selection = list[delta > 0 ? 0 : list.count - 1]
        }
    }

    private func runSelected() {
        if let task = selection ?? filtered.first {
            run(task)
        }
    }

    private func run(_ task: BuildTask) {
        // Ensure the terminal pane is visible.
        if !bridge.panes.terminal {
            NativePrefs.shared.togglePane("terminal")
        }
        // Inject the command into the terminal via a bridge signal.
        MarvinBridge.shared.triggerTerminalCommand(task.command)
        dismiss()
    }

    private func kindColor(_ kind: BuildTask.Kind) -> Color {
        switch kind {
        case .npm, .yarn, .pnpm: return .red
        case .make:              return .orange
        case .swift:             return .blue
        case .cargo:             return .brown
        case .shell:             return .gray
        }
    }
}

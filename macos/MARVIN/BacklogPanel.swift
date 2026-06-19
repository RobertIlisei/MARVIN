// BacklogPanel — ADR-0044.
// A browsable sheet over the project backlog: open/doing items with per-row
// Done / Dismiss / Promote-to-plan / (optional) Export-to-issue, plus a manual
// add row. A PARKING LOT the user revisits — promotion to a turn is always a
// user action (never auto-drained). Mirrors SkillsPane's sheet conventions.

import SwiftUI

struct BacklogPanel: View {
    let workDir: String
    /// Parent seeds a turn from the item (model.sendControl) + flips it to `doing`.
    let onPromote: (BacklogItem) -> Void
    let onClose: () -> Void
    /// Called after any mutation so the tray chip count can refresh.
    let onChanged: () -> Void

    @State private var items: [BacklogItem] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var newTitle = ""

    private var active: [BacklogItem] {
        items.filter { $0.status == "open" || $0.status == "doing" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12).padding(.top, 8)
            }
            content
            Divider()
            addRow
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 380, idealHeight: 520)
        .task { await refresh() }
    }

    private var header: some View {
        HStack {
            Image(systemName: "tray.full")
            Text("Project backlog").font(.headline)
            if !active.isEmpty {
                Text("\(active.count)")
                    .font(.caption.monospacedDigit())
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.blue.opacity(0.15), in: Capsule())
            }
            Spacer()
            Button("Close") { onClose() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder private var content: some View {
        if active.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle").font(.title2).foregroundStyle(.secondary)
                Text("No open backlog items.").font(.callout).foregroundStyle(.secondary)
                Text("Parked follow-ups appear here and resurface next session.")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(active) { item in row(item) }
                }
                .padding(12)
            }
        }
    }

    private func row(_ item: BacklogItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: severityIcon(item.severity))
                .foregroundStyle(severityColor(item.severity))
                .help("severity: \(item.severity)")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title).font(.body.weight(.semibold))
                    if item.status == "doing" {
                        Text("in progress")
                            .font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.orange.opacity(0.15), in: Capsule())
                    }
                }
                if !item.body.isEmpty {
                    Text(item.body).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(3).textSelection(.enabled)
                }
                HStack(spacing: 8) {
                    Button("Promote to plan") { onPromote(item); onClose() }
                        .controlSize(.small)
                    Button("Done") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "done") } } }
                        .controlSize(.small)
                    Button("Dismiss") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "dismissed") } } }
                        .controlSize(.small)
                    Button("Export to issue") { Task { await exportIssue(item) } }
                        .controlSize(.small)
                }
                .padding(.top, 2)
            }
            Spacer()
        }
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            TextField("Add an item…", text: $newTitle)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await addNew() } }
            Button("Add") { Task { await addNew() } }
                .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(12)
    }

    // MARK: - Actions

    private func refresh() async {
        isLoading = true; defer { isLoading = false }
        do { items = try await BacklogService.shared.fetch(workDir: workDir) }
        catch { self.error = "Failed to load backlog: \(error.localizedDescription)" }
    }

    private func mutate(_ op: @escaping () async throws -> Void) async {
        do { try await op(); await refresh(); onChanged() }
        catch { self.error = error.localizedDescription }
    }

    private func addNew() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        newTitle = ""
        await mutate { try await BacklogService.shared.add(workDir: workDir, title: title, body: nil, severity: nil) }
    }

    private func exportIssue(_ item: BacklogItem) async {
        do {
            let url = try await BacklogService.shared.promoteIssue(workDir: workDir, id: item.id)
            error = "Filed: \(url)"
            await refresh(); onChanged()
        } catch {
            self.error = "Export failed: \(error.localizedDescription)"
        }
    }

    private func severityIcon(_ s: String) -> String {
        switch s {
        case "high": return "exclamationmark.2"
        case "low": return "minus.circle"
        default: return "circle.fill"
        }
    }
    private func severityColor(_ s: String) -> Color {
        switch s {
        case "high": return .red
        case "low": return .secondary
        default: return .orange
        }
    }
}

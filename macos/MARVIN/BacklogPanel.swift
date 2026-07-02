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
    /// Item opened in the detail sheet (severity/body editing, resolve
    /// with note). Nested sheet on the panel sheet — macOS stacks fine.
    @State private var detailItem: BacklogItem?

    private var active: [BacklogItem] {
        items.filter { $0.status == "open" || $0.status == "doing" }
    }
    /// ADR-0047 — auto-captured items awaiting the user's keep/dismiss.
    private var provisional: [BacklogItem] {
        items.filter { $0.status == "provisional" }
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
        .sheet(item: $detailItem) { item in
            BacklogDetailView(
                workDir: workDir,
                item: item,
                onPromote: { onPromote($0); detailItem = nil; onClose() },
                onChanged: {
                    Task { await refresh(); onChanged() }
                },
                onDismissSheet: { detailItem = nil }
            )
        }
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
        if active.isEmpty && provisional.isEmpty {
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
                    if !provisional.isEmpty { provisionalSection }
                    ForEach(active) { item in row(item) }
                }
                .padding(12)
            }
        }
    }

    /// ADR-0047 — items auto-captured this/last session, surfaced for a quick
    /// keep/dismiss pass so the parking lot doesn't accrete unreviewed noise.
    private var provisionalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle").foregroundStyle(.purple)
                Text("Auto-captured — review").font(.subheadline.weight(.semibold))
                Text("\(provisional.count)")
                    .font(.caption.monospacedDigit())
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.purple.opacity(0.15), in: Capsule())
                Spacer()
                Button("Keep all") {
                    Task { await mutate { for i in provisional { try await BacklogService.shared.setStatus(workDir: workDir, id: i.id, status: "open") } } }
                }
                .controlSize(.small)
                Button("Dismiss all") {
                    Task { await mutate { for i in provisional { try await BacklogService.shared.setStatus(workDir: workDir, id: i.id, status: "dismissed") } } }
                }
                .controlSize(.small)
            }
            ForEach(provisional) { item in provisionalRow(item) }
            Divider().padding(.vertical, 2)
        }
    }

    private func provisionalRow(_ item: BacklogItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: severityIcon(item.severity))
                .foregroundStyle(severityColor(item.severity))
                .help("severity: \(item.severity)")
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.body.weight(.semibold))
                if !item.body.isEmpty {
                    Text(item.body).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(3).textSelection(.enabled)
                }
                HStack(spacing: 8) {
                    Button("Keep") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "open") } } }
                        .controlSize(.small)
                    Button("Dismiss") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "dismissed") } } }
                        .controlSize(.small)
                }
                .padding(.top, 2)
            }
            Spacer()
        }
        .padding(8)
        .background(Color.purple.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
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
                    Image(systemName: "chevron.right.circle")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .help("Open details")
                }
                if !item.body.isEmpty {
                    Text(item.body).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(3).textSelection(.enabled)
                }
                HStack(spacing: 8) {
                    Button("Details") { detailItem = item }
                        .controlSize(.small)
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
        .contentShape(RoundedRectangle(cornerRadius: 6))
        .onTapGesture { detailItem = item }
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

/// Detail sheet for one backlog item: full body (editable), severity
/// picker, resolve with an optional note, promote/export. Title stays
/// read-only — the slug/id/filename derive from it, so a rename is a
/// new item, not an edit (backlog.ts `updateBacklogItem`).
struct BacklogDetailView: View {
    let workDir: String
    let item: BacklogItem
    let onPromote: (BacklogItem) -> Void
    /// Parent refreshes its list + the tray chip after any mutation.
    let onChanged: () -> Void
    let onDismissSheet: () -> Void

    @State private var severity: String
    @State private var bodyText: String
    @State private var resolveNote = ""
    @State private var error: String?
    @State private var savedFlash = false

    init(workDir: String, item: BacklogItem,
         onPromote: @escaping (BacklogItem) -> Void,
         onChanged: @escaping () -> Void,
         onDismissSheet: @escaping () -> Void) {
        self.workDir = workDir
        self.item = item
        self.onPromote = onPromote
        self.onChanged = onChanged
        self.onDismissSheet = onDismissSheet
        _severity = State(initialValue: item.severity)
        _bodyText = State(initialValue: item.body)
    }

    private var bodyDirty: Bool { bodyText != item.body }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    metaRow
                    bodyEditor
                    resolveSection
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
                .padding(14)
            }
        }
        .frame(minWidth: 480, idealWidth: 540, minHeight: 360, idealHeight: 440)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "tray.full")
            Text(item.title)
                .font(.headline)
                .lineLimit(2)
                .textSelection(.enabled)
                .help("Titles are immutable — the item's id derives from the title.")
            Spacer()
            Button("Close") { onDismissSheet() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var metaRow: some View {
        HStack(spacing: 12) {
            Picker("Severity", selection: $severity) {
                Text("low").tag("low")
                Text("med").tag("med")
                Text("high").tag("high")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 220)
            .onChange(of: severity) { _, next in
                guard next != item.severity else { return }
                Task { await save(severity: next) }
            }
            Text(item.status)
                .font(.caption)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.blue.opacity(0.12), in: Capsule())
            Spacer()
            Text("added \(item.created.prefix(10))")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var bodyEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Details").font(.subheadline.weight(.semibold))
                Spacer()
                if savedFlash {
                    Text("Saved").font(.caption).foregroundStyle(.green)
                }
                Button("Save details") { Task { await save(body: bodyText) } }
                    .controlSize(.small)
                    .disabled(!bodyDirty)
            }
            TextEditor(text: $bodyText)
                .font(.system(size: 12))
                .frame(minHeight: 140)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                )
        }
    }

    private var resolveSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Resolve").font(.subheadline.weight(.semibold))
            TextField("Optional note (appended to the item)", text: $resolveNote)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Promote to plan") { onPromote(item) }
                Button("Done") { Task { await resolve("done") } }
                Button("Dismiss") { Task { await resolve("dismissed") } }
                if item.status == "doing" {
                    Button("Back to open") { Task { await resolve("open") } }
                }
                Spacer()
            }
            .controlSize(.small)
        }
    }

    // MARK: - Actions

    private func save(severity: String? = nil, body: String? = nil) async {
        do {
            try await BacklogService.shared.update(
                workDir: workDir, id: item.id, severity: severity, body: body)
            onChanged()
            if body != nil {
                savedFlash = true
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                savedFlash = false
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func resolve(_ status: String) async {
        do {
            // Persist an unsaved body edit first so it isn't lost, then
            // transition (the note appends to the just-saved body).
            if bodyDirty {
                try await BacklogService.shared.update(workDir: workDir, id: item.id, body: bodyText)
            }
            let note = resolveNote.trimmingCharacters(in: .whitespaces)
            try await BacklogService.shared.setStatus(
                workDir: workDir, id: item.id, status: status,
                note: note.isEmpty ? nil : note)
            onChanged()
            onDismissSheet()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

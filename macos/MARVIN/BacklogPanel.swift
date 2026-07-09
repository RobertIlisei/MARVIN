// BacklogPanel — ADR-0044.
// A browsable sheet over the project backlog: open/doing items with per-row
// Done / Dismiss / Promote-to-plan / (optional) Export-to-issue, plus a manual
// add row. A PARKING LOT the user revisits — promotion to a turn is always a
// user action (never auto-drained). Mirrors SkillsPane's sheet conventions.

import SwiftUI

/// How the active list is ordered. Persisted via @AppStorage.
enum BacklogSort: String, CaseIterable, Identifiable {
    case severity, newest, oldest, title
    var id: String { rawValue }
    var label: String {
        switch self {
        case .severity: return "Severity"
        case .newest:   return "Newest"
        case .oldest:   return "Oldest"
        case .title:    return "Title"
        }
    }
}

/// Optional banding of the active list.
enum BacklogGroup: String, CaseIterable, Identifiable {
    case none, severity, status
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none:     return "None"
        case .severity: return "Severity"
        case .status:   return "Status"
        }
    }
}

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

    // Sort / group / filter — persisted so the user's view survives a
    // relaunch (mirrors the localStorage-backed prefs the web shell used).
    @AppStorage("marvin.backlog.sort")  private var sort: BacklogSort = .severity
    @AppStorage("marvin.backlog.group") private var group: BacklogGroup = .none
    @AppStorage("marvin.backlog.showHigh")     private var showHigh = true
    @AppStorage("marvin.backlog.showMed")      private var showMed = true
    @AppStorage("marvin.backlog.showLow")      private var showLow = true
    @AppStorage("marvin.backlog.showResolved") private var showResolved = false

    /// Actionable items (open+doing), unfiltered — drives the header badge.
    private var active: [BacklogItem] {
        items.filter { $0.status == "open" || $0.status == "doing" }
    }
    /// ADR-0047 — auto-captured items awaiting the user's keep/dismiss.
    private var provisional: [BacklogItem] {
        items.filter { $0.status == "provisional" }
    }

    /// Any non-provisional item exists → the sort/group/filter strip is worth
    /// showing (and an empty visible-set means "filtered out", not "empty").
    private var hasControllable: Bool {
        items.contains { ["open", "doing", "done", "dismissed"].contains($0.status) }
    }

    /// The active list after status-scope + severity filter + sort. Provisional
    /// items are handled in their own review band and never appear here.
    private var visible: [BacklogItem] {
        items
            .filter { item in
                switch item.status {
                case "open", "doing":     return true
                case "done", "dismissed": return showResolved
                default:                  return false
                }
            }
            .filter { severityAllowed($0.severity) }
            .sorted(by: sortComparator)
    }

    /// Grouped view of `visible`. `.none` collapses to a single untitled band.
    private var groupedSections: [(title: String, items: [BacklogItem])] {
        let v = visible
        switch group {
        case .none:
            return [("", v)]
        case .severity:
            return ["high", "med", "low"].compactMap { sev in
                let g = v.filter { $0.severity == sev }
                return g.isEmpty ? nil : (severityLabel(sev), g)
            }
        case .status:
            return ["doing", "open", "done", "dismissed"].compactMap { st in
                let g = v.filter { $0.status == st }
                return g.isEmpty ? nil : (statusLabel(st), g)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if hasControllable {
                controlStrip
                Divider()
            }
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

    /// Sort / group / filter menus. Compact borderless-button menus so the
    /// strip reads as chrome, not primary content.
    private var controlStrip: some View {
        HStack(spacing: 14) {
            Menu {
                Picker("Sort", selection: $sort) {
                    ForEach(BacklogSort.allCases) { Text($0.label).tag($0) }
                }
            } label: {
                Label("Sort: \(sort.label)", systemImage: "arrow.up.arrow.down")
            }
            .menuStyle(.borderlessButton).fixedSize()

            Menu {
                Picker("Group", selection: $group) {
                    ForEach(BacklogGroup.allCases) { Text($0.label).tag($0) }
                }
            } label: {
                Label("Group: \(group.label)", systemImage: "square.stack.3d.up")
            }
            .menuStyle(.borderlessButton).fixedSize()

            Menu {
                Section("Severity") {
                    Toggle("High", isOn: $showHigh)
                    Toggle("Med",  isOn: $showMed)
                    Toggle("Low",  isOn: $showLow)
                }
                Divider()
                Toggle("Show resolved", isOn: $showResolved)
            } label: {
                Label(filterLabel, systemImage: "line.3.horizontal.decrease.circle")
            }
            .menuStyle(.borderlessButton).fixedSize()

            Spacer()
        }
        .font(.caption)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.4))
    }

    @ViewBuilder private var content: some View {
        if visible.isEmpty && provisional.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle").font(.title2).foregroundStyle(.secondary)
                if hasControllable {
                    // Items exist but the filter hides them all.
                    Text("No items match the current filter.").font(.callout).foregroundStyle(.secondary)
                    Text("Loosen the severity filter, or turn on “Show resolved”.")
                        .font(.caption).foregroundStyle(.tertiary)
                } else {
                    Text("No open backlog items.").font(.callout).foregroundStyle(.secondary)
                    Text("Parked follow-ups appear here and resurface next session.")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if !provisional.isEmpty { provisionalSection }
                    ForEach(groupedSections, id: \.title) { section in
                        if !section.title.isEmpty {
                            groupHeader(section.title, count: section.items.count)
                        }
                        ForEach(section.items) { item in row(item) }
                    }
                }
                .padding(12)
            }
        }
    }

    private func groupHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("\(count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(.top, 4)
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
        let resolved = item.status == "done" || item.status == "dismissed"
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: severityIcon(item.severity))
                .foregroundStyle(severityColor(item.severity))
                .help("severity: \(item.severity)")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title).font(.body.weight(.semibold))
                        .strikethrough(resolved, color: .secondary)
                    if item.status == "doing" {
                        statusBadge("in progress", .orange)
                    } else if resolved {
                        statusBadge(item.status, .secondary)
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
                    if resolved {
                        Button("Reopen") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "open") } } }
                            .controlSize(.small)
                    } else {
                        Button("Promote to plan") { onPromote(item); onClose() }
                            .controlSize(.small)
                        Button("Done") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "done") } } }
                            .controlSize(.small)
                        Button("Dismiss") { Task { await mutate { try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "dismissed") } } }
                            .controlSize(.small)
                        Button("Export to issue") { Task { await exportIssue(item) } }
                            .controlSize(.small)
                    }
                }
                .padding(.top, 2)
            }
            Spacer()
        }
        .opacity(resolved ? 0.6 : 1)
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
        .contentShape(RoundedRectangle(cornerRadius: 6))
        .onTapGesture { detailItem = item }
    }

    private func statusBadge(_ text: String, _ tint: Color) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(tint.opacity(0.15), in: Capsule())
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

    // MARK: - Sort / group / filter helpers

    private func sortComparator(_ a: BacklogItem, _ b: BacklogItem) -> Bool {
        switch sort {
        case .severity:
            let ra = severityRank(a.severity), rb = severityRank(b.severity)
            if ra != rb { return ra < rb }
            return a.created > b.created          // tiebreak: newest first
        case .newest: return a.created > b.created
        case .oldest: return a.created < b.created
        case .title:  return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
        }
    }

    private func severityRank(_ s: String) -> Int {
        switch s { case "high": return 0; case "med": return 1; default: return 2 }
    }

    private func severityAllowed(_ s: String) -> Bool {
        switch s { case "high": return showHigh; case "low": return showLow; default: return showMed }
    }

    private func severityLabel(_ s: String) -> String {
        switch s { case "high": return "High"; case "med": return "Med"; case "low": return "Low"; default: return s.capitalized }
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "doing":     return "In progress"
        case "open":      return "Open"
        case "done":      return "Done"
        case "dismissed": return "Dismissed"
        default:          return s.capitalized
        }
    }

    /// Menu label reflecting active filters, so a non-default filter is
    /// visible without opening the menu.
    private var filterLabel: String {
        var parts: [String] = []
        if !(showHigh && showMed && showLow) {
            let on = ["high", "med", "low"].filter(severityAllowed)
            parts.append(on.isEmpty ? "none" : on.map(severityLabel).joined(separator: "/"))
        }
        if showResolved { parts.append("+resolved") }
        return parts.isEmpty ? "Filter" : "Filter: \(parts.joined(separator: " "))"
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

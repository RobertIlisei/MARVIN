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
    case none, severity, status, kind
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none:     return "None"
        case .severity: return "Severity"
        case .status:   return "Status"
        case .kind:     return "Kind"
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
    /// Possible-duplicate notice after a manual add (ADR-0044 addendum).
    /// Separate from `error` because the add SUCCEEDED — conflating the two
    /// would read as a rejection.
    @State private var duplicateHint: String?
    /// Groom findings (ADR-0063), keyed to items by id. Empty until the user
    /// presses Review; cleared explicitly. Purely an annotation layer — no
    /// code path turns a finding into a mutation.
    @State private var findings: [BacklogFinding] = []
    @State private var isGrooming = false
    @State private var groomTruncated = false
    /// Narrow the list to flagged items. Turned ON automatically by a review
    /// that finds something — pressing Review means "show me what's wrong", and
    /// leaving the user to hunt for annotations in a 66-row list does not.
    @State private var onlyFlagged = false
    /// Hide items waiting on something outside the repo (ADR-0064). Off by
    /// default — hiding work silently is worse than showing it marked.
    @State private var hideBlocked = false
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
    /// Kinds the user has switched OFF, comma-joined (ADR-0064). Stored as one
    /// string rather than a flag per kind so adding a kind later doesn't strand
    /// a new @AppStorage key — and an empty string means "show everything",
    /// which is the right default for a filter nobody has touched.
    @AppStorage("marvin.backlog.hiddenKinds") private var hiddenKindsRaw = ""

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
            // Review focus (ADR-0063 addendum). Findings land on stale and
            // duplicated items, which are OLD by definition — under the default
            // "Newest" sort every one of them sinks below the fold. A count with
            // no way to reach it reads as "22 findings and I can't see any".
            .filter { !onlyFlagged || flaggedIds.contains($0.id) }
            .filter { !hideBlocked || !$0.isBlocked }
            .filter { !hiddenKinds.contains($0.kindOrUnspecified) }
            .sorted(by: sortComparator)
    }

    private var hiddenKinds: Set<String> {
        Set(hiddenKindsRaw.split(separator: ",").map(String.init)).subtracting([""])
    }

    private func toggleKind(_ k: String) {
        var h = hiddenKinds
        if h.contains(k) { h.remove(k) } else { h.insert(k) }
        hiddenKindsRaw = h.sorted().joined(separator: ",")
    }

    /// Item ids carrying at least one finding.
    private var flaggedIds: Set<String> { Set(findings.map(\.id)) }

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
        case .kind:
            // ADR-0064. `unspecified` sorts LAST — it's the pre-classification
            // default on 430 existing items, so leading with it would bury the
            // groups that carry information.
            let order = ["bug", "feature", "investigate", "test", "docs", "chore", "unspecified"]
            return order.compactMap { k in
                let g = v.filter { $0.kindOrUnspecified == k }
                return g.isEmpty ? nil : (k == "unspecified" ? "Unclassified" : k.capitalized, g)
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
            // Possible-duplicate hint (ADR-0044 addendum). Advisory, not an
            // error: the item was added. Orange, dismissible, and it never
            // resolves anything on the user's behalf.
            if let duplicateHint {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "arrow.triangle.merge")
                        .foregroundStyle(.orange)
                    Text(duplicateHint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button {
                        self.duplicateHint = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
                    .help("Dismiss")
                }
                .padding(.horizontal, 12).padding(.top, 8)
            }
            if !findings.isEmpty {
                groomSummary
                Divider()
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
                Section("Kind") {
                    ForEach(["bug", "feature", "investigate", "test", "docs", "chore", "unspecified"], id: \.self) { k in
                        Toggle(
                            k == "unspecified" ? "Unclassified" : k.capitalized,
                            isOn: Binding(
                                get: { !hiddenKinds.contains(k) },
                                set: { _ in toggleKind(k) }
                            )
                        )
                    }
                }
                Divider()
                Toggle("Show resolved", isOn: $showResolved)
                Toggle("Hide blocked", isOn: $hideBlocked)
            } label: {
                Label(filterLabel, systemImage: "line.3.horizontal.decrease.circle")
            }
            .menuStyle(.borderlessButton).fixedSize()

            Spacer()

            // Groom (ADR-0063). Read-only: it annotates rows with findings and
            // changes nothing. Acting on a finding stays an explicit action
            // through the row's existing controls.
            if !findings.isEmpty {
                Button {
                    findings = []
                    groomTruncated = false
                    onlyFlagged = false
                } label: {
                    Label("Clear findings", systemImage: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help("Dismiss the review annotations. Nothing was changed.")
            }
            Button {
                Task { await runGroom() }
            } label: {
                if isGrooming {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Review", systemImage: "checklist")
                }
            }
            .buttonStyle(.borderless)
            .disabled(isGrooming)
            .help("Review the backlog for duplicates, stale items, unreviewed captures, "
                  + "and references to files that no longer exist. Read-only.")
        }
        .font(.caption)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.4))
    }

    /// Summary bar shown after a review. Findings are heuristics, so this
    /// states what was found and leaves every decision to the user.
    private var groomSummary: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checklist").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(
                    "\(findings.count) finding\(findings.count == 1 ? "" : "s")"
                        + (groomTruncated ? " (capped — more remain)" : "")
                        + " on \(flaggedIds.count) item\(flaggedIds.count == 1 ? "" : "s")"
                        + " — these are suggestions, nothing was changed."
                )
                .font(.caption.weight(.semibold))
                Text(
                    onlyFlagged
                        ? "Showing only flagged items. Details are on each row."
                        : "Showing the whole backlog — flagged items are marked in orange."
                )
                .font(.caption2).foregroundStyle(.secondary)
                if let unmatched = unmatchedFindingSummary {
                    // A finding whose item another filter hides would otherwise
                    // be invisible — a silent partial view.
                    Text(unmatched).font(.caption2).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
            Toggle("Only flagged", isOn: $onlyFlagged)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(.caption2)
                .help("Narrow the list to the items this review flagged.")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.opacity(0.08))
    }

    /// Findings whose item is hidden by the OTHER filters (severity, resolved),
    /// so the count in the summary never implies rows the user can't reach.
    /// Deliberately ignores `onlyFlagged` — that one narrows TO the findings.
    private var unmatchedFindingSummary: String? {
        let reachable = Set(
            items
                .filter { $0.status == "open" || $0.status == "doing" || showResolved }
                .filter { severityAllowed($0.severity) }
                .map(\.id)
        ).union(provisional.map(\.id))
        let hidden = findings.filter { !reachable.contains($0.id) }
        guard !hidden.isEmpty else { return nil }
        return "\(hidden.count) relate to items hidden by the severity / resolved filters."
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

    /// Review annotations for one item (ADR-0063). Advisory — each states what
    /// was observed and what the user MIGHT do; none of it is applied, and the
    /// row's own buttons stay the only way to act. Shared by both row builders
    /// so a finding can't be counted in the summary yet render nowhere.
    @ViewBuilder
    private func findingAnnotations(for item: BacklogItem) -> some View {
        ForEach(findings.filter { $0.id == item.id }, id: \.findingId) { f in
            HStack(alignment: .top, spacing: 6) {
                Text(f.badge)
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.orange.opacity(0.18), in: Capsule())
                    .foregroundStyle(.orange)
                Text("\(f.detail) → \(f.suggestion)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 1)
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
                // Provisional rows carry findings too — `unreviewed` targets
                // them specifically, so without this the one finding kind aimed
                // at this section would be counted and never shown.
                findingAnnotations(for: item)
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
                    // ADR-0064 — kind + blocked. Blocked is shown even when the
                    // kind isn't set: "you can't act on this" is the more
                    // load-bearing fact of the two.
                    if item.kindOrUnspecified != "unspecified" {
                        statusBadge(item.kindOrUnspecified, kindColor(item.kindOrUnspecified))
                    }
                    if item.isBlocked {
                        statusBadge("blocked", .purple)
                            .help(item.blockedOn?.isEmpty == false
                                  ? "Waiting on: \(item.blockedOn!)"
                                  : "Blocked, but no note on what unblocks it")
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
                findingAnnotations(for: item)
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

    /// Review the backlog (ADR-0063). Annotates rows; changes nothing.
    private func runGroom() async {
        isGrooming = true
        defer { isGrooming = false }
        do {
            let result = try await BacklogService.shared.groom(workDir: workDir)
            findings = result.findings
            groomTruncated = result.truncated
            // Focus the list on what was found. Reversible from the summary bar.
            onlyFlagged = !result.findings.isEmpty
            if result.findings.isEmpty {
                // Say so explicitly — an empty annotation layer is
                // indistinguishable from "the button didn't work".
                duplicateHint = "Reviewed — nothing stale, duplicated, or unreviewed."
            } else {
                duplicateHint = nil
            }
        } catch {
            self.error = "Review failed: \(error.localizedDescription)"
        }
    }

    private func addNew() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        newTitle = ""
        duplicateHint = nil
        do {
            let related = try await BacklogService.shared.add(
                workDir: workDir,
                title: title,
                body: nil,
                severity: nil
            )
            await refresh()
            onChanged()
            // The item IS added — this is a hint, not a rejection. Exact-title
            // dedup can't see a reworded duplicate (ADR-0044 addendum), so say
            // so and let the user merge or resolve; nothing is touched for them.
            if !related.isEmpty {
                let titles = related.map { "“\($0.title)”" }.joined(separator: ", ")
                duplicateHint = related.count == 1
                    ? "Added. This looks like the same work as \(titles) — merge or resolve one?"
                    : "Added. This looks like the same work as \(related.count) existing items: \(titles)."
            }
        } catch {
            self.error = error.localizedDescription
        }
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

    /// Kind → tint. Bug reads as a problem (red), investigate as an open
    /// question (blue), the rest neutral — the palette should not imply
    /// urgency, which is severity's job.
    private func kindColor(_ k: String) -> Color {
        switch k {
        case "bug":         return .red
        case "investigate": return .blue
        case "feature":     return .green
        case "test":        return .teal
        case "docs":        return .gray
        case "chore":       return .secondary
        default:            return .secondary
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
        // A hidden kind or a hidden blocked set must show in the label —
        // otherwise the list silently omits rows and reads as an empty backlog.
        if !hiddenKinds.isEmpty {
            parts.append("-\(hiddenKinds.sorted().joined(separator: "/"))")
        }
        if hideBlocked { parts.append("-blocked") }
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
    /// ADR-0064 — classification, editable here because this is where the user
    /// already reads the item closely enough to judge it.
    @State private var kind: String
    @State private var blocked: Bool
    @State private var blockedOn: String
    @State private var resolveNote = ""
    @State private var error: String?
    @State private var savedFlash = false

    init(workDir: String, item: BacklogItem,
         onPromote: @escaping (BacklogItem) -> Void,
         onChanged: @escaping () -> Void,
         onDismissSheet: @escaping () -> Void) {
        self.workDir = workDir
        self.item = item
        _kind = State(initialValue: item.kindOrUnspecified)
        _blocked = State(initialValue: item.isBlocked)
        _blockedOn = State(initialValue: item.blockedOn ?? "")
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

            // ADR-0064 — kind + blocked. Saved immediately on change, like
            // severity: the detail sheet has no explicit Save for these fields
            // and a silently-discarded edit is worse than an eager write.
            Picker("Kind", selection: $kind) {
                Text("unspecified").tag("unspecified")
                Text("bug").tag("bug")
                Text("feature").tag("feature")
                Text("investigate").tag("investigate")
                Text("test").tag("test")
                Text("docs").tag("docs")
                Text("chore").tag("chore")
            }
            .frame(maxWidth: 260)
            .onChange(of: kind) { _, next in
                guard next != item.kindOrUnspecified else { return }
                Task { await classify(kind: next) }
            }

            Toggle("Blocked — waiting on something outside the repo", isOn: $blocked)
                .font(.callout)
                .onChange(of: blocked) { _, next in
                    guard next != item.isBlocked else { return }
                    Task { await classify(blocked: next) }
                }
            if blocked {
                TextField("What unblocks it? (e.g. accountant sign-off)", text: $blockedOn)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 420)
                    .onSubmit { Task { await classify(blockedOn: blockedOn) } }
                Text("Recorded so the groomer can tell a waiting item from a forgotten one.")
                    .font(.caption2).foregroundStyle(.tertiary)
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

    /// ADR-0064 — persist a classification edit. Metadata only: it never
    /// touches status, so nothing can be resolved by a mis-click here.
    private func classify(kind: String? = nil, blocked: Bool? = nil, blockedOn: String? = nil) async {
        do {
            try await BacklogService.shared.classify(
                workDir: workDir,
                id: item.id,
                kind: kind,
                blocked: blocked,
                blockedOn: blockedOn
            )
            savedFlash = true
            onChanged()
        } catch {
            self.error = error.localizedDescription
        }
    }

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

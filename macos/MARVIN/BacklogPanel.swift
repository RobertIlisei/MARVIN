// BacklogPanel — the Project Backlog window (ADR-0044, ADR-0047, ADR-0063,
// ADR-0064).
//
// A project's backlog is hundreds of items, so the window is a browser, not a
// scroll of cards: a scope switch (Open / To review / Resolved), a search
// field, sort / group / filter menus, groups with a count and a disclosure,
// rows on the pane standard (title, one secondary line, one visible action,
// the rest in a menu), and a detail area for the selected item. It is a
// PARKING LOT the user revisits — promotion to a turn is always a user act,
// and so is keep / dismiss of an auto-captured item: capture stays un-gated,
// the bulk review names its count and asks first.
//
// What is shown, in which order, under which heading, and which action a row
// leads with are decided in `MARVINLogic/BacklogBrowse.swift` and tested
// there. This file draws the result.
//
// Keyboard: ⌘F focuses the search field, ↑↓ moves through the list, Return
// does the selected row's visible action, ⌘-click / ⇧-click select several,
// Esc (or ⌘W) closes — Esc clears the search first when it has text.

import MARVINLogic
import SwiftUI

@MainActor struct BacklogPanel: View {
    let workDir: String
    /// Open on "To review" — the chat's "N backlog items parked" line asks for
    /// this. It only applies when there is something to review.
    var startAtReview = false
    /// Parent seeds a turn from the item (model.sendControl) + flips it to `doing`.
    let onPromote: (BacklogItem) -> Void
    let onClose: () -> Void
    /// Called after any mutation so the tray chip count can refresh.
    let onChanged: () -> Void

    @State private var items: [BacklogItem] = []
    @State private var isLoading = false
    /// The first fetch has finished (successfully or not) — until then the
    /// list shows a skeleton, never the empty state.
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var notice: PaneNotice?
    /// Groom findings (ADR-0063), keyed to items by id. Purely an annotation
    /// layer — no code path turns a finding into a mutation.
    @State private var findings: [BacklogFinding] = []
    @State private var isGrooming = false
    @State private var groomTruncated = false
    @State private var onlyFlagged = false

    @State private var scope: BacklogScope
    @State private var query = ""
    @State private var selection: Set<String> = []
    @State private var newTitle = ""
    @State private var bulk: BacklogBulk.Kind?
    @State private var containerWidth: CGFloat = 0
    @State private var dragStartWidth: Double?
    @FocusState private var searchFocused: Bool

    // Sort / group / filter — persisted so the view survives a relaunch.
    @AppStorage("marvin.backlog.sort") private var sort: BacklogSort = .severity
    @AppStorage("marvin.backlog.group") private var group: BacklogGroup = .severity
    @AppStorage("marvin.backlog.showHigh") private var showHigh = true
    @AppStorage("marvin.backlog.showMed") private var showMed = true
    @AppStorage("marvin.backlog.showLow") private var showLow = true
    /// Kinds switched OFF, comma-joined (ADR-0064): empty means "show everything".
    @AppStorage("marvin.backlog.hiddenKinds") private var hiddenKindsRaw = ""
    /// Status facets switched ON (BacklogStatusFilter.swift), comma-joined: empty means "no narrowing".
    /// They replace the old Blocked picker, which is one of them now.
    @AppStorage("marvin.backlog.statuses") private var statusesRaw = ""
    @AppStorage("marvin.backlog.folded") private var foldedRaw = ""
    @AppStorage("marvin.backlog.listWidth") private var listWidth: Double = 420

    private static let minList: Double = 320
    private static let minDetail: Double = 300

    init(workDir: String, startAtReview: Bool = false, initialSelection: String? = nil,
         onPromote: @escaping (BacklogItem) -> Void,
         onClose: @escaping () -> Void,
         onChanged: @escaping () -> Void) {
        self.workDir = workDir
        self.startAtReview = startAtReview
        self.onPromote = onPromote
        self.onClose = onClose
        self.onChanged = onChanged
        _scope = State(initialValue: startAtReview ? .review : .open)
        _selection = State(initialValue: initialSelection.map { [$0] } ?? [])
    }

    // MARK: Derived

    /// The scope counts are the project's one set of numbers (ADR-0044
    /// addendum): the same ones the chat's strip shows, so the two agree. Only
    /// before the store has heard anything do they come from the loaded list.
    private var counts: BacklogCounts {
        let store = BacklogLiveStore.shared
        return store.hasData ? store.counts.scopeCounts : BacklogBrowse.counts(items)
    }
    private var flaggedIds: Set<String> { Set(findings.map(\.id)) }
    private var hiddenKinds: Set<String> {
        Set(hiddenKindsRaw.split(separator: ",").map(String.init)).subtracting([""])
    }

    private var statuses: Set<BacklogStatusFacet> { BacklogStatusFacet.decode(statusesRaw) }

    private var filter: BacklogFilter {
        var sev: Set<String> = []
        if showHigh { sev.insert("high") }
        if showMed { sev.insert("med") }
        if showLow { sev.insert("low") }
        return BacklogFilter(scope: scope, query: query, severities: sev, hiddenKinds: hiddenKinds,
                             statuses: statuses, onlyIds: onlyFlagged ? flaggedIds : nil)
    }

    private var subtitle: String {
        BacklogSurface.windowSubtitle(counts)
    }

    // MARK: Body

    var body: some View {
        VStack(spacing: 0) {
            PaneHeader(title: "Project backlog", symbol: "tray.full", uppercase: false, subtitle: hasLoaded ? subtitle : nil) {
                Button(action: onClose) { Image(systemName: "xmark") }
                    .paneIconButton(10)
                    .help("Close (Esc)")
                    .accessibilityLabel("Close the backlog")
            }
            MarvinDivider()
            toolbar
            PaneFilterChips(chips: BacklogBrowse.chips(filter), onRemove: { apply(filter.removing($0)) }, onClearAll: clearFilters)
            MarvinDivider()
            if !findings.isEmpty { groomStrip }
            if let notice {
                PaneNoticeStrip(notice: notice, onDismiss: { self.notice = nil })
                    .padding(.bottom, 4)
            }
            content
        }
        .frame(minWidth: 720, idealWidth: 940, maxWidth: .infinity,
               minHeight: 520, idealHeight: 700, maxHeight: .infinity)
        .background(MarvinTheme.panel)
        .background(PaneWindowMemory(key: "marvin.backlog.windowSize", minWidth: 720, minHeight: 520))
        .background { shortcuts }
        .task {
            await refresh()
            adjustInitialScope()
        }
        .onChange(of: filter) { _, _ in selection.formIntersection(visibleIds) }
        // Another tab (or a hand edit) changed the backlog while this window is
        // open: bring the list up to date in place (ADR-0044 addendum).
        .onChange(of: BacklogLiveStore.shared.generation) { _, _ in Task { await reloadQuietly() } }
        .confirmationDialog(
            bulk.map { BacklogBulk.confirmTitle($0, bulkTargets) } ?? "",
            isPresented: Binding(get: { bulk != nil }, set: { if !$0 { bulk = nil } }),
            titleVisibility: .visible
        ) {
            if let kind = bulk {
                Button("\(kind.verb) \(bulkTargets.items.count)", role: kind == .dismiss ? .destructive : nil) {
                    let ids = bulkTargets.items.map(\.id)
                    bulk = nil
                    Task { await setStatuses(ids, kind.status) }
                }
            }
            Button("Cancel", role: .cancel) { bulk = nil }
        } message: {
            Text(bulk?.explanation ?? "")
        }
    }

    /// Hidden buttons carry the window's shortcuts so they work wherever focus is.
    private var shortcuts: some View {
        VStack {
            Button("Search") { searchFocused = true }.keyboardShortcut("f", modifiers: .command)
            Button("Close") { onClose() }.keyboardShortcut("w", modifiers: .command)
            Button("Close") { onClose() }.keyboardShortcut(.cancelAction)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: 10) {
            Picker("Show", selection: $scope) {
                ForEach(BacklogScope.allCases) { s in
                    Text(hasLoaded ? "\(s.title) \(counts.count(s))" : s.title).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("Open items, auto-captured items waiting for a decision, or resolved items")

            Spacer(minLength: 8)

            // Icons with tooltips, as a Mac toolbar does: at the window's
            // minimum width the labels would not fit.
            PaneSearchField(text: $query, prompt: "Search backlog", width: nil, focus: $searchFocused)
                .frame(minWidth: 140, idealWidth: 200, maxWidth: 220)

            Menu {
                Picker("Sort by", selection: $sort) {
                    ForEach(BacklogSort.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.inline)
            } label: { Label("Sort", systemImage: "arrow.up.arrow.down").labelStyle(.iconOnly) }
                .menuStyle(.borderlessButton).fixedSize()
                .help("Sort: \(sort.label)")
                .accessibilityLabel("Sort, currently \(sort.label)")

            Menu {
                Picker("Group by", selection: $group) {
                    ForEach(BacklogGroup.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.inline)
                if group != .none {
                    Divider()
                    Button("Fold All Groups") { foldAll(true) }
                    Button("Unfold All Groups") { foldAll(false) }
                }
            } label: { Label("Group", systemImage: "square.stack.3d.up").labelStyle(.iconOnly) }
                .menuStyle(.borderlessButton).fixedSize()
                .help("Group: \(group.label)")
                .accessibilityLabel("Group, currently \(group.label)")

            Menu {
                Section("Severity") {
                    Toggle("High", isOn: $showHigh)
                    Toggle("Medium", isOn: $showMed)
                    Toggle("Low", isOn: $showLow)
                }
                Section("Kind") {
                    ForEach(BacklogBrowse.kindOrder, id: \.self) { k in
                        Toggle(BacklogBrowse.kindTitle(k), isOn: Binding(
                            get: { !hiddenKinds.contains(k) }, set: { _ in toggleKind(k) }))
                    }
                }
                // Status: the facets of the scope in view, with how many each would show.
                // Choosing several shows the items that are ANY of them.
                let facets = BacklogStatusFacet.facets(in: scope)
                if !facets.isEmpty {
                    let counts = BacklogBrowse.statusCounts(items, filter)
                    Section("Status") {
                        ForEach(facets) { facet in
                            Toggle("\(facet.title)  \(counts[facet] ?? 0)", isOn: Binding(
                                get: { statuses.contains(facet) }, set: { _ in toggleStatus(facet) }))
                                .help(facet.help)
                        }
                    }
                }
                if filter.activeFilterCount > 0 {
                    Divider()
                    Button("Clear Filters") { clearFilters() }
                }
            } label: {
                // A non-default filter shows its count, so a list that silently
                // omits rows is never mistaken for an empty backlog.
                HStack(spacing: 3) {
                    Image(systemName: filter.activeFilterCount > 0
                          ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    if filter.activeFilterCount > 0 { Text("\(filter.activeFilterCount)").monospacedDigit() }
                }
            }
            .menuStyle(.borderlessButton).fixedSize()
            .help(filter.activeFilterCount > 0 ? "Filters are narrowing the list" : "Filter by status, severity or kind")
            .accessibilityLabel(filter.activeFilterCount > 0 ? "Filter, \(filter.activeFilterCount) active" : "Filter")

            // Review (ADR-0063) is read-only: it annotates rows with findings
            // and changes nothing.
            Button {
                Task { await runGroom() }
            } label: {
                if isGrooming { ProgressView().controlSize(.small).scaleEffect(0.7) }
                else { Label("Review", systemImage: "checklist") }
            }
            .buttonStyle(.borderless)
            .foregroundStyle(MarvinTheme.textPrimary)
            .disabled(isGrooming)
            .help("Look for duplicates, stale items, unreviewed captures and references to files that no longer exist. Read-only.")
        }
        .font(.system(size: 11))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// The review's own strip: what it found, and one action to focus on it.
    private var groomStrip: some View {
        PaneNoticeStrip(
            notice: PaneNotice(
                kind: .warning,
                headline: "\(findings.count) finding\(findings.count == 1 ? "" : "s")"
                    + (groomTruncated ? " (capped — more remain)" : "")
                    + " on \(flaggedIds.count) item\(flaggedIds.count == 1 ? "" : "s") — suggestions, nothing was changed.",
                detail: onlyFlagged ? "Showing only the flagged items." : nil),
            actionTitle: onlyFlagged ? "Show all" : "Only flagged",
            onAction: { onlyFlagged.toggle() },
            onDismiss: { findings = []; groomTruncated = false; onlyFlagged = false }
        )
        .padding(.bottom, 4)
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if !hasLoaded && items.isEmpty {
            ScrollView { SkeletonRows(count: 9, detailLines: 1).padding(14) }
                .scrollDisabled(true)
        } else if items.isEmpty, let loadError {
            PaneEmptyView(
                state: PaneEmptyState(headline: "Couldn’t load the backlog", hint: loadError, symbol: "exclamationmark.triangle"),
                actionTitle: "Try Again", action: { Task { await refresh() } })
                .frame(maxHeight: .infinity)
        } else {
            split
        }
    }

    private var effectiveListWidth: CGFloat {
        let wanted = CGFloat(liveWidth ?? listWidth)
        guard containerWidth > 0 else { return max(wanted, CGFloat(Self.minList)) }
        return min(max(wanted, CGFloat(Self.minList)), max(CGFloat(Self.minList), containerWidth - CGFloat(Self.minDetail) - 1))
    }

    /// The width while a drag is in flight; nil otherwise.
    @State private var liveWidth: Double?

    @ViewBuilder private var split: some View {
        if items.isEmpty {
            // Nothing parked: the empty state and the add field, not an empty detail pane.
            listPane
        } else {
            HStack(spacing: 0) {
                listPane.frame(width: effectiveListWidth)
                splitHandle
                detailPane.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
        }
    }

    /// A 1pt line with a wider grab area. The width is remembered, so the next
    /// time the window opens the list is as wide as it was left.
    private var splitHandle: some View {
        Rectangle()
            .fill(MarvinTheme.border)
            .frame(width: 1)
            .contentShape(Rectangle().inset(by: -4))
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { v in
                        if dragStartWidth == nil { dragStartWidth = listWidth }
                        let maxW = max(Self.minList, Double(containerWidth) - Self.minDetail - 1)
                        liveWidth = min(max((dragStartWidth ?? listWidth) + Double(v.translation.width), Self.minList), maxW)
                    }
                    .onEnded { _ in
                        if let liveWidth { listWidth = liveWidth }
                        liveWidth = nil
                        dragStartWidth = nil
                    }
            )
            .accessibilityLabel("Resize the list")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: listWidth += 24
                case .decrement: listWidth = max(Self.minList, listWidth - 24)
                @unknown default: break
                }
            }
    }

    // MARK: List pane

    private var listPane: some View {
        VStack(spacing: 0) {
            listBody
            if scope == .review, !bulkTargets.items.isEmpty { bulkBar }
            if scope == .open { MarvinDivider(); addRow }
        }
    }

    @ViewBuilder private var listBody: some View {
        let sections = BacklogBrowse.view(items, filter: filter, sort: sort, group: group)
        if sections.isEmpty {
            emptyState.frame(maxHeight: .infinity)
        } else {
            let byId = Dictionary(grouping: findings, by: \.id)
            let now = Date()
            List(selection: $selection) {
                ForEach(sections) { section in
                    let key = foldKey(section)
                    let folded = !section.title.isEmpty && BrowseDisclosure(raw: foldedRaw).isCollapsed(key)
                    if !section.title.isEmpty {
                        Button { toggleFold(key) } label: {
                            PaneSectionHeader(section.title, count: section.items.count, collapsed: folded)
                        }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets())
                        .accessibilityLabel("\(section.title), \(section.items.count) items, \(folded ? "folded" : "unfolded")")
                        .accessibilityHint("Folds or unfolds the group")
                    }
                    if !folded {
                        ForEach(section.items) { item in
                            BacklogRowView(item: item, now: now, findings: byId[item.id] ?? [],
                                           selected: selection.contains(item.id),
                                           onAction: { act(item, $0) })
                                .tag(item.id)
                                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .onKeyPress(.return) {
                guard selection.count == 1, let id = selection.first,
                      let item = items.first(where: { $0.id == id }),
                      let primary = BacklogRowActions.forStatus(item.status).primary else { return .ignored }
                act(item, primary)
                return .handled
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if filter.isNarrowed {
            // Something is hiding items; say what, and offer the way back.
            PaneEmptyView(
                state: PaneEmptyState(
                    headline: filter.isSearching ? "No results for “\(query.trimmingCharacters(in: .whitespaces))”" : "No items match the filters",
                    hint: "\(counts.count(scope)) \(scope.title.lowercased()) item\(counts.count(scope) == 1 ? " is" : "s are") hidden. Clear the search or loosen the filters.",
                    symbol: "magnifyingglass"),
                actionTitle: "Clear Search and Filters", action: { query = ""; clearFilters() })
        } else {
            switch scope {
            case .open:
                PaneEmptyView(state: PaneEmptyState(
                    headline: "Nothing parked",
                    hint: "Follow-ups MARVIN notices while it works are parked here and resurface next session. Add one below.",
                    symbol: "tray"))
            case .review:
                PaneEmptyView(state: PaneEmptyState(
                    headline: "Nothing to review",
                    hint: "Items MARVIN captures on its own wait here for a keep or a dismiss.",
                    symbol: "checkmark.circle"))
            case .resolved:
                PaneEmptyView(state: PaneEmptyState(
                    headline: "Nothing resolved yet",
                    hint: "Done and dismissed items are kept here as history.",
                    symbol: "archivebox"))
            }
        }
    }

    // MARK: Bulk review

    private var bulkTargets: BacklogBulk.Targets {
        BacklogBulk.targets(selected: selection, shown: BacklogBrowse.filter(items, filter))
    }

    /// ADR-0047 puts the bloat control at THIS pass. Both bulk acts name their
    /// count on the button and in the question, and only captures are ever in it.
    private var bulkBar: some View {
        let t = bulkTargets
        return VStack(spacing: 0) {
            MarvinDivider()
            HStack(spacing: 8) {
                Text("\(t.items.count) to review")
                    .font(.system(size: 10.5))
                    .foregroundStyle(MarvinTheme.textMuted)
                Spacer(minLength: 0)
                Button(BacklogBulk.buttonTitle(.dismiss, t)) { bulk = .dismiss }.chip(.neutral)
                Button(BacklogBulk.buttonTitle(.keep, t)) { bulk = .keep }.chip(.primary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            TextField("Add an item…", text: $newTitle)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11.5))
                .onSubmit { Task { await addNew() } }
            Button("Add") { Task { await addNew() } }
                .rowChip(.neutral)
                .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // MARK: Detail pane

    @ViewBuilder private var detailPane: some View {
        if selection.count == 1, let id = selection.first, let item = items.first(where: { $0.id == id }) {
            BacklogDetailView(
                workDir: workDir, item: item,
                findings: findings.filter { $0.id == item.id },
                onPromote: { onPromote($0); onClose() },
                onChanged: { Task { await refresh(); onChanged() } },
                onDismissSheet: { selection = [] }
            )
            .id(item.id)
        } else if selection.count > 1 {
            PaneEmptyView(state: PaneEmptyState(
                headline: "\(selection.count) items selected",
                hint: scope == .review ? "Use the buttons under the list to keep or dismiss them." : "Select one item to read it.",
                symbol: "checklist"))
        } else {
            PaneEmptyView(state: PaneEmptyState(
                headline: "No item selected",
                hint: "Choose an item to read its description, notes and links.",
                symbol: "sidebar.right"))
        }
    }

    // MARK: Disclosure

    private func foldKey(_ s: BacklogSection) -> String { "\(group.rawValue):\(s.id)" }

    private func toggleFold(_ key: String) {
        var d = BrowseDisclosure(raw: foldedRaw)
        d.toggle(key)
        foldedRaw = d.raw
    }

    private func foldAll(_ fold: Bool) {
        var d = BrowseDisclosure(raw: foldedRaw)
        let sections = BacklogBrowse.view(items, filter: filter, sort: sort, group: group)
        for s in sections where !s.title.isEmpty {
            let key = foldKey(s)
            if d.isCollapsed(key) != fold { d.toggle(key) }
        }
        foldedRaw = d.raw
    }

    // MARK: Filter helpers

    private var visibleIds: Set<String> {
        Set(BacklogBrowse.filter(items, filter).map(\.id))
    }

    private func toggleKind(_ k: String) {
        var h = hiddenKinds
        if h.contains(k) { h.remove(k) } else { h.insert(k) }
        hiddenKindsRaw = h.sorted().joined(separator: ",")
    }

    private func toggleStatus(_ facet: BacklogStatusFacet) {
        var next = statuses
        if next.contains(facet) { next.remove(facet) } else { next.insert(facet) }
        statusesRaw = BacklogStatusFacet.encode(next)
    }

    /// Writes a filter back into the stored choices (a chip was removed, or Clear filters).
    private func apply(_ f: BacklogFilter) {
        (showHigh, showMed, showLow) = (f.severities.contains("high"), f.severities.contains("med"), f.severities.contains("low"))
        hiddenKindsRaw = f.hiddenKinds.sorted().joined(separator: ",")
        statusesRaw = BacklogStatusFacet.encode(f.statuses)
        onlyFlagged = f.onlyIds != nil
    }

    private func clearFilters() { apply(filter.cleared()) }

    /// Opened on Open with nothing in it but captures waiting: land where the work is.
    private func adjustInitialScope() {
        let c = counts
        if scope == .open, c.open == 0, c.review > 0 { scope = .review }
        if scope == .review, c.review == 0 { scope = .open }
    }

    // MARK: Actions

    private func post(_ n: PaneNotice) {
        notice = n
        if case .auto(let seconds) = n.dismissal {
            Task {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if notice == n { notice = nil }
            }
        }
    }

    private func act(_ item: BacklogItem, _ action: BacklogAction) {
        switch action {
        case .plan:
            onPromote(item)
            onClose()
        case .export:
            Task { await exportIssue(item) }
        default:
            if let status = action.targetStatus { Task { await setStatus(item, status) } }
        }
    }

    private func refresh() async {
        isLoading = true
        defer { isLoading = false; hasLoaded = true }
        do {
            items = try await BacklogService.shared.fetch(workDir: workDir)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
            if !items.isEmpty { post(PaneNotice(kind: .error, headline: "Couldn’t refresh the backlog.", detail: error.localizedDescription)) }
        }
    }

    /// Re-read the list after the backlog changed somewhere else. No skeleton,
    /// no notice on failure, and nothing is assigned when nothing differs — the
    /// window must not blink for a change it already shows.
    private func reloadQuietly() async {
        guard hasLoaded, !isLoading, let fresh = try? await BacklogService.shared.fetch(workDir: workDir) else { return }
        if fresh != items { items = fresh }
    }

    /// Done / Dismiss / Keep / Reopen: change the row where it is, then tell the
    /// server — a refetch of the whole list after every click made the window
    /// "barely move" (2026-09-30). On failure the row is put back.
    private func setStatus(_ item: BacklogItem, _ status: String) async {
        guard let idx = items.firstIndex(where: { $0.id == item.id }) else { return }
        let previous = items[idx].status
        items[idx].status = status
        selection.remove(item.id)
        do {
            try await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: status)
            onChanged()
        } catch {
            if let i = items.firstIndex(where: { $0.id == item.id }) { items[i].status = previous }
            post(PaneNotice(kind: .error, headline: "Couldn’t update “\(item.title)”.", detail: error.localizedDescription))
        }
    }

    /// The bulk review. Only reached through the confirm that named the count.
    private func setStatuses(_ ids: [String], _ status: String) async {
        var failed = 0
        for id in ids {
            guard let idx = items.firstIndex(where: { $0.id == id }) else { continue }
            let previous = items[idx].status
            items[idx].status = status
            do {
                try await BacklogService.shared.setStatus(workDir: workDir, id: id, status: status)
            } catch {
                failed += 1
                if let i = items.firstIndex(where: { $0.id == id }) { items[i].status = previous }
            }
        }
        selection = []
        onChanged()
        if failed > 0 {
            post(PaneNotice(kind: .warning, headline: "\(ids.count - failed) of \(ids.count) updated; \(failed) failed.", detail: nil))
        } else {
            post(PaneNotice(kind: .success, headline: "\(ids.count) item\(ids.count == 1 ? "" : "s") \(status == "open" ? "kept" : "dismissed")."))
        }
    }

    /// Review the backlog (ADR-0063). Annotates rows; changes nothing.
    private func runGroom() async {
        isGrooming = true
        defer { isGrooming = false }
        do {
            let result = try await BacklogService.shared.groom(workDir: workDir)
            findings = result.findings
            groomTruncated = result.truncated
            onlyFlagged = !result.findings.isEmpty
            if result.findings.isEmpty {
                // An empty annotation layer is indistinguishable from "the
                // button didn't work", so say so.
                post(PaneNotice(kind: .info, headline: "Reviewed — nothing stale, duplicated or unreviewed."))
            }
        } catch {
            post(PaneNotice(kind: .error, headline: "The review failed.", detail: error.localizedDescription))
        }
    }

    private func addNew() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        newTitle = ""
        do {
            let related = try await BacklogService.shared.add(workDir: workDir, title: title, body: nil, severity: nil)
            await refresh()
            onChanged()
            // The item IS added — a possible duplicate is a hint, not a
            // rejection (ADR-0044 addendum). Nothing is touched for the user.
            if !related.isEmpty {
                let titles = related.map { "“\($0.title)”" }.joined(separator: ", ")
                post(PaneNotice(kind: .warning, headline: related.count == 1
                    ? "Added. This looks like the same work as \(titles) — merge or resolve one?"
                    : "Added. This looks like the same work as \(related.count) existing items: \(titles)."))
            }
        } catch {
            post(PaneNotice(kind: .error, headline: "Couldn’t add the item.", detail: error.localizedDescription))
        }
    }

    private func exportIssue(_ item: BacklogItem) async {
        do {
            let url = try await BacklogService.shared.promoteIssue(workDir: workDir, id: item.id)
            post(PaneNotice(kind: .success, headline: "Filed as an issue.", detail: url))
            await refresh()
            onChanged()
        } catch {
            post(PaneNotice(kind: .error, headline: "Export failed.", detail: error.localizedDescription))
        }
    }
}

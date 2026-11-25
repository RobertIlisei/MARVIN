// PluginsPane — the Plugins tab inside LeftPane (ADR-0053).
//
// Installed Claude Code plugins, opt-in per project. Discovery is shared with
// the Claude Code `/plugin` UI (`~/.claude/plugins/`), so anything installed
// there shows up here; activation is per-project (`.marvin/plugins.json`).
//
//   • toggle  — enable/disable a plugin for THIS project (POST /api/plugins).
//   • install — fetch a full plugin from a marketplace/Git URL
//               (POST /api/plugins/install) so the loader discovers it.
//
// Loads a plugin's skills + slash commands + (gated) MCP + agents — agents
// run READ-ONLY under the subagent invariant, dispatch confirm-gated
// (ADR-0054). Hooks are never loaded (tool-flow safety, ADR-0054 §2). All data
// comes from `GET /api/plugins?workDir=…`; the pane re-fetches on project
// change and after a mutation.

import AppKit
import MARVINLogic
import SwiftUI

// MARK: - Wire types (decoded from /api/plugins)

private struct PluginsResponse: Decodable {
    let plugins: [PluginSummary]
    /// Browseable marketplace catalog (absent on the POST-toggle echo).
    let catalog: [CatalogPlugin]?
}

private struct CatalogPlugin: Decodable, Identifiable {
    let marketplace: String
    let name: String
    let displayName: String?
    let description: String?
    let category: String?
    let author: String?
    let installed: Bool
    var id: String { "\(marketplace)/\(name)" }
    var title: String { displayName ?? name }
    var isAnthropic: Bool { (author ?? "").caseInsensitiveCompare("Anthropic") == .orderedSame }
}

private struct PluginSummary: Decodable, Identifiable {
    let key: String
    let name: String
    let marketplace: String?
    let author: String?
    let version: String?
    let description: String?
    let skills: [String]
    let commands: [String]
    let agents: [String]
    let hasMcp: Bool
    let hasHooks: Bool
    let enabled: Bool
    /// Where MARVIN installed this from (ADR-0071). Absent for plugins that
    /// arrived through the Claude Code /plugin UI — not ours to update.
    let source: SourceInfo?
    var id: String { key }
}

/// Recorded install provenance (ADR-0071).
private struct SourceInfo: Decodable {
    let url: String?
    let marketplace: String?
    let plugin: String?
    let installedAt: String
    let lastUpdated: String
    /// False when the record exists but can't be re-fetched from.
    let updatable: Bool
}

/// One row's result from POST /api/plugins/update.
private struct UpdateOutcome: Decodable, Identifiable {
    let key: String
    let name: String
    /// "updated" | "up-to-date" | "update-available" | "error"
    let status: String
    let error: String?
    let fromVersion: String?
    let toVersion: String?
    var id: String { key }
}

private struct UpdateResponse: Decodable {
    let ok: Bool?
    let error: String?
    let results: [UpdateOutcome]?
}

// MARK: - View

@MainActor struct PluginsPane: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var plugins: [PluginSummary] = []
    @State private var catalog: [CatalogPlugin] = []
    @State private var loadError: String?
    @State private var isLoading = false
    /// The outcome of the last action, with its kind (ADR-0114). "Installed
    /// marvin-graph" and "Install failed: HTTP 500" used to be the same
    /// pixels behind the same puzzle-piece icon, both gone in three seconds.
    @State private var notice: PaneNotice?
    /// The filter under the header (installed AND catalog), the selected row,
    /// which groups are closed, and the one catalog entry currently installing.
    @State private var filter = ""
    @State private var selection: String?
    @State private var groups = PaneCollapseStore(pane: "plugins")
    @State private var bulkUpdating = false
    @State private var installingFromCatalog: String?

    // Update state (ADR-0071): last check result per plugin key, plus which
    // key is mid-update so its button can spin.
    @State private var updateStatus: [String: String] = [:]
    @State private var updatingKey: String?
    @State private var checkingUpdates = false

    // Install sheet state.
    @State private var installSheetOpen = false
    @State private var installURL = ""
    @State private var installBusy = false
    @State private var installError: String?
    @State private var marketplacePlugins: [InstallCandidate] = []
    @State private var marketplaceName: String?

    /// The snapshot harness shows the pane after an update check ran and with a
    /// row open (`SurfaceSnapshotPaneKit`); nothing else passes arguments.
    init(seedUpdateStatus: [String: String] = [:], seedSelection: String? = nil) {
        _updateStatus = State(initialValue: seedUpdateStatus)
        _selection = State(initialValue: seedSelection)
    }

    struct InstallCandidate: Decodable, Identifiable {
        let name: String
        let displayName: String?
        let description: String?
        var id: String { name }
        var title: String { displayName ?? name }
    }

    var body: some View {
        VStack(spacing: 0) {
            if bridge.projectWorkDir == nil {
                pluginsHeader(actions: false)
                PaneEmptyView(state: .noProject("plugins")).frame(maxHeight: .infinity)
            } else if loadError != nil, plugins.isEmpty {
                pluginsHeader(actions: false)
                PaneEmptyView(
                    state: .couldNotLoad("plugins", reason: "Check that MARVIN's server is running, then try again."),
                    actionTitle: "Retry",
                    action: { Task { await refresh() } }
                ).frame(maxHeight: .infinity)
            } else if isLoading, plugins.isEmpty, catalog.isEmpty {
                pluginsHeader(actions: false)
                PaneLoadingView(label: "Reading the installed plugins…")
                Spacer(minLength: 0)
            } else {
                content
            }
            if let notice {
                PaneNoticeStrip(notice: notice, onDismiss: { withAnimation { self.notice = nil } })
            }
        }
        .task(id: bridge.projectWorkDir) { await refresh() }
        .sheet(isPresented: $installSheetOpen) { installSheet }
        // A pane absorbs compression and clips; it never negotiates for
        // width. All seven stay mounted in one ZStack, so the widest
        // intrinsic minimum among them becomes the sidebar's, and the
        // overflow pushes the 44pt rail off the left edge (ADR-0114).
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        let filtering = PaneFilter.isActive(filter)
        let shown = plugins.filter {
            PaneFilter.matches(filter, in: [$0.name, $0.description ?? "", $0.author ?? "", $0.marketplace ?? ""])
        }
        let entries = shown.map {
            InstalledEntry(id: $0.key, name: $0.name, enabled: $0.enabled,
                           hasUpdate: $0.source?.updatable == true && updateStatus[$0.key] == "update-available",
                           blocked: false)
        }
        let sections = InstalledGrouping.group(entries)
        let byKey = Dictionary(plugins.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        let available = filteredCatalog
        let nothing = sections.isEmpty && available.isEmpty
        VStack(spacing: 0) {
            pluginsHeader(actions: !(plugins.isEmpty && catalog.isEmpty))
            if plugins.isEmpty && catalog.isEmpty {
                PaneEmptyView(state: .nothingYet("plugins", hint: "Install one from a marketplace, or with Claude Code's /plugin command. It lands in the same place."),
                              actionTitle: "Install…") { openInstallSheet() }
                    .frame(maxHeight: .infinity)
            } else {
                PaneFilterField(text: $filter, prompt: "Filter plugins")
                if filtering && nothing {
                    PaneEmptyView(state: .filtered(query: filter, noun: "plugins"), actionTitle: "Clear filter") { filter = "" }
                    Spacer(minLength: 0)
                } else {
                    PaneScrollList(
                        rows: visibleRows(sections: sections, byKey: byKey, available: available, filtering: filtering),
                        selection: $selection,
                        onActivate: { id in activate(id, byKey: byKey) },
                        onSpace: { id in if let p = byKey[id] { Task { await toggle(p) } } },
                        onEscape: { if PaneFilter.isActive(filter) { filter = ""; return true }; return false }
                    ) {
                        ForEach(sections, id: \.group) { sec in installedGroup(sec, byKey: byKey, filtering: filtering) }
                        catalogGroup(available, filtering: filtering)
                    }
                }
            }
        }
    }

    private func visibleRows(
        sections: [InstalledGrouping.Section], byKey: [String: PluginSummary],
        available: [CatalogPlugin], filtering: Bool
    ) -> [(id: String, title: String)] {
        var out: [(id: String, title: String)] = []
        for sec in sections where PaneCollapseState.isShown(collapsed: groups.isCollapsed(sec.group.key, default: false), filterActive: filtering) {
            out += sec.ids.compactMap { id in byKey[id].map { (id: id, title: $0.name) } }
        }
        if PaneCollapseState.isShown(collapsed: groups.isCollapsed("catalog", default: true), filterActive: filtering) {
            out += available.map { (id: "catalog:\($0.id)", title: $0.title) }
        }
        return out
    }

    /// Return on a row does the row's one obvious thing.
    private func activate(_ id: String, byKey: [String: PluginSummary]) {
        if let p = byKey[id] {
            if p.source?.updatable == true, updateStatus[p.key] == "update-available" { Task { await updateOne(p) } }
            else { selection = id }
        } else if id.hasPrefix("catalog:"), let c = catalog.first(where: { "catalog:\($0.id)" == id }), installingFromCatalog == nil {
            Task { await installFromCatalog(c) }
        }
    }

    // MARK: Header

    /// One verb the pane exists for, and a menu for the rest (the standard's
    /// two-action header).
    private func pluginsHeader(actions: Bool) -> some View {
        PaneHeader(title: "Plugins", symbol: "puzzlepiece.extension", count: actions ? plugins.count : nil) {
            if actions {
                PaneActionButton(title: "Install…", role: .primary, help: "Install — add a plugin from a marketplace or Git URL") {
                    openInstallSheet()
                }
                PaneOverflowMenu(label: "More actions for plugins") {
                    Button("Check for updates") { Task { await checkAllUpdates() } }
                        .disabled(checkingUpdates || updatableCount == 0)
                        .help(updatableCount == 0
                              ? "Nothing to check: no plugin here was installed by MARVIN (ones from the Claude Code /plugin UI have no recorded source)."
                              : "Re-fetch the \(updatableCount) plugin\(updatableCount == 1 ? "" : "s") MARVIN installed and report which changed upstream. Installs nothing.")
                    Button("Reload the list") { Task { await refresh() } }
                        .disabled(isLoading)
                        .help("Read the installed plugins from disk again (does not check upstream)")
                }
            }
        }
    }

    private func openInstallSheet() {
        installError = nil; marketplacePlugins = []; marketplaceName = nil
        installSheetOpen = true
    }

    /// How many rows could be updated at all — gates "Check for updates".
    private var updatableCount: Int {
        plugins.filter { $0.source?.updatable == true }.count
    }

    // MARK: Groups

    private func groupTint(_ g: InstalledGroup) -> Color {
        switch g {
        case .attention: return GitDecorationColor.deleted
        case .needsUpdate: return .orange
        case .enabled, .available: return MarvinTheme.textMuted
        }
    }

    private func groupHelp(_ g: InstalledGroup) -> String {
        switch g {
        case .attention: return "Installed, but not loading."
        case .needsUpdate: return "A check found a newer version upstream."
        case .enabled: return "Loaded into this project: skills, slash commands, MCP servers (each call asks first) and read-only agents. Hooks are never loaded."
        case .available: return "Installed in ~/.claude/plugins, so Claude Code sees them too, but not loaded in this project. Switch one on to load it here."
        }
    }

    @ViewBuilder
    private func installedGroup(_ sec: InstalledGrouping.Section, byKey: [String: PluginSummary], filtering: Bool) -> some View {
        let g = sec.group
        PaneGroup(
            store: groups, id: g.key, title: g.title, count: sec.ids.count, tint: groupTint(g),
            help: groupHelp(g), startsCollapsed: false, filterActive: filtering,
            trailing: {
                if g == .needsUpdate {
                    PaneActionButton(
                        title: PaneBulkAction.title("Update all", count: sec.ids.count),
                        role: .primary,
                        help: "Re-fetch every plugin in this group from its recorded source.",
                        disabled: bulkUpdating || updatingKey != nil || checkingUpdates
                    ) { Task { await updateAllAvailable() } }
                }
            },
            content: {
                ForEach(sec.ids, id: \.self) { key in
                    if let p = byKey[key] { pluginRow(p) }
                }
            })
    }

    @ViewBuilder
    private func catalogGroup(_ available: [CatalogPlugin], filtering: Bool) -> some View {
        let total = catalog.filter { !$0.installed }.count
        if total > 0 {
            PaneGroup(
                store: groups, id: "catalog", title: "Available from marketplaces",
                count: filtering ? rankedCatalog.count : total, tint: Color.accentColor,
                help: "Everything your marketplaces offer (the same catalogs as the Claude Code /plugin browser). Install copies the plugin into ~/.claude/plugins; then switch it on above.",
                startsCollapsed: true, filterActive: filtering
            ) {
                ForEach(available) { c in catalogRow(c) }
                if filtering, rankedCatalog.count > available.count {
                    PaneNote(text: "Showing the closest \(available.count) of \(rankedCatalog.count) — narrow the filter to see the rest.")
                } else if !filtering, total > available.count {
                    PaneNote(text: "Showing \(available.count) of \(total) — filter to find the rest.")
                }
            }
        }
    }

    // MARK: Rows

    private func pluginRow(_ p: PluginSummary) -> some View {
        let status = updateStatus[p.key]
        let updatable = p.source?.updatable == true
        let waiting = status == "update-available"
        let canRun = updatingKey == nil && !checkingUpdates && !bulkUpdating
        let trailingVersion = (p.version.flatMap { $0.isEmpty || $0 == "unknown" ? nil : "v\($0)" })

        var items: [PaneRowItem] = []
        if updatable {
            items.append(PaneRowItem(
                id: "update", title: waiting ? "Update" : "Re-fetch from source",
                systemImage: "arrow.triangle.2.circlepath", role: waiting ? .primary : .normal, enabled: canRun,
                help: sourceHelp(p.source), perform: { Task { await updateOne(p) } }))
        } else {
            items.append(PaneRowItem(
                id: "source", title: "Set source…", systemImage: "link",
                help: "MARVIN did not install this one, so it has no recorded URL to re-fetch from. Installing it through MARVIN once records the source and enables updates.",
                perform: { installError = nil; marketplacePlugins = []; marketplaceName = nil; installURL = p.source?.url ?? ""; installSheetOpen = true }))
        }
        // `/api/plugins` does not send an install path, so this opens the
        // directory every plugin lives in rather than inventing a field.
        items.append(PaneRowItem(id: "reveal", title: "Reveal the plugins folder", systemImage: "folder", perform: {
            let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/plugins")
            NSWorkspace.shared.activateFileViewerSelecting([root])
        }))
        items.append(PaneRowItem(id: "copy", title: "Copy plugin name", systemImage: "doc.on.doc", perform: {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(p.name, forType: .string)
        }))
        if let url = p.source?.url, !url.isEmpty {
            items.append(PaneRowItem(id: "copyurl", title: "Copy source URL", systemImage: "link", perform: {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
            }))
        }
        // Deliberately NOT an uninstall. MARVIN clones a plugin but records it in
        // `~/.claude/plugins/installed_plugins.json`, which Claude Code owns and
        // both tools read — removing one from there is a cross-tool destructive
        // edit, and Claude Code's own `/plugin` UI is where it belongs.

        let desc = (p.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return PaneListRow(
            rowID: p.key, title: p.name, titleIsIdentifier: true,
            leading: .toggle(
                isOn: p.enabled, name: p.name,
                help: p.enabled
                    ? "Loaded in this project. Switch off to unload it here."
                    : "Not loaded here. Switch on to load its skills, commands, gated MCP servers and read-only agents.",
                onToggle: { _ in Task { await toggle(p) } }),
            secondary: desc.isEmpty ? "No description" : desc,
            secondaryStyle: desc.isEmpty ? .placeholder : .normal,
            trailingText: status == "updated" ? "Updated" : trailingVersion,
            trailingSymbol: status == "updated" ? "checkmark" : nil,
            trailingTint: status == "updated" ? GitDecorationColor.added : MarvinTheme.textMuted,
            selected: selection == p.key, busy: updatingKey == p.key, items: items,
            menuLabel: "More actions for \(p.name)", onSelect: { selection = p.key },
            showsDetail: selection == p.key,
            detail: { pluginDetail(p) })
    }

    private func sourceHelp(_ s: SourceInfo?) -> String {
        guard let s else { return "Re-fetch this plugin." }
        let origin = s.url ?? s.marketplace ?? "its recorded source"
        return "Re-fetch from \(origin). Last updated \(s.lastUpdated)."
    }

    /// What a selected plugin adds: who made it, what it loads, and the one
    /// caution — hooks are the part MARVIN refuses to load (ADR-0054).
    @ViewBuilder
    private func pluginDetail(_ p: PluginSummary) -> some View {
        let parts: [String] = [
            p.skills.isEmpty ? nil : "\(p.skills.count) skill\(p.skills.count == 1 ? "" : "s")",
            p.commands.isEmpty ? nil : "\(p.commands.count) command\(p.commands.count == 1 ? "" : "s")",
            p.hasMcp ? "MCP servers (each call asks first)" : nil,
            p.agents.isEmpty ? nil : "\(p.agents.count) agent\(p.agents.count == 1 ? "" : "s") (read-only)",
        ].compactMap { $0 }
        let isAnthropic = (p.author ?? "").caseInsensitiveCompare("Anthropic") == .orderedSame
        VStack(alignment: .leading, spacing: PaneSpace.tight) {
            if let d = p.description, !d.isEmpty { Text(d).lineLimit(8) }
            Text(parts.isEmpty ? "Adds nothing MARVIN loads." : "Loads: " + parts.joined(separator: " · "))
            if let author = p.author, !author.isEmpty {
                Label("By \(author)\(p.marketplace.map { " · \($0)" } ?? "")",
                      systemImage: isAnthropic ? "checkmark.seal.fill" : "person")
                    .foregroundStyle(isAnthropic ? Color.accentColor : MarvinTheme.textMuted)
            } else if let m = p.marketplace, !m.isEmpty {
                Text("From \(m)")
            }
            if p.hasHooks {
                Label("Its hooks are never loaded.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        }
        .font(PaneFont.secondary)
        .foregroundStyle(MarvinTheme.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func catalogRow(_ c: CatalogPlugin) -> some View {
        let id = "catalog:\(c.id)"
        let desc = (c.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return PaneListRow(
            rowID: id, title: c.title, titleIsIdentifier: true, leading: .glyph("shippingbox"),
            secondary: desc.isEmpty ? "No description" : desc,
            secondaryStyle: desc.isEmpty ? .placeholder : .normal,
            trailingText: c.isAnthropic ? "Anthropic" : nil,
            trailingSymbol: c.isAnthropic ? "checkmark.seal.fill" : nil,
            trailingTint: Color.accentColor,
            selected: selection == id, busy: installingFromCatalog == c.id,
            items: [
                PaneRowItem(id: "install", title: "Install", role: .primary, enabled: installingFromCatalog == nil,
                            help: "Copy it into ~/.claude/plugins, then switch it on.", perform: { Task { await installFromCatalog(c) } }),
            ],
            menuLabel: "More actions for \(c.title)", onSelect: { selection = id },
            showsDetail: selection == id,
            detail: {
                VStack(alignment: .leading, spacing: PaneSpace.tight) {
                    if !desc.isEmpty { Text(desc).lineLimit(8) }
                    Text([c.author.map { "By \($0)" }, c.marketplace, c.category].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                }
                .font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            })
    }

    // MARK: Catalog ranking

    /// Not-yet-installed catalog entries matching the filter. Ranking: name
    /// prefix first, then name contains, then description/category matches —
    /// so "sec" surfaces `security-*` plugins before ones that merely mention
    /// security in prose. Capped, and the cap is named by the group.
    private struct RankedPlugin {
        let plugin: CatalogPlugin
        let rank: Int
    }

    private var filteredCatalog: [CatalogPlugin] {
        let available = catalog.filter { !$0.installed }
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return Array(available.prefix(15)) }
        func rank(_ p: CatalogPlugin) -> Int? {
            let name = p.name.lowercased()
            if name.hasPrefix(q) { return 0 }
            if name.contains(q) { return 1 }
            // Author matches rank with name-contains so "anthropic" surfaces
            // every first-party plugin as a primary result.
            if (p.author ?? "").lowercased().contains(q) { return 1 }
            if (p.description ?? "").lowercased().contains(q)
                || (p.category ?? "").lowercased().contains(q) { return 2 }
            return nil
        }
        var ranked: [RankedPlugin] = []
        for p in available {
            if let r = rank(p) { ranked.append(RankedPlugin(plugin: p, rank: r)) }
        }
        ranked.sort { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            return a.plugin.name < b.plugin.name
        }
        return ranked.prefix(50).map { $0.plugin }
    }

    /// The same match, uncapped — only its count is used, so the cap can say
    /// what it left out.
    private var rankedCatalog: [CatalogPlugin] {
        let available = catalog.filter { !$0.installed }
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return available }
        return available.filter { p in
            let name = p.name.lowercased()
            return name.contains(q)
                || (p.author ?? "").lowercased().contains(q)
                || (p.description ?? "").lowercased().contains(q)
                || (p.category ?? "").lowercased().contains(q)
        }
    }

    // MARK: - Install sheet

    private var installSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle").foregroundStyle(.tint)
                Text("Install a plugin").font(.headline)
                Spacer()
                Button("Close") { installSheetOpen = false }
                    .keyboardShortcut(.escape, modifiers: [])
            }
            Text("Paste a plugin marketplace or plugin repo URL. MARVIN clones it and copies the plugin into ~/.claude/plugins — nothing from the repo is run at install. Only add sources you trust.")
                .font(PaneFont.secondary).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://github.com/owner/marketplace-or-plugin", text: $installURL)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await install() } }

            if !marketplacePlugins.isEmpty {
                MarvinDivider()
                Text("Marketplace \(marketplaceName.map { "“\($0)”" } ?? "") — pick a plugin to install:")
                    .font(PaneFont.action)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(marketplacePlugins) { c in
                            HStack(alignment: .top, spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(c.title).font(.body.monospaced())
                                    if let d = c.description, !d.isEmpty {
                                        Text(d).font(PaneFont.secondary).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                Spacer()
                                Button("Install") { Task { await install(plugin: c.name) } }
                                    .controlSize(.small)
                                    .disabled(installBusy)
                            }
                        }
                    }
                }
                .frame(maxHeight: 220)
            }

            if let err = installError {
                Text(err).font(PaneFont.secondary).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if installBusy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Fetch") { Task { await install() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(installBusy || installURL.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(18)
        .frame(width: 520)
    }

    // MARK: - Networking

    private var apiBase: URL { ServerConfig.baseURL }

    private func refresh() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { isLoading = true; loadError = nil }
        defer { Task { @MainActor in isLoading = false } }

        var comps = URLComponents(url: apiBase.appendingPathComponent("api/plugins"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "workDir", value: workDir)]
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let parsed = try JSONDecoder().decode(PluginsResponse.self, from: data)
            await MainActor.run {
                plugins = parsed.plugins
                if let cat = parsed.catalog { catalog = cat }
            }
        } catch {
            await MainActor.run { loadError = "Failed to load plugins: \(error.localizedDescription)" }
        }
    }

    /// One-click install of a catalog entry from a KNOWN marketplace — no URL
    /// involved; the sidecar resolves it from the local marketplace clone.
    private func installFromCatalog(_ c: CatalogPlugin) async {
        await MainActor.run { installingFromCatalog = c.id }
        defer { Task { @MainActor in installingFromCatalog = nil } }

        var req = URLRequest(url: apiBase.appendingPathComponent("api/plugins/install"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.timeoutInterval = 90
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["marketplace": c.marketplace, "plugin": c.name]
        )
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
                    ?? "HTTP \(http.statusCode)"
                await MainActor.run { fail("Could not install \(c.name)", detail) }
            } else {
                await MainActor.run { flash("Installed \(c.name). Switch it on in the list.") }
                await refresh()
            }
        } catch {
            await MainActor.run { fail("Could not install \(c.name)", error.localizedDescription) }
        }
    }

    /// Something worked; it leaves on its own.
    @MainActor private func flash(_ text: String) {
        show(PaneNotice(kind: .success, text: text))
    }

    /// Something failed; it stays until dismissed. The sentence is ours, the
    /// machine's words go underneath (ADR-0114).
    @MainActor private func fail(_ headline: String, _ detail: String) {
        show(PaneNotice(kind: .error, headline: headline, detail: detail))
    }

    @MainActor private func show(_ n: PaneNotice) {
        withAnimation { notice = n }
        guard case .auto(let seconds) = n.dismissal else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            withAnimation { if notice == n { notice = nil } }
        }
    }

    /// Flip one plugin's enabled state → POST the full enabled set.
    private func toggle(_ p: PluginSummary) async {
        guard let workDir = bridge.projectWorkDir else { return }
        var enabled = Set(plugins.filter { $0.enabled }.map { $0.name })
        if p.enabled { enabled.remove(p.name) } else { enabled.insert(p.name) }

        var req = URLRequest(url: apiBase.appendingPathComponent("api/plugins"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["workDir": workDir, "enabled": Array(enabled).sorted()]
        )
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                let parsed = try? JSONDecoder().decode(PluginsResponse.self, from: data)
                await MainActor.run {
                    if let parsed { plugins = parsed.plugins }
                    flash(p.enabled ? "Disabled \(p.name)" : "Enabled \(p.name)")
                }
            } else {
                // A non-2xx that did not throw used to do nothing at all, so a
                // refused toggle looked exactly like a no-op (ADR-0114).
                let http = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http)"
                await MainActor.run { fail("Could not change \(p.name)", detail) }
            }
        } catch {
            await MainActor.run { fail("Could not change \(p.name)", error.localizedDescription) }
        }
    }

    private func install(plugin: String? = nil) async {
        let url = installURL.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }
        await MainActor.run { installBusy = true; installError = nil }
        defer { Task { @MainActor in installBusy = false } }

        var body: [String: Any] = ["url": url]
        if let plugin { body["plugin"] = plugin }

        var req = URLRequest(url: apiBase.appendingPathComponent("api/plugins/install"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.timeoutInterval = 90
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        struct InstallResponse: Decodable {
            let installed: Installed?
            let marketplace: Marketplace?
            let error: String?
            struct Installed: Decodable { let name: String; let key: String }
            struct Marketplace: Decodable { let name: String; let plugins: [InstallCandidate] }
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let decoded = try? JSONDecoder().decode(InstallResponse.self, from: data)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                await MainActor.run { installError = decoded?.error ?? "Install failed (HTTP \(http.statusCode))." }
                return
            }
            if let mkt = decoded?.marketplace, !mkt.plugins.isEmpty {
                await MainActor.run { marketplacePlugins = mkt.plugins; marketplaceName = mkt.name; installError = nil }
                return
            }
            if let installed = decoded?.installed {
                await MainActor.run {
                    flash("Installed \(installed.name). Switch it on in the list.")
                    installSheetOpen = false
                    installURL = ""; marketplacePlugins = []; marketplaceName = nil
                }
                await refresh()
                return
            }
            await MainActor.run { installError = decoded?.error ?? "Nothing was installed." }
        } catch {
            await MainActor.run { installError = error.localizedDescription }
        }
    }

    // MARK: - Updates (ADR-0071)

    /// POST /api/plugins/update. `checkOnly` reports without installing.
    private func postUpdate(body: [String: Any]) async -> UpdateResponse? {
        var req = URLRequest(url: apiBase.appendingPathComponent("api/plugins/update"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        // A bulk check shallow-clones once per plugin — generous, but bounded.
        req.timeoutInterval = 180
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            return try? JSONDecoder().decode(UpdateResponse.self, from: data)
        } catch {
            await MainActor.run { fail("Update check failed", error.localizedDescription) }
            return nil
        }
    }

    /// Check every plugin with a recorded source. Installs nothing — the row
    /// buttons do that, so a check is always safe to run.
    private func checkAllUpdates() async {
        await MainActor.run { checkingUpdates = true }
        defer { Task { @MainActor in checkingUpdates = false } }

        guard let resp = await postUpdate(body: ["all": true, "checkOnly": true]) else { return }
        let results = resp.results ?? []
        await MainActor.run {
            for r in results { updateStatus[r.key] = r.status }
            let available = results.filter { $0.status == "update-available" }.count
            let failed = results.filter { $0.status == "error" }.count
            if results.isEmpty {
                show(PaneNotice(kind: .info, text: "Nothing to check — no plugin here was installed by MARVIN."))
            } else if available == 0 {
                if failed == 0 {
                    flash("All \(results.count) up to date.")
                } else {
                    // Something could not be checked. That is a warning, and a
                    // warning waits to be read (ADR-0114).
                    show(PaneNotice(kind: .warning, headline: "All up to date, but \(failed) could not be checked.", detail: "They have no recorded source, or the fetch failed."))
                }
            } else {
                flash("\(available) update\(available == 1 ? "" : "s") available.")
            }
        }
    }

    /// Update every plugin the last check found a newer version of, one after
    /// another, and say once what happened.
    private func updateAllAvailable() async {
        let targets = plugins.filter { $0.source?.updatable == true && updateStatus[$0.key] == "update-available" }
        guard !targets.isEmpty else { return }
        await MainActor.run { bulkUpdating = true }
        defer { Task { @MainActor in bulkUpdating = false; updatingKey = nil } }
        var updated = 0
        var failed = 0
        for p in targets {
            await MainActor.run { updatingKey = p.key }
            guard let outcome = await postUpdate(body: ["key": p.key])?.results?.first else { failed += 1; continue }
            await MainActor.run { updateStatus[p.key] = outcome.status }
            if outcome.status == "updated" || outcome.status == "up-to-date" { updated += 1 } else { failed += 1 }
        }
        await MainActor.run {
            if failed == 0 {
                flash("Updated \(updated) plugin\(updated == 1 ? "" : "s").")
            } else {
                show(PaneNotice(kind: .warning, headline: "Updated \(updated), \(failed) could not be updated.",
                                detail: "Open the plugin's … menu to check its source."))
            }
        }
        await refresh()
    }

    /// Fetch and install the latest for one plugin.
    private func updateOne(_ p: PluginSummary) async {
        await MainActor.run { updatingKey = p.key }
        defer { Task { @MainActor in updatingKey = nil } }

        guard let resp = await postUpdate(body: ["key": p.key]) else { return }
        guard let outcome = resp.results?.first else {
            await MainActor.run { fail("Could not update \(p.name)", resp.error ?? "The update returned nothing.") }
            return
        }
        await MainActor.run {
            updateStatus[p.key] = outcome.status
            switch outcome.status {
            case "updated":
                let to = outcome.toVersion.map { " → v\($0)" } ?? ""
                flash("Updated \(outcome.name)\(to).")
            case "up-to-date":
                flash("\(outcome.name) is already up to date.")
            default:
                fail("Could not update \(outcome.name)", outcome.error ?? "unknown error")
            }
        }
        if outcome.status == "updated" { await refresh() }
    }
}

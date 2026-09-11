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

struct PluginsPane: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var plugins: [PluginSummary] = []
    @State private var catalog: [CatalogPlugin] = []
    @State private var loadError: String?
    @State private var isLoading = false
    /// The outcome of the last action, with its kind (ADR-0114). "Installed
    /// marvin-graph" and "Install failed: HTTP 500" used to be the same
    /// pixels behind the same puzzle-piece icon, both gone in three seconds.
    @State private var notice: PaneNotice?
    /// Catalog search text + the one catalog entry currently installing.
    @State private var catalogSearch = ""
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
                PaneEmptyView(state: .noProject("plugins"))
            } else if let err = loadError, plugins.isEmpty {
                PaneEmptyView(
                    state: PaneEmptyState(headline: "Could not read the installed plugins", hint: err, symbol: "exclamationmark.triangle"),
                    actionTitle: "Retry",
                    action: { Task { await refresh() } }
                )
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
        ScrollView {
            // LazyVStack for the same reason as SkillsPane: the installed +
            // marketplace lists are long, and a plain VStack lays every row
            // out on the tab switch. `/api/plugins` answers in 3.7 ms — the
            // cost is layout, not data.
            LazyVStack(alignment: .leading, spacing: 12) {
                PaneSectionHeader(title: "Project plugins", count: plugins.count, tint: Color.accentColor) {
                    paneActions
                }
                Text("Installed Claude Code plugins (from ~/.claude/plugins). Toggle one on to load its skills + commands + gated MCP + read-only agents for THIS project (ADR-0053/0054). Hooks are never loaded.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if plugins.isEmpty {
                    Text("No plugins installed. Install one from the catalog below, or via the Claude Code /plugin UI — it lands in the same place.")
                        .font(.caption).foregroundStyle(.tertiary)
                        .padding(.vertical, 6)
                } else {
                    ForEach(plugins) { p in pluginRow(p) }
                }

                if !catalog.isEmpty {
                    MarvinDivider()
                    catalogSection
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
    }

    /// Pane-local actions — see the note on `SkillsPane.paneActions` for why
    /// these are not `ToolbarItem`s.
    private var paneActions: some View {
        HStack(spacing: 10) {
            Button {
                installError = nil; marketplacePlugins = []; marketplaceName = nil
                installSheetOpen = true
            } label: {
                Label("Install", systemImage: "arrow.down.circle")
            }
            .help("Install — add a plugin from a marketplace or Git URL (ADR-0053)")
            Button { Task { await checkAllUpdates() } } label: {
                Label("Check for updates", systemImage: "arrow.triangle.2.circlepath")
            }
            .help(updatableCount == 0
                  ? "Check for updates — nothing to check: no plugin here was installed by MARVIN (ones from the Claude Code /plugin UI have no recorded source)."
                  : "Check for updates — re-fetch the \(updatableCount) plugin\(updatableCount == 1 ? "" : "s") MARVIN installed and report which changed upstream. Installs nothing (ADR-0071).")
            .disabled(checkingUpdates || updatableCount == 0)
            Button { Task { await refresh() } } label: {
                Label("Reload list", systemImage: "arrow.clockwise")
            }
            .help("Reload the installed list from disk (does not check upstream)")
            .disabled(isLoading)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .controlSize(.small)
    }

    /// How many rows could be updated at all — drives the toolbar button's
    /// enabled state so "Check for updates" isn't offered when nothing here
    /// has a recorded source.
    private var updatableCount: Int {
        plugins.filter { $0.source?.updatable == true }.count
    }

    @ViewBuilder
    private func pluginRow(_ p: PluginSummary) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // A real switch. This was a `.buttonStyle(.plain)` SF Symbol with
            // no hover, no press, no focus ring and no accessibility trait —
            // and switching it on loads the plugin's MCP servers and agents
            // into the model's tool surface (ADR-0114).
            PaneEnableToggle(
                isOn: p.enabled,
                help: p.enabled ? "Enabled for this project — switch off to unload it here."
                                : "Disabled here — switch on to load its skills, commands, gated MCP and read-only agents for this project."
            ) { _ in Task { await toggle(p) } }
            .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(p.name)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    if let v = p.version, !v.isEmpty, v != "unknown" {
                        Text("v\(v)")
                            .font(.system(size: 9.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    authorChip(author: p.author, marketplace: p.marketplace)
                }
                if let d = p.description, !d.isEmpty {
                    Text(d)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                contributionChips(p)
            }
            Spacer()
            updateControl(p)
        }
        .padding(.vertical, 3)
        .frame(minWidth: 0, alignment: .leading)
        .clipped()
        .contextMenu { pluginMenu(p) }
    }

    /// Update affordance for one plugin (ADR-0071).
    ///
    /// Three states, deliberately distinct: no recorded source (nothing to do —
    /// explain why rather than showing a dead button), a known update waiting,
    /// and the neutral idle state where Update means "check, then fetch if
    /// there's anything new".
    @ViewBuilder
    private func updateControl(_ p: PluginSummary) -> some View {
        let status = updateStatus[p.key]
        if p.source?.updatable != true {
            // A dead grey label sat here where Skills offers a control for the
            // identical problem. Re-installing through MARVIN records the
            // source, which is the way out — so it is a button (ADR-0114).
            Button("Set source…") {
                installError = nil; marketplacePlugins = []; marketplaceName = nil
                installURL = p.source?.url ?? ""
                installSheetOpen = true
            }
            .rowChip(.neutral)
            .help("MARVIN didn't install this one, so it has no recorded URL to re-fetch from. Installing it through MARVIN once records the source and enables updates.")
        } else if updatingKey == p.key {
            ProgressView().controlSize(.small)
        } else {
            HStack(spacing: 6) {
                if status == "update-available" {
                    statusChip("update available", tint: .orange)
                } else if status == "up-to-date" {
                    statusChip("up to date", tint: MarvinTheme.textMuted)
                } else if status == "updated" {
                    statusChip("updated", tint: GitDecorationColor.added)
                }
                Button("Update") { Task { await updateOne(p) } }
                    .rowChip(.primary)
                    .disabled(updatingKey != nil || checkingUpdates)
                    .help(sourceHelp(p.source))
            }
        }
    }

    private func sourceHelp(_ s: SourceInfo?) -> String {
        guard let s else { return "Re-fetch this plugin." }
        let origin = s.url ?? s.marketplace ?? "its recorded source"
        return "Re-fetch from \(origin). Last updated \(s.lastUpdated)."
    }

    /// Small chips summarising what the plugin contributes. Loaded contributions
    /// are tinted; deferred ones (agents/hooks) are muted with a "·off" hint.
    @ViewBuilder
    private func contributionChips(_ p: PluginSummary) -> some View {
        HStack(spacing: 5) {
            if !p.skills.isEmpty { chip("\(p.skills.count) skills", loaded: true) }
            if !p.commands.isEmpty { chip("\(p.commands.count) cmds", loaded: true) }
            if p.hasMcp { chip("MCP · gated", loaded: true) }
            if !p.agents.isEmpty { chip("\(p.agents.count) agents · read-only", loaded: true) }
            // Not a count like the others: it is the one line that says what
            // MARVIN refuses to load (ADR-0054). It reads as a caution, not as
            // another tally.
            if p.hasHooks { chip("hooks · off", loaded: false, caution: true) }
        }
    }

    private func chip(_ text: String, loaded: Bool, caution: Bool = false) -> some View {
        let tint: Color = caution ? .orange : (loaded ? Color.accentColor : .secondary)
        return Text(text)
            .font(.system(size: 9.5, design: .monospaced))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(tint)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(tint.opacity(caution ? 0.16 : 0.12)))
    }

    /// One shape for every update status. Three existed: a capsule, grey text
    /// and green text, for three states of the same thing (ADR-0114).
    private func statusChip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 9.5))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(tint)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(tint.opacity(0.14)))
    }

    /// Provenance: a sealed "Anthropic" badge for first-party plugins, the
    /// plain author name otherwise, always followed by the marketplace.
    @ViewBuilder
    private func authorChip(author: String?, marketplace: String?) -> some View {
        let isAnthropic = (author ?? "").caseInsensitiveCompare("Anthropic") == .orderedSame
        HStack(spacing: 4) {
            if let author, !author.isEmpty {
                HStack(spacing: 2) {
                    if isAnthropic {
                        Image(systemName: "checkmark.seal.fill").font(.system(size: 8))
                    }
                    Text(author)
                        .font(.system(size: 9.5))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .foregroundStyle(isAnthropic ? Color.accentColor : Color.secondary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(
                    Capsule().fill((isAnthropic ? Color.accentColor : Color.secondary).opacity(0.12))
                )
            }
            if let marketplace, !marketplace.isEmpty {
                // The one thing here allowed to truncate: it is provenance,
                // not identity, and it is the longest string on the row.
                Text(marketplace)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        // Never taller than one line, whatever the width: an author chip that
        // reflows into a column of letters is what narrow panes produced
        // before (2026-09-11).
        .frame(minWidth: 0, alignment: .leading)
        .clipped()
    }

    // MARK: - Marketplace catalog (browse + one-click install)

    /// Not-yet-installed catalog entries matching the search. Ranking: name
    /// prefix first, then name contains, then description/category matches —
    /// so "sec" surfaces `security-*` plugins before ones that merely mention
    /// security in prose.
    private struct RankedPlugin {
        let plugin: CatalogPlugin
        let rank: Int
    }

    /// Whether the catalog list is a search result rather than the head of
    /// the list.
    private var searching: Bool {
        !catalogSearch.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// How many entries the current search actually matched, before the cap.
    private var matchCount: Int { rankedCatalog.count }

    private var filteredCatalog: [CatalogPlugin] {
        let available = catalog.filter { !$0.installed }
        let q = catalogSearch.trimmingCharacters(in: .whitespaces).lowercased()
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

    /// The same ranking, uncapped — only its count is used, so the cap above
    /// can say what it left out.
    private var rankedCatalog: [CatalogPlugin] {
        let available = catalog.filter { !$0.installed }
        let q = catalogSearch.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return available }
        return available.filter { p in
            let name = p.name.lowercased()
            return name.contains(q)
                || (p.author ?? "").lowercased().contains(q)
                || (p.description ?? "").lowercased().contains(q)
                || (p.category ?? "").lowercased().contains(q)
        }
    }

    @ViewBuilder
    private var catalogSection: some View {
        let availableCount = catalog.filter { !$0.installed }.count
        let shown = filteredCatalog
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "storefront").foregroundStyle(.tint)
                Text("Available from marketplaces").font(.headline)
                Text("\(availableCount)")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                Spacer()
            }
            Text("Everything your marketplaces offer (same catalogs as the Claude Code /plugin browser). Install copies the plugin into ~/.claude/plugins; then toggle it on above.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Search \(availableCount) plugins…", text: $catalogSearch)
                .textFieldStyle(.roundedBorder)
            if shown.isEmpty {
                Text(catalogSearch.isEmpty ? "Nothing available." : "No match for “\(catalogSearch)”.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(shown) { c in catalogRow(c) }
                // Both caps are now named. The unsearched list was capped at
                // 15 and said so; a SEARCH capped at 50 said nothing, so a
                // query matching 80 silently showed 50 (ADR-0114).
                if searching {
                    if matchCount > shown.count {
                        Text("Showing the closest \(shown.count) of \(matchCount) matches — narrow the search to see the rest.")
                            .font(.system(size: 9.5)).foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if availableCount > shown.count {
                    Text("Showing \(shown.count) of \(availableCount) — search to find more.")
                        .font(.system(size: 9.5)).foregroundStyle(.tertiary)
                }
            }
        }
    }

    /// What a row offers beyond enable/disable.
    ///
    /// Deliberately NOT an uninstall. MARVIN clones a plugin but records it in
    /// `~/.claude/plugins/installed_plugins.json`, which Claude Code owns and
    /// both tools read — removing one from there is a cross-tool destructive
    /// edit, and Claude Code's own `/plugin` UI is where it belongs. What was
    /// missing here was any way to *get at* the thing, which is this
    /// (ADR-0114).
    @ViewBuilder
    private func pluginMenu(_ p: PluginSummary) -> some View {
        // `/api/plugins` does not send an install path, so this opens the
        // directory every plugin lives in rather than inventing a field.
        Button("Reveal the plugins folder") {
            let root = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".claude/plugins")
            NSWorkspace.shared.activateFileViewerSelecting([root])
        }
        Button("Copy plugin name") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(p.name, forType: .string)
        }
        if let url = p.source?.url, !url.isEmpty {
            Button("Copy source URL") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
            }
        }
        Divider()
        Button("Uninstalling is Claude Code's /plugin UI") {}
            .disabled(true)
    }

    private func catalogRow(_ c: CatalogPlugin) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(c.title).font(.body.monospaced())
                    if let cat = c.category, !cat.isEmpty {
                        Text(cat)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.secondary.opacity(0.12)))
                    }
                    authorChip(author: c.author, marketplace: c.marketplace)
                }
                if let d = c.description, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Button {
                Task { await installFromCatalog(c) }
            } label: {
                if installingFromCatalog == c.id {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Install")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(installingFromCatalog != nil)
        }
        .padding(.vertical, 2)
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
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://github.com/owner/marketplace-or-plugin", text: $installURL)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await install() } }

            if !marketplacePlugins.isEmpty {
                MarvinDivider()
                Text("Marketplace \(marketplaceName.map { "“\($0)”" } ?? "") — pick a plugin to install:")
                    .font(.caption.weight(.medium))
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(marketplacePlugins) { c in
                            HStack(alignment: .top, spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(c.title).font(.body.monospaced())
                                    if let d = c.description, !d.isEmpty {
                                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
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
                Text(err).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
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
                await MainActor.run { flash("Installed \(c.name) — toggle it on above.") }
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
                    flash("Installed \(installed.name) — enable it below.")
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

    /// Kept for the in-section placeholders, which are a sentence in a list
    /// rather than a whole-pane state (ADR-0114).
    @ViewBuilder
    private func emptyView(_ message: String) -> some View {
        VStack {
            Spacer()
            Text(message).foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

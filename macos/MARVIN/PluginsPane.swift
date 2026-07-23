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
// v1 loads a plugin's skills + slash commands + (gated) MCP; its agents and
// hooks are shown but NOT loaded (Golden Rule 1 / tool-flow safety). All data
// comes from `GET /api/plugins?workDir=…`; the pane re-fetches on project
// change and after a mutation.

import AppKit
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
    var id: String { key }
}

// MARK: - View

struct PluginsPane: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var plugins: [PluginSummary] = []
    @State private var catalog: [CatalogPlugin] = []
    @State private var loadError: String?
    @State private var isLoading = false
    @State private var toast: String?
    /// Catalog search text + the one catalog entry currently installing.
    @State private var catalogSearch = ""
    @State private var installingFromCatalog: String?

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
                emptyView("Open a project to manage its plugins.")
            } else if let err = loadError, plugins.isEmpty {
                emptyView(err)
            } else {
                content
            }
            if let toast {
                HStack {
                    Image(systemName: "puzzlepiece.extension.fill")
                    Text(toast).font(.caption)
                    Spacer()
                }
                .padding(8)
                .background(.tint.opacity(0.12))
                .transition(.opacity)
            }
        }
        .task(id: bridge.projectWorkDir) { await refresh() }
        .sheet(isPresented: $installSheetOpen) { installSheet }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "puzzlepiece.extension").foregroundStyle(.tint)
                    Text("Project plugins").font(.headline)
                    Text("\(plugins.count)")
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                    Spacer()
                }
                Text("Installed Claude Code plugins (from ~/.claude/plugins). Toggle one on to load its skills + commands + gated MCP for THIS project. Agents and hooks are shown but not loaded in v1 (ADR-0053).")
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
                    Divider()
                    catalogSection
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    installError = nil; marketplacePlugins = []; marketplaceName = nil
                    installSheetOpen = true
                } label: {
                    Label("Install", systemImage: "arrow.down.circle")
                }
                .help("Install a plugin from a marketplace or Git URL (ADR-0053)")
            }
            ToolbarItem(placement: .automatic) {
                Button { Task { await refresh() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh")
                .disabled(isLoading)
            }
        }
    }

    @ViewBuilder
    private func pluginRow(_ p: PluginSummary) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Button {
                Task { await toggle(p) }
            } label: {
                Image(systemName: p.enabled ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(p.enabled ? Color.green : .secondary)
                    .font(.system(size: 15))
            }
            .buttonStyle(.plain)
            .help(p.enabled ? "Enabled for this project — click to disable."
                            : "Disabled here — click to enable for this project.")

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(p.name).font(.body.monospaced())
                    if let v = p.version, !v.isEmpty, v != "unknown" {
                        Text("v\(v)").font(.caption2).foregroundStyle(.tertiary)
                    }
                    authorChip(author: p.author, marketplace: p.marketplace)
                }
                if let d = p.description, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                contributionChips(p)
            }
            Spacer()
        }
        .padding(.vertical, 3)
    }

    /// Small chips summarising what the plugin contributes. Loaded contributions
    /// are tinted; deferred ones (agents/hooks) are muted with a "·off" hint.
    @ViewBuilder
    private func contributionChips(_ p: PluginSummary) -> some View {
        HStack(spacing: 5) {
            if !p.skills.isEmpty { chip("\(p.skills.count) skills", loaded: true) }
            if !p.commands.isEmpty { chip("\(p.commands.count) cmds", loaded: true) }
            if p.hasMcp { chip("MCP · gated", loaded: true) }
            if !p.agents.isEmpty { chip("\(p.agents.count) agents · off", loaded: false) }
            if p.hasHooks { chip("hooks · off", loaded: false) }
        }
    }

    private func chip(_ text: String, loaded: Bool) -> some View {
        Text(text)
            .font(.caption2.monospaced())
            .foregroundStyle(loaded ? Color.accentColor : .secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(
                Capsule().fill((loaded ? Color.accentColor : Color.secondary).opacity(0.12))
            )
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
                    Text(author).font(.caption2)
                }
                .foregroundStyle(isAnthropic ? Color.accentColor : Color.secondary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(
                    Capsule().fill((isAnthropic ? Color.accentColor : Color.secondary).opacity(0.12))
                )
            }
            if let marketplace, !marketplace.isEmpty {
                Text(marketplace).font(.caption2).foregroundStyle(.tertiary)
            }
        }
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
                if catalogSearch.trimmingCharacters(in: .whitespaces).isEmpty && availableCount > shown.count {
                    Text("Showing \(shown.count) of \(availableCount) — search to find more.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
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
                Divider()
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
                await MainActor.run { toast = "Install failed: \(detail)" }
            } else {
                await MainActor.run { toast = "Installed \(c.name) — toggle it on above." }
                await refresh()
            }
        } catch {
            await MainActor.run { toast = "Install failed: \(error.localizedDescription)" }
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        await MainActor.run { toast = nil }
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
                    toast = p.enabled ? "Disabled \(p.name)" : "Enabled \(p.name)"
                }
            }
        } catch {
            await MainActor.run { toast = "Toggle failed: \(error.localizedDescription)" }
        }
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        await MainActor.run { toast = nil }
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
                    toast = "Installed \(installed.name) — enable it below."
                    installSheetOpen = false
                    installURL = ""; marketplacePlugins = []; marketplaceName = nil
                }
                await refresh()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await MainActor.run { toast = nil }
                return
            }
            await MainActor.run { installError = decoded?.error ?? "Nothing was installed." }
        } catch {
            await MainActor.run { installError = error.localizedDescription }
        }
    }

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

// SkillsPane — the Skills tab inside LeftPane (ADR-0025).
//
// Three sections + an audit-decision footer:
//
//   ⚡ Suggested for this project   (driven by fingerprint tags)
//   📦 User-global  (~/.claude/skills/)
//   📁 Project-local  (<workDir>/.marvin/skills/)
//
// All data comes from `GET /api/skills?workDir=…`. The pane re-fetches
// when the active project changes (observed via MarvinBridge) and on
// explicit refresh. Mutations (`park` / `unpark`) hit the matching
// POST/DELETE endpoints; on success the pane re-fetches so the audit
// footer flips immediately.
//
// Trust contract per ADR-0025:
//   • view   — opens SKILL.md in the existing file viewer (read-only).
//   • install — drops a chat instruction; user runs the command.
//   • build   — drops a chat instruction invoking skill-creator.
//   • park    — writes <workDir>/.marvin/skills.md; one click closes the
//               audit-pending firm-surface block until next change.
//   • unpark  — deletes the file; re-arms the audit on next session.
//
// We don't auto-`git clone` or auto-mutate the skills directories.

import AppKit
import SwiftUI

// MARK: - Wire types (decoded from /api/skills)

/// Recorded install provenance for one skill (ADR-0071).
struct SkillSourceInfo: Decodable {
    let url: String?
    let marketplace: String?
    let plugin: String?
    let installedAt: String
    let lastUpdated: String
    /// False when the record exists but can't be re-fetched from.
    let updatable: Bool
}

/// One row's result from POST /api/skills/update.
private struct SkillUpdateOutcome: Decodable {
    let name: String
    let scope: String
    /// "updated" | "up-to-date" | "update-available" | "error"
    let status: String
    let error: String?
}

private struct SkillUpdateResponse: Decodable {
    let ok: Bool?
    let error: String?
    let results: [SkillUpdateOutcome]?
}

private struct SkillsIndexResponse: Decodable {
    let fingerprint: FingerprintBlock
    let suggestions: [Suggestion]
    let userGlobal: [InstalledSkill]
    let projectLocal: [ProjectLocalSkill]
    let audit: AuditBlock
    let discovered: DiscoveredBlock?
    /// ADR-0037 — which installed skills are ACTIVE for this project.
    let enablement: Enablement?

    struct Enablement: Decodable {
        let active: [String]
        let explicit: Bool
        let core: [String]
    }

    struct FingerprintBlock: Decodable {
        let tags: [String]
        let detectedAt: String
    }

    struct Suggestion: Decodable, Identifiable {
        let name: String
        let verb: String          // "install" | "build"
        let matchedTags: [String]
        let rationale: String
        let alreadyInstalled: Bool
        let scope: String          // "user-global" | "project-local"

        var id: String { "\(verb):\(name)" }
    }

    struct InstalledSkill: Decodable, Identifiable {
        let name: String
        let description: String
        let path: String
        /// Where MARVIN fetched this from (ADR-0071). Absent for skills the
        /// user authored, copied in by hand, or installed before provenance
        /// existed — those get a one-time "set source" instead of Update.
        let source: SkillSourceInfo?
        var id: String { path }
    }

    /// Why the agent's skill loader will skip a SKILL.md, or register it
    /// under a name its frontmatter disagrees with. `blocked` means the
    /// `Skill` tool has never heard of it — the pane used to show these as
    /// active, which is how MARVIN came to call one 29 times.
    struct SkillLoadIssue: Decodable {
        let blocked: Bool
        let reason: String
    }

    struct ProjectLocalSkill: Decodable, Identifiable {
        let name: String
        let description: String
        let path: String
        let shadowsUserGlobal: Bool
        let source: SkillSourceInfo?
        let loadIssue: SkillLoadIssue?
        var id: String { path }
    }

    struct AuditBlock: Decodable {
        let decided: Bool
        let skillsMdPath: String
        let decisionLine: String?
    }

    /// LLM-discovered build suggestions (ADR-0028, development branch).
    /// Populated by POST /api/skills/discover; null on a stable build that
    /// doesn't yet have the discoverer wired.
    struct DiscoveredBlock: Decodable {
        let suggestions: [DiscoveredSuggestion]
        let discoveredAt: String?
        let costCents: Int?
        let stale: Bool
    }

    struct DiscoveredSuggestion: Decodable, Identifiable {
        let name: String
        let description: String
        let rationale: String
        let suggestedBody: String
        var id: String { name }
    }
}

// MARK: - View

struct SkillsPane: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var index: SkillsIndexResponse?
    @State private var loadError: String?
    @State private var isLoading: Bool = false
    @State private var inFlightAction: String?
    @State private var explainSuggestion: SkillsIndexResponse.Suggestion?
    /// One-line confirmation surface for clipboard-driven actions.
    /// Auto-clears after a short delay so it doesn't pile up.
    @State private var pasteboardToast: String?
    /// Skill content shown in the View sheet. Loaded via /api/skills/content,
    /// which whitelists ~/.claude/skills/ and <workDir>/.marvin/skills/.
    /// Skills live outside the project workDir so the standard sandboxed
    /// file viewer can't open them.
    @State private var viewedSkill: ViewedSkill?
    /// In-flight discovery state — ADR-0028 development-branch feature.
    /// `discovering = true` while POST /api/skills/discover is open; the
    /// section UI shows a spinner during that window.
    @State private var discovering: Bool = false
    /// Per-suggestion build-in-flight state — keyed by suggestion name so
    /// clicking Build on one suggestion doesn't disable Build on the others.
    @State private var buildingSuggestion: String?
    /// Detailed-explanation popover for a discovered suggestion's rationale + body.
    @State private var inspectedDiscovered: SkillsIndexResponse.DiscoveredSuggestion?

    // ADR-0071 — update state. Keyed "<scope>:<name>" because a project-local
    // and a user-global skill can share a name (project-local shadows it).
    @State private var updateStatus: [String: String] = [:]
    @State private var updatingSkill: String?
    @State private var checkingUpdates = false
    /// "Set source" sheet — binds a URL to a skill that has no provenance.
    @State private var bindSourceFor: BindTarget?
    @State private var bindURL = ""
    @State private var bindBusy = false
    @State private var bindError: String?

    struct BindTarget: Identifiable {
        let name: String
        let scope: String
        var id: String { "\(scope):\(name)" }
    }

    // ADR-0039 — "Add from GitHub" sheet state.
    @State private var addSheetOpen = false
    @State private var addURL = ""
    @State private var addScope = "user-global"
    @State private var addBusy = false
    @State private var addError: String?
    /// Pick-list returned when the repo holds >1 skill.
    @State private var addCandidates: [AddCandidate] = []
    @State private var addSelected: Set<String> = []
    /// Marketplace plugin pick-list (phase B) + the marketplace name.
    @State private var addPlugins: [AddCandidate] = []
    @State private var addMarketplace: String?

    struct AddCandidate: Decodable, Identifiable {
        let name: String
        let displayName: String?
        let description: String?
        var id: String { name }
        var title: String { displayName ?? name }
    }

    /// The currently-displayed skill in the View sheet.
    struct ViewedSkill: Identifiable, Equatable {
        let name: String
        let path: String
        let content: String
        var id: String { path }
    }

    var body: some View {
        VStack(spacing: 0) {
            if bridge.projectWorkDir == nil {
                emptyView("Open a project to see its skills.")
            } else if let err = loadError, index == nil {
                emptyView(err)
            } else if let idx = index {
                content(idx)
            } else {
                emptyView(isLoading ? "Loading…" : "No data.")
            }
            if let toast = pasteboardToast {
                HStack {
                    Image(systemName: "doc.on.clipboard.fill")
                    Text(toast).font(.caption)
                    Spacer()
                }
                .padding(8)
                .background(.tint.opacity(0.12))
                .transition(.opacity)
            }
        }
        .task(id: bridge.projectWorkDir) { await refresh() }
        .sheet(item: $viewedSkill) { skill in
            skillViewerSheet(skill)
        }
        .sheet(item: $inspectedDiscovered) { suggestion in
            discoveredDetailSheet(suggestion)
        }
        .sheet(isPresented: $addSheetOpen) { addFromGitSheet }
        .sheet(item: $bindSourceFor) { target in bindSourceSheet(target) }
    }

    // MARK: - Add from GitHub (ADR-0039)

    private var addFromGitSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle").foregroundStyle(.tint)
                Text("Add a skill from GitHub").font(.headline)
                Spacer()
                Button("Close") { addSheetOpen = false }
                    .keyboardShortcut(.escape, modifiers: [])
            }
            Text("Paste a Git repo URL — a single skill, a multi-skill repo, or a plugin marketplace (MARVIN detects which). It clones and copies the SKILL.md folder(s) in; it never runs anything from the repo. Third-party skills can carry scripts — only add sources you trust.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://github.com/owner/repo  ·  …/tree/main/skills/<name>", text: $addURL)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await fetchSkills() } }
            Picker("Install to", selection: $addScope) {
                Text("User-global (~/.claude/skills)").tag("user-global")
                Text("This project (.marvin/skills)").tag("project-local")
            }
            .pickerStyle(.radioGroup)
            .disabled(bridge.projectWorkDir == nil && addScope == "project-local")

            // Marketplace (phase B): pick a plugin → installs its skills.
            if !addPlugins.isEmpty {
                MarvinDivider()
                Text("Marketplace \(addMarketplace.map { "“\($0)”" } ?? "") — pick a plugin to install its skills:")
                    .font(.caption.weight(.medium))
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(addPlugins) { p in
                            HStack(alignment: .top, spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(p.title).font(.body.monospaced())
                                    if let d = p.description, !d.isEmpty {
                                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                Spacer()
                                Button("Install") { Task { await fetchSkills(plugin: p.name) } }
                                    .controlSize(.small)
                                    .disabled(addBusy)
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
            }
            // Multi-skill repo: pick which skills.
            if !addCandidates.isEmpty {
                MarvinDivider()
                Text("This repo has several skills — pick which to install:")
                    .font(.caption.weight(.medium))
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(addCandidates) { c in
                            Toggle(isOn: Binding(
                                get: { addSelected.contains(c.name) },
                                set: { on in if on { addSelected.insert(c.name) } else { addSelected.remove(c.name) } }
                            )) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(c.name).font(.body.monospaced())
                                    if let d = c.description, !d.isEmpty {
                                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
            }

            if let err = addError {
                Text(err).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if addBusy { ProgressView().controlSize(.small) }
                Spacer()
                Button(addCandidates.isEmpty ? "Fetch & install" : "Install selected") {
                    Task { await fetchSkills() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(addBusy || addURL.trimmingCharacters(in: .whitespaces).isEmpty
                          || (!addCandidates.isEmpty && addSelected.isEmpty))
            }
        }
        .padding(18)
        .frame(width: 520)
    }

    private func fetchSkills(plugin: String? = nil) async {
        let url = addURL.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }
        await MainActor.run { addBusy = true; addError = nil }
        defer { Task { @MainActor in addBusy = false } }

        var body: [String: Any] = ["url": url, "scope": addScope]
        if addScope == "project-local", let wd = bridge.projectWorkDir { body["workDir"] = wd }
        if !addSelected.isEmpty { body["only"] = Array(addSelected) }
        if let plugin { body["plugin"] = plugin }

        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/skills/add"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.timeoutInterval = 90
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        struct AddResponse: Decodable {
            let installed: [Installed]?
            let available: [AddCandidate]?
            let marketplace: Marketplace?
            let error: String?
            struct Installed: Decodable { let name: String }
            struct Marketplace: Decodable { let name: String; let plugins: [AddCandidate] }
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let decoded = try? JSONDecoder().decode(AddResponse.self, from: data)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                await MainActor.run { addError = decoded?.error ?? "Add failed (HTTP \(http.statusCode))." }
                return
            }
            if let mkt = decoded?.marketplace, !mkt.plugins.isEmpty {
                await MainActor.run { addPlugins = mkt.plugins; addMarketplace = mkt.name; addCandidates = []; addError = nil }
                return
            }
            if let available = decoded?.available, !available.isEmpty {
                await MainActor.run { addCandidates = available; addPlugins = []; addError = nil }
                return
            }
            if let installed = decoded?.installed, !installed.isEmpty {
                await MainActor.run {
                    pasteboardToast = "Installed: \(installed.map { $0.name }.joined(separator: ", "))"
                    addSheetOpen = false
                    addURL = ""; addCandidates = []; addSelected = []
                    addPlugins = []; addMarketplace = nil
                }
                await refresh()
                return
            }
            await MainActor.run { addError = decoded?.error ?? "Nothing was installed." }
        } catch {
            await MainActor.run { addError = error.localizedDescription }
        }
    }

    // MARK: - Discovered (LLM) suggestions section (ADR-0028)

    @ViewBuilder
    private func discoveredSection(_ block: SkillsIndexResponse.DiscoveredBlock?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(.tint)
                Text("MARVIN suggests building")
                    .font(.headline)
                if let d = block, d.stale {
                    Text("stale — fingerprint changed")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.orange.opacity(0.12))
                        .clipShape(Capsule())
                }
                Spacer()
                Button {
                    Task { await runDiscovery() }
                } label: {
                    if discovering {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.small)
                            Text("Discovering…").font(.caption)
                        }
                    } else {
                        Label(
                            (block?.suggestions.isEmpty ?? true)
                                ? "Discover skills"
                                : "Re-discover",
                            systemImage: "wand.and.stars"
                        )
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(discovering)
            }
            if let d = block, !d.suggestions.isEmpty {
                ForEach(d.suggestions) { s in
                    discoveredRow(s)
                }
                if let at = d.discoveredAt, let cents = d.costCents {
                    Text("Discovered \(shortDate(at)) · \(cents)¢")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                } else if let at = d.discoveredAt {
                    Text("Discovered \(shortDate(at))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            } else {
                Text("Click Discover to ask MARVIN which project-local skills would be most useful for this codebase. One LLM call; ~1–3¢. Suggestions are cached at `.marvin/discovered-skills.json`.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func discoveredRow(_ s: SkillsIndexResponse.DiscoveredSuggestion) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name)
                    .font(.system(.body, design: .monospaced))
                    .fontWeight(.medium)
                Text(s.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            Spacer()
            Button("Why?") { inspectedDiscovered = s }
                .buttonStyle(.borderless)
                .controlSize(.small)
            Button("Build") {
                Task { await buildDiscovered(s) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(buildingSuggestion != nil)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func discoveredDetailSheet(_ s: SkillsIndexResponse.DiscoveredSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(.headline, design: .monospaced))
                    Text(s.description).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Build") { Task { await buildDiscovered(s); inspectedDiscovered = nil } }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                Button("Close") { inspectedDiscovered = nil }
                    .keyboardShortcut(.escape, modifiers: [])
                    .controlSize(.small)
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            MarvinDivider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Rationale").font(.subheadline.bold())
                        Text(s.rationale).font(.callout)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Proposed SKILL.md body").font(.subheadline.bold())
                        Text(s.suggestedBody)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(8)
                            .background(Color(nsColor: .textBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }
        .frame(minWidth: 720, idealWidth: 880, minHeight: 460, idealHeight: 600)
    }

    private func shortDate(_ iso: String) -> String {
        // Convert "2026-05-22T01:37:54Z" → "2026-05-22 01:37"
        if let r = iso.range(of: "T") {
            return iso.prefix(upTo: r.lowerBound) + " " + iso[r.upperBound...].prefix(5)
        }
        return iso
    }

    /// A non-2xx from `/api/skills/discover`. Its own type so the message the
    /// user sees names the status and the server's reason, rather than the
    /// generic URLError text that a swallowed 500 would never have produced.
    private enum DiscoveryError: LocalizedError {
        case server(status: Int, detail: String?)
        var errorDescription: String? {
            switch self {
            case let .server(status, detail):
                return detail.map { "\($0) (HTTP \(status))" } ?? "server returned HTTP \(status)"
            }
        }
    }

    private func runDiscovery() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { self.discovering = true }
        defer { Task { @MainActor in self.discovering = false } }

        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/skills/discover"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.timeoutInterval = 200
        // Deliberately does NOT send the executor model. The discoverer picks
        // Sonnet on purpose ("enough for a structured one-shot — opus would be
        // overkill at ~10× the price"), and this pane was overriding that with
        // whatever the user had selected. Measured 2026-08-30 on a large
        // project: `model: claude-opus-5` → HTTP 500 after 122s, "Claude Code
        // process aborted by user" (the discoverer's own 120s cap firing);
        // no model → HTTP 200 in 90s with suggestions. Same failure on
        // OpenRouter with a non-Claude executor. Provider-correct resolution
        // already happens server-side (ADR-0096), so there is nothing this
        // side needs to contribute.
        let body: [String: Any] = ["workDir": workDir]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            // A 500 carrying a JSON body is NOT a URLSession error, so without
            // this check the failure was swallowed whole: no toast, no error,
            // and `refresh()` re-read an unchanged cache. That is exactly what
            // "I click it and nothing happens" was.
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                throw DiscoveryError.server(status: http.statusCode, detail: detail)
            }
            await refresh()  // re-read /api/skills which now includes the cached discovery
        } catch {
            await MainActor.run {
                self.pasteboardToast = "Discovery failed: \(error.localizedDescription)"
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { self.pasteboardToast = nil }
        }
    }

    private func buildDiscovered(_ s: SkillsIndexResponse.DiscoveredSuggestion) async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { self.buildingSuggestion = s.name }
        defer { Task { @MainActor in self.buildingSuggestion = nil } }

        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/skills/scaffold"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        let body: [String: Any] = [
            "workDir": workDir,
            "name": s.name,
            "description": s.description,
            "body": s.suggestedBody,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
                    ?? "HTTP \(http.statusCode)"
                await MainActor.run {
                    self.pasteboardToast = "Build failed: \(detail)"
                }
            } else {
                await MainActor.run {
                    self.pasteboardToast = "Built \(s.name) at .marvin/skills/\(s.name)/"
                }
            }
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            await MainActor.run { self.pasteboardToast = nil }
            await refresh()
        } catch {
            await MainActor.run {
                self.pasteboardToast = "Build failed: \(error.localizedDescription)"
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { self.pasteboardToast = nil }
        }
    }

    // MARK: - Skill viewer sheet

    @ViewBuilder
    private func skillViewerSheet(_ skill: ViewedSkill) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "scroll")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.name).font(.headline)
                    Text(skill.path).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                Button {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(skill.path, forType: .string)
                } label: {
                    Label("Copy path", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button("Close") { viewedSkill = nil }
                    .keyboardShortcut(.escape, modifiers: [])
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            MarvinDivider()
            ScrollView {
                Text(skill.content)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
        }
        .frame(minWidth: 720, idealWidth: 880, minHeight: 460, idealHeight: 600)
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ idx: SkillsIndexResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                paneActions
                // ADR-0037 — organised around the one question that matters:
                // what is ACTIVE for this project. Active → available to turn
                // on → recommended to add. (Was five flat, overlapping
                // sections that read as "all over the place".)
                activeSection(idx)
                MarvinDivider()
                availableSection(idx)
                MarvinDivider()
                recommendedSection(idx)
                MarvinDivider()
                auditFooter(idx.audit)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
    }

    /// Pane-local actions. These used to be `ToolbarItem`s, which was wrong
    /// twice over: `LeftPane` keeps every pane mounted (opacity-toggled, to
    /// preserve child `@State`), so BOTH the Skills and Plugins toolbars
    /// rendered into the window toolbar at once — six unlabelled icons — and
    /// `.help()` on a `ToolbarItem` button never surfaced a tooltip. A row
    /// inside the pane shows only when the pane does, and `.help()` on a plain
    /// view works everywhere else in this app.
    private var paneActions: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles.rectangle.stack").foregroundStyle(.tint)
            Text("Skills").font(.headline)
            Spacer()
            Button {
                addError = nil; addCandidates = []; addSelected = []
                addPlugins = []; addMarketplace = nil
                addSheetOpen = true
            } label: {
                Label("Add from GitHub", systemImage: "arrow.down.circle")
            }
            .help("Add from GitHub — fetch a skill from a Git repo or marketplace URL (ADR-0039)")
            Button { Task { await checkAllSkillUpdates() } } label: {
                Label("Check for updates", systemImage: "arrow.triangle.2.circlepath")
            }
            .help(updatableSkillCount == 0
                  ? "Check for updates — nothing to check: no installed skill has a recorded source yet. Use “Set source” on a row first."
                  : "Check for updates — re-fetch the \(updatableSkillCount) skill\(updatableSkillCount == 1 ? "" : "s") MARVIN installed and report which changed upstream. Installs nothing (ADR-0071).")
            .disabled(checkingUpdates || updatableSkillCount == 0)
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

    /// Rows that could be updated at all — gates the toolbar button so it
    /// isn't offered on a tree where nothing has a recorded source.
    private var updatableSkillCount: Int {
        guard let idx = index else { return 0 }
        return idx.userGlobal.filter { $0.source?.updatable == true }.count
            + idx.projectLocal.filter { $0.source?.updatable == true }.count
    }

    /// Shared section header: icon · title · count chip.
    private func sectionHeader(_ icon: String, _ tint: Color, _ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(tint)
            Text(title).font(.headline)
            if let count {
                Text("\(count)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
            }
            Spacer()
        }
    }

    /// 1 — what MARVIN actually uses here: active user-global + project-local.
    @ViewBuilder
    private func activeSection(_ idx: SkillsIndexResponse) -> some View {
        let active = idx.userGlobal.filter { activeSkillNames.contains($0.name) }
        // A blocked project-local skill is NOT active — the loader never
        // registered it. It still shows in the list, flagged, because this
        // pane is where you would go to find out why.
        let loadable = idx.projectLocal.filter { $0.loadIssue?.blocked != true }
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("checkmark.seal.fill", .green, "Active in this project",
                          count: active.count + loadable.count)
            Text("What MARVIN uses here — the fingerprint picks these automatically; toggle to change. Skills that aren't active aren't offered to MARVIN for this project (ADR-0037).")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if active.isEmpty && idx.projectLocal.isEmpty {
                Text("Nothing active yet — enable a skill below.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(active) { skill in
                    installedRow(name: skill.name, description: skill.description, path: skill.path,
                                 badge: nil, scope: "user-global", source: skill.source,
                                 active: true,
                                 onToggle: { Task { await toggleSkill(skill.name) } })
                }
                ForEach(idx.projectLocal) { skill in
                    // Project-local skills are authored FOR this project — always
                    // active, no toggle. Invoked as `marvin-project-local:<name>`.
                    installedRow(name: skill.name, description: skill.description, path: skill.path,
                                 badge: skill.loadIssue?.blocked == true ? "not loaded" : "local",
                                 scope: "project-local", source: skill.source,
                                 loadIssue: skill.loadIssue)
                }
            }
        }
    }

    /// 2 — installed on the machine but off here: toggle on to enable.
    @ViewBuilder
    private func availableSection(_ idx: SkillsIndexResponse) -> some View {
        let inactive = idx.userGlobal.filter { !activeSkillNames.contains($0.name) }
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("tray", .gray, "Installed, off in this project", count: inactive.count)
            Text("In ~/.claude/skills/ but not offered to MARVIN here. Toggle on to enable for this project.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if inactive.isEmpty {
                Text("All installed skills are active here.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(inactive) { skill in
                    installedRow(name: skill.name, description: skill.description, path: skill.path,
                                 badge: nil, scope: "user-global", source: skill.source,
                                 active: false,
                                 onToggle: { Task { await toggleSkill(skill.name) } })
                }
            }
        }
    }

    /// 3 — skills not installed/built yet: rule-based + AI-discovered, merged.
    @ViewBuilder
    private func recommendedSection(_ idx: SkillsIndexResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("sparkle", .yellow, "Recommended to add",
                          count: idx.suggestions.isEmpty ? nil : idx.suggestions.count)
            Text("Not installed or built yet — matched to this project's fingerprint (\(idx.fingerprint.tags.count) tags). Install adds a user-global skill; build authors a project-local one.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if idx.suggestions.isEmpty {
                Text("No rule-based suggestions for this fingerprint.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(idx.suggestions) { s in
                    suggestionRow(s)
                }
            }
            // AI discovery (the Discover button + its results) folds in here
            // rather than as a separate top-level section.
            discoveredSection(idx.discovered)
        }
    }

    @ViewBuilder
    private func suggestionRow(_ s: SkillsIndexResponse.Suggestion) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: s.verb == "install" ? "shippingbox" : "hammer")
                .foregroundStyle(s.verb == "install" ? .blue : .green)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.name)
                        .font(.body.monospaced())
                        .fontWeight(.medium)
                    if s.alreadyInstalled {
                        Text("INSTALLED")
                            .font(.caption2)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.tint.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                Text(s.rationale)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 4) {
                if !s.alreadyInstalled {
                    Button(s.verb == "install" ? "Install" : "Build") {
                        Task { await dispatchInstallOrBuild(s) }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(inFlightAction == s.id)
                }
                Button("Why?") { explainSuggestion = s }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
        .popover(item: $explainSuggestion) { s in
            VStack(alignment: .leading, spacing: 6) {
                Text(s.name).font(.headline.monospaced())
                Text("Verb: \(s.verb)").font(.caption)
                Text("Matched tags:").font(.caption.weight(.medium))
                ForEach(s.matchedTags, id: \.self) { t in
                    Text("· \(t)").font(.caption.monospaced())
                }
                Text("Reason:").font(.caption.weight(.medium)).padding(.top, 4)
                Text(s.rationale).font(.caption)
            }
            .padding(12)
            .frame(width: 320, alignment: .leading)
        }
    }

    /// Active skill names for the project (ADR-0037).
    private var activeSkillNames: Set<String> {
        Set(index?.enablement?.active ?? [])
    }

    /// Flip a user-global skill in/out of the project's active set. Switches
    /// to an explicit `.marvin/skills.json` choice on first toggle.
    // MARK: - Updates (ADR-0071)

    /// POST /api/skills/update. `checkOnly` reports without installing.
    private func postSkillUpdate(body: [String: Any]) async -> SkillUpdateResponse? {
        var req = URLRequest(url: apiBase.appendingPathComponent("api/skills/update"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        // A bulk check shallow-clones once per skill — generous, but bounded.
        req.timeoutInterval = 180
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            return try? JSONDecoder().decode(SkillUpdateResponse.self, from: data)
        } catch {
            await MainActor.run { self.pasteboardToast = "Update check failed: \(error.localizedDescription)" }
            return nil
        }
    }

    /// Check both scopes. Installs nothing, so it is always safe to run.
    /// project-local is only checked when a project is open — the route
    /// requires a validated workDir for that scope.
    private func checkAllSkillUpdates() async {
        await MainActor.run { checkingUpdates = true }
        defer { Task { @MainActor in checkingUpdates = false } }

        var all: [SkillUpdateOutcome] = []
        if let resp = await postSkillUpdate(
            body: ["all": true, "checkOnly": true, "scope": "user-global"]
        ) {
            all.append(contentsOf: resp.results ?? [])
        }
        if let workDir = bridge.projectWorkDir,
           let resp = await postSkillUpdate(
               body: ["all": true, "checkOnly": true, "scope": "project-local", "workDir": workDir]
           ) {
            all.append(contentsOf: resp.results ?? [])
        }

        await MainActor.run {
            for r in all { updateStatus["\(r.scope):\(r.name)"] = r.status }
            let available = all.filter { $0.status == "update-available" }.count
            let failed = all.filter { $0.status == "error" }.count
            if all.isEmpty {
                pasteboardToast = "Nothing to check — no skill here has a recorded source."
            } else if available == 0 {
                pasteboardToast = failed == 0
                    ? "All \(all.count) up to date."
                    : "All up to date (\(failed) could not be checked)."
            } else {
                pasteboardToast = "\(available) update\(available == 1 ? "" : "s") available."
            }
        }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await MainActor.run { self.pasteboardToast = nil }
    }

    /// Fetch and install the latest for one skill. `url` re-binds provenance
    /// (the "Set source" path) and is otherwise omitted.
    private func updateOneSkill(name: String, scope: String, url: String? = nil) async {
        let key = "\(scope):\(name)"
        await MainActor.run { updatingSkill = key }
        defer { Task { @MainActor in updatingSkill = nil } }

        var body: [String: Any] = ["name": name, "scope": scope]
        if let url, !url.isEmpty { body["url"] = url }
        if scope == "project-local" {
            guard let workDir = bridge.projectWorkDir else {
                await MainActor.run { self.pasteboardToast = "Open a project to update its local skills." }
                return
            }
            body["workDir"] = workDir
        }

        guard let resp = await postSkillUpdate(body: body) else { return }
        guard let outcome = resp.results?.first else {
            await MainActor.run { self.pasteboardToast = resp.error ?? "Update failed." }
            return
        }
        await MainActor.run {
            // An update can RENAME the skill (upstream changed its frontmatter),
            // so record the status under the returned name, not the one we sent.
            updateStatus["\(scope):\(outcome.name)"] = outcome.status
            switch outcome.status {
            case "updated": pasteboardToast = "Updated \(outcome.name)."
            case "up-to-date": pasteboardToast = "\(outcome.name) is already up to date."
            default: pasteboardToast = "Update failed: \(outcome.error ?? "unknown error")"
            }
        }
        if outcome.status == "updated" { await refresh() }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        await MainActor.run { self.pasteboardToast = nil }
    }

    /// Bind a Git URL to a skill that has none, then immediately update from it.
    @ViewBuilder
    private func bindSourceSheet(_ target: BindTarget) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set source for \(target.name)").font(.headline)
            Text("MARVIN has no record of where this skill came from, so it can't re-fetch it. Paste the Git URL it lives at — it's stored beside the skill and reused for every future update.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://github.com/owner/repo/tree/main/skills/\(target.name)", text: $bindURL)
                .textFieldStyle(.roundedBorder)
            if let bindError {
                Text(bindError).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Cancel") { bindSourceFor = nil }
                Spacer()
                if bindBusy { ProgressView().controlSize(.small) }
                Button("Set and update") {
                    Task { await bindAndUpdate(target) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(bindBusy || bindURL.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(18)
        .frame(width: 520)
    }

    private func bindAndUpdate(_ target: BindTarget) async {
        let url = bindURL.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return }
        await MainActor.run { bindBusy = true; bindError = nil }
        defer { Task { @MainActor in bindBusy = false } }

        var body: [String: Any] = ["name": target.name, "scope": target.scope, "url": url]
        if target.scope == "project-local" {
            guard let workDir = bridge.projectWorkDir else {
                await MainActor.run { bindError = "Open a project first." }
                return
            }
            body["workDir"] = workDir
        }
        guard let resp = await postSkillUpdate(body: body) else {
            await MainActor.run { bindError = "The request failed." }
            return
        }
        guard let outcome = resp.results?.first else {
            await MainActor.run { bindError = resp.error ?? "Nothing came back." }
            return
        }
        if outcome.status == "error" {
            // Keep the sheet open — the URL is probably wrong and the user is
            // one edit away from a working one.
            await MainActor.run { bindError = outcome.error ?? "Update failed." }
            return
        }
        await MainActor.run {
            updateStatus["\(target.scope):\(outcome.name)"] = outcome.status
            bindSourceFor = nil
            bindURL = ""
            pasteboardToast = "Source set for \(outcome.name)."
        }
        await refresh()
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        await MainActor.run { self.pasteboardToast = nil }
    }

    private func toggleSkill(_ name: String) async {
        guard let workDir = bridge.projectWorkDir, let idx = index else { return }
        let userGlobalNames = Set(idx.userGlobal.map { $0.name })
        var active = Set(idx.enablement?.active ?? [])
        if active.contains(name) { active.remove(name) } else { active.insert(name) }
        // Only user-global names go in the explicit list; project-local
        // skills are always active and never sent.
        let enabled = Array(active.intersection(userGlobalNames)).sorted()
        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/skills/enable"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["workDir": workDir, "enabled": enabled]
        )
        _ = try? await URLSession.shared.data(for: req)
        await refresh()
    }

    @ViewBuilder
    private func installedRow(
        name: String,
        description: String,
        path: String,
        badge: String?,
        scope: String,
        source: SkillSourceInfo?,
        active: Bool? = nil,
        onToggle: (() -> Void)? = nil,
        loadIssue: SkillsIndexResponse.SkillLoadIssue? = nil
    ) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if let active, let onToggle {
                Button(action: onToggle) {
                    Image(systemName: active ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(active ? Color.green : .secondary)
                        .font(.system(size: 15))
                }
                .buttonStyle(.plain)
                .help(active
                      ? "Active for this project — click to disable for this project."
                      : "Inactive here — click to enable for this project.")
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name).font(.body.monospaced())
                    if let badge {
                        Text(badge.uppercased())
                            .font(.caption2)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background((loadIssue?.blocked == true ? Color.red : .orange).opacity(0.18))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                if !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let loadIssue {
                    Label(loadIssue.reason,
                          systemImage: loadIssue.blocked
                            ? "exclamationmark.triangle.fill" : "info.circle")
                        .font(.caption)
                        .foregroundStyle(loadIssue.blocked ? Color.red : .orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            skillUpdateControl(name: name, scope: scope, source: source)
            Button("View") {
                openSkillFile(path)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
        }
        .padding(.vertical, 2)
    }

    /// Update affordance for one skill (ADR-0071).
    ///
    /// A skill with no recorded source is the common case on an existing
    /// machine — every skill installed before provenance existed, plus anything
    /// hand-authored. Rather than a dead button, those get "Set source", which
    /// binds a URL once and turns the row into a normal updatable one.
    @ViewBuilder
    private func skillUpdateControl(name: String, scope: String, source: SkillSourceInfo?) -> some View {
        let key = "\(scope):\(name)"
        let status = updateStatus[key]
        if updatingSkill == key {
            ProgressView().controlSize(.small)
        } else if source?.updatable != true {
            Button("Set source") {
                bindURL = ""; bindError = nil
                bindSourceFor = BindTarget(name: name, scope: scope)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("This skill has no recorded origin, so there's nothing to re-fetch. Give it the Git URL once and Update works from then on.")
        } else {
            HStack(spacing: 6) {
                if status == "update-available" {
                    Text("update available")
                        .font(.caption2)
                        .foregroundStyle(Color.orange)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.15)))
                } else if status == "up-to-date" {
                    Text("up to date").font(.caption2).foregroundStyle(.tertiary)
                } else if status == "updated" {
                    Text("updated").font(.caption2).foregroundStyle(.green)
                }
                Button("Update") { Task { await updateOneSkill(name: name, scope: scope) } }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .disabled(updatingSkill != nil || checkingUpdates)
                    .help("Re-fetch from \(source?.url ?? "its recorded source"). Last updated \(source?.lastUpdated ?? "unknown")." )
            }
        }
    }

    @ViewBuilder
    private func auditFooter(_ audit: SkillsIndexResponse.AuditBlock) -> some View {
        HStack(spacing: 8) {
            Image(systemName: audit.decided ? "checkmark.seal" : "questionmark.circle")
                .foregroundStyle(audit.decided ? .green : .orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(audit.decided ? "Audit decided" : "Audit pending")
                    .font(.caption.weight(.medium))
                if let line = audit.decisionLine {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if audit.decided {
                Button("Unpark") {
                    Task { await unpark() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(inFlightAction == "unpark")
            } else {
                Button("Park all") {
                    Task { await parkAll() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(inFlightAction == "park")
            }
        }
        .padding(.top, 4)
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

    // MARK: - Networking

    private var apiBase: URL { ServerConfig.baseURL }

    private func refresh() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run {
            self.isLoading = true
            self.loadError = nil
        }
        defer { Task { @MainActor in self.isLoading = false } }

        var comps = URLComponents(url: apiBase.appendingPathComponent("api/skills"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "workDir", value: workDir)]
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let parsed = try JSONDecoder().decode(SkillsIndexResponse.self, from: data)
            await MainActor.run { self.index = parsed }
        } catch {
            await MainActor.run { self.loadError = "Failed to load skills: \(error.localizedDescription)" }
        }
    }

    private func parkAll() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { self.inFlightAction = "park" }
        defer { Task { @MainActor in self.inFlightAction = nil } }

        var req = URLRequest(url: apiBase.appendingPathComponent("api/skills/park"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        let body: [String: Any] = [
            "workDir": workDir,
            "note": "parked from Skills pane",
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
        await refresh()
    }

    private func unpark() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { self.inFlightAction = "unpark" }
        defer { Task { @MainActor in self.inFlightAction = nil } }

        var comps = URLComponents(url: apiBase.appendingPathComponent("api/skills/park"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "workDir", value: workDir)]
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        _ = try? await URLSession.shared.data(for: req)
        await refresh()
    }

    private func dispatchInstallOrBuild(_ s: SkillsIndexResponse.Suggestion) async {
        await MainActor.run { self.inFlightAction = s.id }
        defer { Task { @MainActor in self.inFlightAction = nil } }

        // We don't auto-install or auto-build (ADR-0025 trust contract).
        // We copy a draft prompt to the clipboard; the user reviews and
        // pastes it into the chat composer. Going through the clipboard
        // avoids threading a new "prefill composer" IPC channel through
        // ChatService — the chat input is local state in ChatInputView.
        let prompt: String
        if s.verb == "install" {
            prompt = """
            Please walk me through installing the `\(s.name)` skill from \
            the Anthropic skills repo into `~/.claude/skills/`. Reason: \
            \(s.rationale)
            """
        } else {
            prompt = """
            Please use the `skill-creator` skill to build a new \
            project-local skill at `<workDir>/.marvin/skills/\(s.name)/SKILL.md`. \
            Seed it with the fingerprint tags: \(s.matchedTags.joined(separator: ", ")). \
            Reason: \(s.rationale)
            """
        }
        await MainActor.run {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(prompt, forType: .string)
            self.pasteboardToast = "Prompt copied — paste into chat to review and run."
        }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await MainActor.run { self.pasteboardToast = nil }
    }

    private func openSkillFile(_ path: String) {
        // Skills live OUTSIDE the project workDir (`~/.claude/skills/...`)
        // so the sandboxed /api/files/raw endpoint refuses them. We hit
        // /api/skills/content instead, which applies a tight whitelist
        // (~/.claude/skills/ + <workDir>/.marvin/skills/) and returns the
        // file content directly. Result renders in the .sheet defined on
        // the root body via `viewedSkill`.
        Task {
            await MainActor.run { self.loadError = nil }
            var components = URLComponents(
                url: ServerConfig.baseURL.appendingPathComponent("api/skills/content"),
                resolvingAgainstBaseURL: false
            )!
            var items: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
            if let workDir = await MainActor.run(body: { bridge.projectWorkDir }) {
                items.append(URLQueryItem(name: "workDir", value: workDir))
            }
            components.queryItems = items
            guard let url = components.url else { return }
            var req = URLRequest(url: url)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                    let errBody = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
                        ?? "HTTP \(http.statusCode)"
                    await MainActor.run {
                        self.loadError = "Failed to load skill: \(errBody)"
                    }
                    return
                }
                struct Payload: Decodable { let path: String; let content: String }
                let parsed = try JSONDecoder().decode(Payload.self, from: data)
                let name = URL(fileURLWithPath: parsed.path)
                    .deletingLastPathComponent().lastPathComponent
                await MainActor.run {
                    self.viewedSkill = ViewedSkill(
                        name: name,
                        path: parsed.path,
                        content: parsed.content
                    )
                }
            } catch {
                await MainActor.run {
                    self.loadError = "Failed to load skill: \(error.localizedDescription)"
                }
            }
        }
    }
}

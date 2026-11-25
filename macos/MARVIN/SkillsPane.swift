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
import MARVINLogic
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

@MainActor struct SkillsPane: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var index: SkillsIndexResponse?
    @State private var loadError: String?
    @State private var isLoading: Bool = false
    @State private var inFlightAction: String?
    @State private var explainSuggestion: SkillsIndexResponse.Suggestion?
    /// The outcome of the last action, with its kind (ADR-0114).
    ///
    /// Every outcome used to render in one clipboard-icon strip that cleared
    /// itself after three or four seconds, so "Installed: x" and "Discovery
    /// failed: …" were the same pixels and the failure was the one certain to
    /// vanish unread. `PaneNotice.dismissal` decides by kind now.
    @State private var notice: PaneNotice?
    /// The filter under the header, the selected row, and which groups are closed.
    @State private var filter = ""
    @State private var selection: String?
    @State private var groups = PaneCollapseStore(pane: "skills")
    /// "Update all" is running.
    @State private var bulkUpdating = false
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

    /// The snapshot harness shows the pane after an update check ran and with a
    /// row open (`SurfaceSnapshotPaneKit`); nothing else passes arguments.
    init(seedUpdateStatus: [String: String] = [:], seedSelection: String? = nil) {
        _updateStatus = State(initialValue: seedUpdateStatus)
        _selection = State(initialValue: seedSelection)
    }

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
                skillsHeader(total: nil)
                PaneEmptyView(state: .noProject("skills")).frame(maxHeight: .infinity)
            } else if loadError != nil, index == nil {
                skillsHeader(total: nil)
                PaneEmptyView(
                    state: .couldNotLoad("skills", reason: "Check that MARVIN's server is running, then try again."),
                    actionTitle: "Retry",
                    action: { Task { await refresh() } }
                ).frame(maxHeight: .infinity)
            } else if let idx = index {
                content(idx)
            } else if isLoading {
                skillsHeader(total: nil)
                PaneLoadingView(label: "Reading the skills index…")
                Spacer(minLength: 0)
            } else {
                skillsHeader(total: nil)
                PaneEmptyView(state: .nothingYet("skills", hint: "Add one from GitHub, or build one for this project.")).frame(maxHeight: .infinity)
            }
            if let notice {
                PaneNoticeStrip(notice: notice, onDismiss: { withAnimation { self.notice = nil } })
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
        // A pane absorbs compression and clips; it never negotiates for
        // width. All seven stay mounted in one ZStack, so the widest
        // intrinsic minimum among them becomes the sidebar's, and the
        // overflow pushes the 44pt rail off the left edge (ADR-0114).
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .clipped()
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
                .font(PaneFont.secondary).foregroundStyle(.secondary)
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
                    .font(PaneFont.action)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(addPlugins) { p in
                            HStack(alignment: .top, spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(p.title).font(.body.monospaced())
                                    if let d = p.description, !d.isEmpty {
                                        Text(d).font(PaneFont.secondary).foregroundStyle(.secondary).lineLimit(2)
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
                    .font(PaneFont.action)
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
                                        Text(d).font(PaneFont.secondary).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
                .frame(maxHeight: 200)
            }

            if let err = addError {
                Text(err).font(PaneFont.secondary).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
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
                    flash("Installed: \(installed.map { $0.name }.joined(separator: ", "))")
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
    private func discoveredDetailSheet(_ s: SkillsIndexResponse.DiscoveredSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(.headline, design: .monospaced))
                    Text(s.description).font(PaneFont.secondary).foregroundStyle(.secondary)
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
        // Clears the discoverer's own 600s cap so a slow-but-working run is
        // never cut off client-side and reported as a failure.
        req.timeoutInterval = 660
        // Discovery runs on the SELECTED EXECUTOR. Sending it is the point:
        // whatever the user picked — including any OpenRouter slug — is what
        // should answer, and the server passes a supplied model through
        // verbatim rather than second-guessing it.
        //
        // This briefly looked like the bug. It was not: measured 2026-08-30,
        // `claude-opus-5` 500'd at 122s against the then-120s cap, and the
        // same model against the raised cap returned 4 suggestions in **81s**.
        // The model was never too big; the cap was too tight, and the swallowed
        // 500 below made a timeout look like a dead button.
        var body: [String: Any] = ["workDir": workDir]
        if let executor = bridge.executorModel, !executor.isEmpty {
            body["model"] = executor
        }
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
                self.fail("Discovery failed", error.localizedDescription)
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
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
                    self.fail("Could not build the skill", detail)
                }
            } else {
                await MainActor.run {
                    self.flash("Built \(s.name) at .marvin/skills/\(s.name)/")
                }
            }
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            await refresh()
        } catch {
            await MainActor.run {
                self.fail("Could not build the skill", error.localizedDescription)
            }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
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
                    Text(skill.path).font(PaneFont.secondary).foregroundStyle(.secondary)
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

    /// One installed skill, user-global or project-local, in one shape so the
    /// pane can group, filter and render them the same way.
    private struct SkillItem: Identifiable {
        let id: String            // the SKILL.md path: unique across scopes
        let name: String
        let description: String
        let scope: String         // "user-global" | "project-local"
        let source: SkillSourceInfo?
        let loadIssue: SkillsIndexResponse.SkillLoadIssue?
        /// User-global skills are switched on and off per project; project-local
        /// ones are authored for the project and always on (unless blocked).
        let toggleable: Bool
        var key: String { "\(scope):\(name)" }
    }

    private func installedItems(_ idx: SkillsIndexResponse) -> [SkillItem] {
        idx.userGlobal.map {
            SkillItem(id: $0.path, name: $0.name, description: $0.description, scope: "user-global",
                      source: $0.source, loadIssue: nil, toggleable: true)
        } + idx.projectLocal.map {
            SkillItem(id: $0.path, name: $0.name, description: $0.description, scope: "project-local",
                      source: $0.source, loadIssue: $0.loadIssue, toggleable: false)
        }
    }

    private func groupingEntry(_ s: SkillItem) -> InstalledEntry {
        InstalledEntry(
            id: s.id, name: s.name,
            enabled: s.toggleable ? activeSkillNames.contains(s.name) : true,
            hasUpdate: s.source?.updatable == true && updateStatus[s.key] == "update-available",
            blocked: s.loadIssue?.blocked == true)
    }

    @ViewBuilder
    private func content(_ idx: SkillsIndexResponse) -> some View {
        let all = installedItems(idx)
        let filtering = PaneFilter.isActive(filter)
        let shown = all.filter { PaneFilter.matches(filter, in: [$0.name, $0.description]) }
        let sections = InstalledGrouping.group(shown.map(groupingEntry))
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let suggestions = idx.suggestions.filter { PaneFilter.matches(filter, in: [$0.name, $0.rationale]) }
        let discovered = (idx.discovered?.suggestions ?? []).filter { PaneFilter.matches(filter, in: [$0.name, $0.description]) }
        let nothing = sections.isEmpty && suggestions.isEmpty && discovered.isEmpty
        let nothingAtAll = all.isEmpty && idx.suggestions.isEmpty && (idx.discovered?.suggestions.isEmpty ?? true)
        VStack(spacing: 0) {
            skillsHeader(total: nothingAtAll ? nil : all.count)
            if nothingAtAll {
                PaneEmptyView(
                    state: .nothingYet("skills", hint: "Add one from GitHub, or build one for this project."),
                    actionTitle: "Add a skill…"
                ) { openAddSheet() }
                .frame(maxHeight: .infinity)
            } else {
                PaneFilterField(text: $filter, prompt: "Filter skills")
                if filtering && nothing {
                    PaneEmptyView(state: .filtered(query: filter, noun: "skills"), actionTitle: "Clear filter") { filter = "" }
                    Spacer(minLength: 0)
                } else {
                    PaneScrollList(
                        rows: visibleRows(sections: sections, byId: byId, suggestions: suggestions, discovered: discovered, filtering: filtering),
                        selection: $selection,
                        onActivate: { id in activate(id, byId: byId, idx: idx) },
                        onSpace: { id in if let s = byId[id], s.toggleable { Task { await toggleSkill(s.name) } } },
                        onEscape: { if PaneFilter.isActive(filter) { filter = ""; return true }; return false }
                    ) {
                        ForEach(sections, id: \.group) { sec in
                            installedGroup(sec, byId: byId, filtering: filtering)
                        }
                        suggestedGroup(idx, suggestions: suggestions, discovered: discovered, filtering: filtering)
                        auditGroup(idx.audit, filtering: filtering)
                    }
                }
            }
        }
    }

    /// The rows on screen, in order — what the arrow keys walk and type-ahead
    /// matches. A closed group's rows are not on screen, so not in the list.
    private func visibleRows(
        sections: [InstalledGrouping.Section], byId: [String: SkillItem],
        suggestions: [SkillsIndexResponse.Suggestion], discovered: [SkillsIndexResponse.DiscoveredSuggestion],
        filtering: Bool
    ) -> [(id: String, title: String)] {
        var out: [(id: String, title: String)] = []
        for sec in sections where PaneCollapseState.isShown(collapsed: groups.isCollapsed(sec.group.key, default: sec.group == .available), filterActive: filtering) {
            out += sec.ids.compactMap { id in byId[id].map { (id: id, title: $0.name) } }
        }
        if PaneCollapseState.isShown(collapsed: groups.isCollapsed("suggested", default: true), filterActive: filtering) {
            out += suggestions.map { (id: "suggestion:\($0.id)", title: $0.name) }
            out += discovered.map { (id: "discovered:\($0.id)", title: $0.name) }
        }
        return out
    }

    /// Return on a row does the row's one obvious thing.
    private func activate(_ id: String, byId: [String: SkillItem], idx: SkillsIndexResponse) {
        if let s = byId[id] {
            if s.source?.updatable == true, updateStatus[s.key] == "update-available" {
                Task { await updateOneSkill(name: s.name, scope: s.scope) }
            } else {
                openSkillFile(s.id)
            }
        } else if id.hasPrefix("suggestion:"), let s = idx.suggestions.first(where: { "suggestion:\($0.id)" == id }), !s.alreadyInstalled {
            Task { await dispatchInstallOrBuild(s) }
        } else if id.hasPrefix("discovered:"), let s = idx.discovered?.suggestions.first(where: { "discovered:\($0.id)" == id }) {
            inspectedDiscovered = s
        }
    }

    // MARK: Header

    /// One verb the pane exists for, and a menu for the rest (the standard's
    /// two-action header).
    private func skillsHeader(total: Int?) -> some View {
        PaneHeader(title: "Skills", symbol: "sparkles.rectangle.stack", count: total) {
            if total != nil {
                PaneActionButton(
                    title: "Add…", role: .primary,
                    help: "Add from GitHub — fetch a skill from a Git repo or marketplace URL"
                ) { openAddSheet() }
                PaneOverflowMenu(label: "More actions for skills") {
                    Button("Check for updates") { Task { await checkAllSkillUpdates() } }
                        .disabled(checkingUpdates || updatableSkillCount == 0)
                        .help(updatableSkillCount == 0
                              ? "Nothing to check: no installed skill has a recorded source yet. Use “Set source…” on a skill first."
                              : "Re-fetch the \(updatableSkillCount) skill\(updatableSkillCount == 1 ? "" : "s") MARVIN installed and report which changed upstream. Installs nothing.")
                    Button("Reload the list") { Task { await refresh() } }
                        .disabled(isLoading)
                        .help("Read the installed skills from disk again (does not check upstream)")
                }
            }
        }
    }

    private func openAddSheet() {
        addError = nil; addCandidates = []; addSelected = []
        addPlugins = []; addMarketplace = nil
        addSheetOpen = true
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
        case .attention: return "Installed in this project, but the agent's skill loader skipped them, so MARVIN cannot use them."
        case .needsUpdate: return "A check found a newer version upstream."
        case .enabled: return "What MARVIN uses here. The project's fingerprint picks these automatically; switch one to change it."
        case .available: return "Installed in ~/.claude/skills but not offered to MARVIN in this project. Switch one on to enable it here."
        }
    }

    @ViewBuilder
    private func installedGroup(_ sec: InstalledGrouping.Section, byId: [String: SkillItem], filtering: Bool) -> some View {
        let g = sec.group
        PaneGroup(
            store: groups, id: g.key, title: g.title, count: sec.ids.count, tint: groupTint(g),
            help: groupHelp(g), startsCollapsed: g == .available, filterActive: filtering,
            trailing: {
                if g == .needsUpdate {
                    PaneActionButton(
                        title: PaneBulkAction.title("Update all", count: sec.ids.count),
                        role: .primary,
                        help: "Re-fetch every skill in this group from its recorded source.",
                        disabled: bulkUpdating || updatingSkill != nil || checkingUpdates
                    ) { Task { await updateAllAvailable() } }
                }
            },
            content: {
                ForEach(sec.ids, id: \.self) { id in
                    if let s = byId[id] { skillRow(s) }
                }
            })
    }

    @ViewBuilder
    private func suggestedGroup(
        _ idx: SkillsIndexResponse, suggestions: [SkillsIndexResponse.Suggestion],
        discovered: [SkillsIndexResponse.DiscoveredSuggestion], filtering: Bool
    ) -> some View {
        let hasDiscovered = !(idx.discovered?.suggestions.isEmpty ?? true)
        let stale = idx.discovered?.stale == true
        if !(filtering && suggestions.isEmpty && discovered.isEmpty) {
            PaneGroup(
                store: groups, id: "suggested", title: "Suggested",
                count: suggestions.count + discovered.count, tint: Color.accentColor,
                help: "Skills not installed or built yet. Matched to this project's fingerprint (\(idx.fingerprint.tags.count) tags); “Install” adds a user-global skill, “Build” authors a project-local one."
                    + (stale ? " The AI suggestions are stale: the project changed since they were made." : "")
                    + discoveryStamp(idx.discovered),
                startsCollapsed: true, filterActive: filtering,
                trailing: {
                    if discovering {
                        ProgressView().controlSize(.small).scaleEffect(0.7)
                            .accessibilityLabel("Discovering skills")
                    } else {
                        PaneActionButton(
                            title: hasDiscovered ? "Re-discover" : "Discover",
                            help: "Ask MARVIN which project-local skills would help in this codebase. One model call, about 1–3¢; cached in .marvin/discovered-skills.json."
                        ) { Task { await runDiscovery() } }
                    }
                },
                content: {
                    ForEach(suggestions) { s in suggestionRow(s) }
                    ForEach(discovered) { s in discoveredRow(s) }
                    if suggestions.isEmpty && discovered.isEmpty && !filtering {
                        PaneNote(text: "Nothing suggested yet. Discover asks MARVIN for ideas from this codebase.")
                    }
                })
        }
    }

    private func discoveryStamp(_ block: SkillsIndexResponse.DiscoveredBlock?) -> String {
        guard let at = block?.discoveredAt else { return "" }
        let cost = block?.costCents.map { " · \($0)¢" } ?? ""
        return " Discovered \(shortDate(at))\(cost)."
    }

    @ViewBuilder
    private func auditGroup(_ audit: SkillsIndexResponse.AuditBlock, filtering: Bool) -> some View {
        if !filtering {
            PaneGroup(
                store: groups, id: "audit", title: "Skill audit", help: "Whether MARVIN has been told you reviewed the project's skills. Park all closes the pending-audit reminder until something changes.",
                startsCollapsed: true) {
                auditRow(audit)
            }
        }
    }

    // MARK: Rows

    private func skillRow(_ s: SkillItem) -> some View {
        let status = updateStatus[s.key]
        let updatable = s.source?.updatable == true
        let blocked = s.loadIssue?.blocked == true
        let active = s.toggleable ? activeSkillNames.contains(s.name) : !blocked
        let desc = SkillRowDescription.display(s.description)
        let canRun = updatingSkill == nil && !checkingUpdates && !bulkUpdating

        var secondary = desc.text
        var style: PaneRowSecondaryStyle = desc.isPlaceholder ? .placeholder : .normal
        if let issue = s.loadIssue {
            secondary = issue.reason
            style = blocked ? .error : .warning
        }

        var trailingText: String?
        var trailingSymbol: String?
        var trailingTint = MarvinTheme.textMuted
        if blocked {
            trailingText = "Not loaded"; trailingSymbol = "exclamationmark.triangle.fill"; trailingTint = GitDecorationColor.deleted
        } else if status == "updated" {
            trailingText = "Updated"; trailingSymbol = "checkmark"; trailingTint = GitDecorationColor.added
        } else if !s.toggleable {
            trailingText = "Project"
        }

        let leading: PaneRowLeading = s.toggleable
            ? .toggle(
                isOn: active, name: s.name,
                help: active
                    ? "On for this project. Switch off to stop offering it here."
                    : "Off here. Switch on to offer it to MARVIN for this project.",
                onToggle: { _ in Task { await toggleSkill(s.name) } })
            : .glyph(blocked ? "exclamationmark.triangle.fill" : "folder", blocked ? GitDecorationColor.deleted : MarvinTheme.textMuted)

        var items: [PaneRowItem] = []
        if updatable {
            let waiting = status == "update-available"
            items.append(PaneRowItem(
                id: "update", title: waiting ? "Update" : "Re-fetch from source",
                systemImage: "arrow.triangle.2.circlepath", role: waiting ? .primary : .normal, enabled: canRun,
                help: "Re-fetch from \(s.source?.url ?? "its recorded source"). Last updated \(s.source?.lastUpdated ?? "unknown").",
                perform: { Task { await updateOneSkill(name: s.name, scope: s.scope) } }))
        }
        items.append(PaneRowItem(id: "view", title: "View SKILL.md", systemImage: "doc.text", perform: { openSkillFile(s.id) }))
        if !updatable {
            items.append(PaneRowItem(
                id: "source", title: "Set source…", systemImage: "link",
                help: "Give this skill an origin so Update works.",
                perform: { bindURL = ""; bindError = nil; bindSourceFor = BindTarget(name: s.name, scope: s.scope) }))
        }
        items.append(PaneRowItem(id: "copy", title: "Copy name", systemImage: "doc.on.doc", perform: {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(s.name, forType: .string)
        }))

        return PaneListRow(
            rowID: s.id, title: s.name, titleIsIdentifier: true, leading: leading,
            secondary: secondary, secondaryStyle: style,
            trailingText: trailingText, trailingSymbol: trailingSymbol, trailingTint: trailingTint,
            selected: selection == s.id, busy: updatingSkill == s.key, items: items,
            menuLabel: "More actions for \(s.name)", onSelect: { selection = s.id },
            showsDetail: selection == s.id,
            detail: { skillDetail(s) })
    }

    /// What a selected skill adds: the whole description and where it came from.
    @ViewBuilder
    private func skillDetail(_ s: SkillItem) -> some View {
        let desc = SkillRowDescription.display(s.description)
        VStack(alignment: .leading, spacing: PaneSpace.tight) {
            if !desc.isPlaceholder {
                Text(desc.text).lineLimit(8)
            }
            if let src = s.source {
                Text("Source: \(src.url ?? "recorded")\(src.lastUpdated.isEmpty ? "" : " · updated \(shortDate(src.lastUpdated))")")
                    .lineLimit(2).truncationMode(.middle)
            } else {
                Text("No recorded source, so it cannot be updated. Use “Set source…” in its … menu.")
            }
        }
        .font(PaneFont.secondary)
        .foregroundStyle(MarvinTheme.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func suggestionRow(_ s: SkillsIndexResponse.Suggestion) -> some View {
        let id = "suggestion:\(s.id)"
        let verb = s.verb == "install" ? "Install" : "Build"
        return PaneListRow(
            rowID: id, title: s.name, titleIsIdentifier: true,
            leading: .glyph(s.verb == "install" ? "shippingbox" : "hammer"),
            secondary: s.rationale,
            trailingText: s.alreadyInstalled ? "Installed" : nil,
            trailingSymbol: s.alreadyInstalled ? "checkmark" : nil,
            selected: selection == id, busy: inFlightAction == s.id,
            items: s.alreadyInstalled ? [] : [
                PaneRowItem(id: "go", title: verb, role: .primary, enabled: inFlightAction == nil,
                            help: s.verb == "install" ? "Add this as a user-global skill." : "Author this as a project-local skill.",
                            perform: { Task { await dispatchInstallOrBuild(s) } }),
            ],
            menuLabel: "More actions for \(s.name)", onSelect: { selection = id },
            showsDetail: selection == id,
            detail: {
                VStack(alignment: .leading, spacing: PaneSpace.tight) {
                    Text(s.rationale)
                    if !s.matchedTags.isEmpty { Text("Matched: \(s.matchedTags.joined(separator: ", "))") }
                }
                .font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            })
    }

    private func discoveredRow(_ s: SkillsIndexResponse.DiscoveredSuggestion) -> some View {
        let id = "discovered:\(s.id)"
        return PaneListRow(
            rowID: id, title: s.name, titleIsIdentifier: true, leading: .glyph("sparkles"),
            secondary: s.description,
            selected: selection == id, busy: buildingSuggestion == s.name,
            items: [
                PaneRowItem(id: "build", title: "Build", role: .primary, enabled: buildingSuggestion == nil,
                            help: "Author this as a project-local skill.", perform: { Task { await buildDiscovered(s) } }),
                PaneRowItem(id: "review", title: "Review the proposal…", systemImage: "doc.text.magnifyingglass",
                            perform: { inspectedDiscovered = s }),
            ],
            menuLabel: "More actions for \(s.name)", onSelect: { selection = id },
            showsDetail: selection == id,
            detail: {
                Text(s.rationale).font(PaneFont.secondary).foregroundStyle(MarvinTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            })
    }

    private func auditRow(_ audit: SkillsIndexResponse.AuditBlock) -> some View {
        PaneListRow(
            rowID: "audit", title: audit.decided ? "Audit decided" : "Audit pending",
            leading: .glyph(audit.decided ? "checkmark.seal" : "questionmark.circle",
                            audit.decided ? GitDecorationColor.added : .orange),
            secondary: audit.decisionLine ?? (audit.decided ? nil : "Nobody has reviewed this project's skills yet."),
            items: [
                audit.decided
                    ? PaneRowItem(id: "unpark", title: "Unpark", role: .primary, enabled: inFlightAction == nil,
                                  help: "Ask again about this project's skills.", perform: { Task { await unpark() } })
                    : PaneRowItem(id: "park", title: "Park all", role: .primary, enabled: inFlightAction == nil,
                                  help: "Record the current skills as reviewed.", perform: { Task { await parkAll() } }),
            ])
    }

    // MARK: Notices

    /// Something worked; it leaves on its own.
    @MainActor private func flash(_ text: String) { show(PaneNotice(kind: .success, text: text)) }

    /// Something failed; it stays until dismissed (ADR-0114).
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

    /// Rows that could be updated at all — gates "Check for updates" so it is
    /// not offered on a tree where nothing has a recorded source.
    private var updatableSkillCount: Int {
        guard let idx = index else { return 0 }
        return idx.userGlobal.filter { $0.source?.updatable == true }.count
            + idx.projectLocal.filter { $0.source?.updatable == true }.count
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
            await MainActor.run { self.fail("Update check failed", error.localizedDescription) }
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
                show(PaneNotice(kind: .info, text: "Nothing to check — no skill here has a recorded source."))
            } else if available == 0 {
                if failed == 0 {
                    flash("All \(all.count) up to date.")
                } else {
                    show(PaneNotice(kind: .warning, headline: "All up to date, but \(failed) could not be checked.", detail: "They have no recorded source, or the fetch failed."))
                }
            } else {
                // The answer outlives the notice: the "Needs update" group holds
                // the skills (it used to vanish with the toast, ADR-0114).
                flash("\(available) update\(available == 1 ? "" : "s") available.")
            }
        }
    }

    /// Update every skill the last check found a newer version of, one after
    /// another, and say once what happened.
    private func updateAllAvailable() async {
        guard let idx = index else { return }
        let targets = installedItems(idx).filter { $0.source?.updatable == true && updateStatus[$0.key] == "update-available" }
        guard !targets.isEmpty else { return }
        await MainActor.run { bulkUpdating = true }
        defer { Task { @MainActor in bulkUpdating = false; updatingSkill = nil } }
        var updated = 0
        var failed = 0
        for t in targets {
            var body: [String: Any] = ["name": t.name, "scope": t.scope]
            if t.scope == "project-local" {
                guard let workDir = bridge.projectWorkDir else { failed += 1; continue }
                body["workDir"] = workDir
            }
            await MainActor.run { updatingSkill = t.key }
            guard let outcome = await postSkillUpdate(body: body)?.results?.first else { failed += 1; continue }
            await MainActor.run { updateStatus["\(t.scope):\(outcome.name)"] = outcome.status }
            if outcome.status == "updated" || outcome.status == "up-to-date" { updated += 1 } else { failed += 1 }
        }
        await MainActor.run {
            if failed == 0 {
                flash("Updated \(updated) skill\(updated == 1 ? "" : "s").")
            } else {
                show(PaneNotice(kind: .warning, headline: "Updated \(updated), \(failed) could not be updated.",
                                detail: "Open the skill's … menu to check its source."))
            }
        }
        await refresh()
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
                await MainActor.run { self.show(PaneNotice(kind: .info, text: "Open a project to update its local skills.")) }
                return
            }
            body["workDir"] = workDir
        }

        guard let resp = await postSkillUpdate(body: body) else { return }
        guard let outcome = resp.results?.first else {
            await MainActor.run { self.fail("Could not update", resp.error ?? "The update returned nothing.") }
            return
        }
        await MainActor.run {
            // An update can RENAME the skill (upstream changed its frontmatter),
            // so record the status under the returned name, not the one we sent.
            updateStatus["\(scope):\(outcome.name)"] = outcome.status
            switch outcome.status {
            case "updated": flash("Updated \(outcome.name).")
            case "up-to-date": flash("\(outcome.name) is already up to date.")
            default: fail("Could not update \(outcome.name)", outcome.error ?? "unknown error")
            }
        }
        if outcome.status == "updated" { await refresh() }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
    }

    /// Bind a Git URL to a skill that has none, then immediately update from it.
    @ViewBuilder
    private func bindSourceSheet(_ target: BindTarget) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set source for \(target.name)").font(.headline)
            Text("MARVIN has no record of where this skill came from, so it can't re-fetch it. Paste the Git URL it lives at — it's stored beside the skill and reused for every future update.")
                .font(PaneFont.secondary).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://github.com/owner/repo/tree/main/skills/\(target.name)", text: $bindURL)
                .textFieldStyle(.roundedBorder)
            if let bindError {
                Text(bindError).font(PaneFont.secondary).foregroundStyle(.red)
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
            flash("Source set for \(outcome.name).")
        }
        await refresh()
        try? await Task.sleep(nanoseconds: 3_000_000_000)
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
            self.flash("Prompt copied — paste into chat to review and run.")
        }
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

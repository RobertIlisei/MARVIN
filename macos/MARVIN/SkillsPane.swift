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
        var id: String { path }
    }

    struct ProjectLocalSkill: Decodable, Identifiable {
        let name: String
        let description: String
        let path: String
        let shadowsUserGlobal: Bool
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
                Divider()
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
                Divider()
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
            Divider()
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

    private func runDiscovery() async {
        guard let workDir = bridge.projectWorkDir else { return }
        await MainActor.run { self.discovering = true }
        defer { Task { @MainActor in self.discovering = false } }

        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/skills/discover"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        req.timeoutInterval = 130
        let body: [String: Any] = ["workDir": workDir]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            _ = try await URLSession.shared.data(for: req)
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
            Divider()
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
                // ADR-0037 — organised around the one question that matters:
                // what is ACTIVE for this project. Active → available to turn
                // on → recommended to add. (Was five flat, overlapping
                // sections that read as "all over the place".)
                activeSection(idx)
                Divider()
                availableSection(idx)
                Divider()
                recommendedSection(idx)
                Divider()
                auditFooter(idx.audit)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    addError = nil; addCandidates = []; addSelected = []
                    addPlugins = []; addMarketplace = nil
                    addSheetOpen = true
                } label: {
                    Label("Add from GitHub", systemImage: "arrow.down.circle")
                }
                .help("Fetch a skill from a Git repo (ADR-0039)")
            }
            ToolbarItem(placement: .automatic) {
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh")
                .disabled(isLoading)
            }
        }
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
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("checkmark.seal.fill", .green, "Active in this project",
                          count: active.count + idx.projectLocal.count)
            Text("What MARVIN uses here — the fingerprint picks these automatically; toggle to change. Skills that aren't active aren't offered to MARVIN for this project (ADR-0037).")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if active.isEmpty && idx.projectLocal.isEmpty {
                Text("Nothing active yet — enable a skill below.")
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(active) { skill in
                    installedRow(name: skill.name, description: skill.description, path: skill.path,
                                 badge: nil, active: true,
                                 onToggle: { Task { await toggleSkill(skill.name) } })
                }
                ForEach(idx.projectLocal) { skill in
                    // Project-local skills are authored FOR this project — always
                    // active, no toggle.
                    installedRow(name: skill.name, description: skill.description, path: skill.path,
                                 badge: "local")
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
                                 badge: nil, active: false,
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
        active: Bool? = nil,
        onToggle: (() -> Void)? = nil
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
                            .background(.orange.opacity(0.18))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                if !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Button("View") {
                openSkillFile(path)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
        }
        .padding(.vertical, 2)
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

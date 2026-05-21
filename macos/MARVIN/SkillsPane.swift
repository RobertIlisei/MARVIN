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
            VStack(alignment: .leading, spacing: 16) {
                suggestionsSection(idx)
                Divider()
                userGlobalSection(idx.userGlobal)
                Divider()
                projectLocalSection(idx.projectLocal)
                Divider()
                auditFooter(idx.audit)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .toolbar {
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

    @ViewBuilder
    private func suggestionsSection(_ idx: SkillsIndexResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "sparkle")
                    .foregroundStyle(.yellow)
                Text("Suggested for this project")
                    .font(.headline)
            }
            if idx.suggestions.isEmpty {
                Text("No suggestions for this fingerprint.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("\(idx.fingerprint.tags.count) fingerprint tags · \(idx.suggestions.count) suggestions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(idx.suggestions) { s in
                    suggestionRow(s)
                }
            }
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

    @ViewBuilder
    private func userGlobalSection(_ skills: [SkillsIndexResponse.InstalledSkill]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "shippingbox")
                Text("User-global skills").font(.headline)
                Spacer()
                Text("\(skills.count)").font(.caption).foregroundStyle(.secondary)
            }
            Text("~/.claude/skills/")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if skills.isEmpty {
                Text("No user-global skills installed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(skills) { skill in
                    installedRow(name: skill.name, description: skill.description, path: skill.path, badge: nil)
                }
            }
        }
    }

    @ViewBuilder
    private func projectLocalSection(_ skills: [SkillsIndexResponse.ProjectLocalSkill]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "folder")
                Text("Project-local skills").font(.headline)
                Spacer()
                Text("\(skills.count)").font(.caption).foregroundStyle(.secondary)
            }
            Text(".marvin/skills/")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if skills.isEmpty {
                Text("No project-local skills yet. Build one from a Suggested entry above.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(skills) { skill in
                    installedRow(
                        name: skill.name,
                        description: skill.description,
                        path: skill.path,
                        badge: skill.shadowsUserGlobal ? "shadows global" : nil
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func installedRow(name: String, description: String, path: String, badge: String?) -> some View {
        HStack(alignment: .top, spacing: 8) {
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

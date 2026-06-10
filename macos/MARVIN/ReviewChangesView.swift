// ReviewChangesView — VS Code / Cursor-style review of agent edits (ADR-0034).
//
// The sidecar checkpoints every file's pre-image the first time an agent
// Edit / Write / NotebookEdit touches it in a session. This surface is
// the client of the /api/changes/* family built on those checkpoints:
//
//   • ChangesService        — list / per-file hunks / accept-reject calls.
//   • ReviewChangesScreen    — the diff editor: changed files left, a
//                             side-by-side (original | modified) diff right
//                             with line numbers, per-hunk ✓/✗ + per-file
//                             and all-file actions. A Split/Inline toggle
//                             switches between two-column and unified views.
//   • ReviewChangesWindow    — hosts the screen in its OWN large resizable
//                             window (not a sheet clamped to the chat pane),
//                             so the review surface matches the editor diff
//                             of VS Code / Cursor.
//   • AgentChangesStrip     — the live "N files changed" chip that sits
//                             above the chat input while edits stream.
//
// Distinct from SourceControlView on purpose: that pane reviews the git
// working tree vs HEAD (the user's whole world); this reviews ONLY what
// the agent changed since the user last accepted, against pre-agent
// baselines — rejecting here restores the user's uncommitted state, not
// HEAD. (See ADR-0034 for why git discard is the wrong revert.)

import SwiftUI

// MARK: - Cross-window notification

extension Notification.Name {
    /// Posted by ReviewChangesModel after every successful accept/reject.
    /// ChatPreviewView listens so its "N files changed" strip stays honest
    /// even though the review now lives in a separate window. (The model's
    /// onMutate callback only fires for an in-process owner; the review
    /// window's owner is a different view tree, hence the notification.)
    static let marvinAgentChangesDidMutate = Notification.Name("marvin.agentChangesDidMutate")
}

// MARK: - Wire models (mirror sidecar /api/changes/*)

struct AgentChangedFile: Codable, Identifiable, Equatable {
    let path: String
    let status: String          // "added" | "modified" | "deleted"
    let additions: Int
    let deletions: Int
    let firstTurnId: String?
    let lastTouchedAt: String?
    var id: String { path }
}

struct AgentChangesList: Codable {
    let files: [AgentChangedFile]
}

struct AgentDiffLine: Codable, Equatable {
    let kind: String            // "context" | "added" | "removed"
    let text: String
}

struct AgentDiffHunk: Codable, Identifiable, Equatable {
    let index: Int
    let header: String
    let lines: [AgentDiffLine]
    var id: Int { index }
}

struct AgentFileDiff: Codable, Equatable {
    let path: String
    let status: String
    let hunks: [AgentDiffHunk]
}

// MARK: - Service

/// HTTP client for /api/changes/*. Mirrors FilesService' shape — same
/// loopback base URL, same x-marvin-client CSRF header on mutations.
@MainActor
final class ChangesService {
    static let shared = ChangesService()
    private let baseURL = ServerConfig.baseURL
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    func fetchChanges(cwd: String, marvinSessionId: String) async throws -> [AgentChangedFile] {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/changes"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            URLQueryItem(name: "cwd", value: cwd),
            URLQueryItem(name: "marvinSessionId", value: marvinSessionId),
        ]
        let (data, response) = try await session.data(from: comps.url!)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return []  // listing is best-effort UI sugar; never surface an error row
        }
        return (try? JSONDecoder().decode(AgentChangesList.self, from: data))?.files ?? []
    }

    func fetchDiff(cwd: String, marvinSessionId: String, path: String) async throws -> AgentFileDiff {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/changes/diff"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            URLQueryItem(name: "cwd", value: cwd),
            URLQueryItem(name: "marvinSessionId", value: marvinSessionId),
            URLQueryItem(name: "path", value: path),
        ]
        let (data, response) = try await session.data(from: comps.url!)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw FilesServiceError.httpStatus(
                (response as? HTTPURLResponse)?.statusCode ?? -1,
                body: String(data: data, encoding: .utf8)
            )
        }
        return try JSONDecoder().decode(AgentFileDiff.self, from: data)
    }

    /// Accept / reject — all files (path nil), one file, or one hunk.
    /// Returns false on a 409 (stale hunk index) so the caller refetches.
    @discardableResult
    func resolve(
        cwd: String,
        marvinSessionId: String,
        action: String,
        path: String? = nil,
        hunkIndex: Int? = nil
    ) async throws -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/changes/resolve"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        var body: [String: Any] = [
            "cwd": cwd,
            "marvinSessionId": marvinSessionId,
            "action": action,
        ]
        if let path { body["path"] = path }
        if let hunkIndex { body["hunkIndex"] = hunkIndex }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { return false }
        if http.statusCode == 409 { return false }
        return (200..<300).contains(http.statusCode)
    }
}

// MARK: - Diff view mode

enum DiffViewMode: String, CaseIterable {
    case split   // side-by-side, original | modified — the VS Code default
    case inline  // unified single column
}

// MARK: - Review model

@MainActor
@Observable
final class ReviewChangesModel {
    let cwd: String
    let marvinSessionId: String
    /// Called after every successful mutation so an in-process host can
    /// refresh. The review window also posts `.marvinAgentChangesDidMutate`
    /// so cross-window listeners (the chat strip) stay current.
    var onMutate: (() -> Void)?

    var files: [AgentChangedFile] = []
    var selectedPath: String? = nil
    var diff: AgentFileDiff? = nil
    var busy = false
    var loadError: String? = nil
    var viewMode: DiffViewMode = .split

    init(cwd: String, marvinSessionId: String) {
        self.cwd = cwd
        self.marvinSessionId = marvinSessionId
    }

    func refresh() async {
        files = (try? await ChangesService.shared.fetchChanges(
            cwd: cwd, marvinSessionId: marvinSessionId)) ?? []
        // Keep a valid selection; fall to the first file; clear when done.
        if let sel = selectedPath, files.contains(where: { $0.path == sel }) {
            await loadDiff(for: sel)
        } else if let first = files.first {
            selectedPath = first.path
            await loadDiff(for: first.path)
        } else {
            selectedPath = nil
            diff = nil
        }
    }

    func select(_ path: String) {
        selectedPath = path
        Task { await loadDiff(for: path) }
    }

    private func loadDiff(for path: String) async {
        do {
            diff = try await ChangesService.shared.fetchDiff(
                cwd: cwd, marvinSessionId: marvinSessionId, path: path)
            loadError = nil
        } catch {
            diff = nil
            loadError = "Could not load diff for \(path)"
        }
    }

    func resolve(action: String, path: String? = nil, hunkIndex: Int? = nil) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            // A false return = stale hunk index (409) — the refresh below
            // re-syncs the indices, so the user just clicks again.
            _ = try? await ChangesService.shared.resolve(
                cwd: cwd, marvinSessionId: marvinSessionId,
                action: action, path: path, hunkIndex: hunkIndex)
            await refresh()
            onMutate?()
            NotificationCenter.default.post(name: .marvinAgentChangesDidMutate, object: nil)
        }
    }
}

// MARK: - Review window target (app scope)

/// The (cwd, session) the review window should display. ChatPreviewView
/// stamps this from the exact pair it already tracks, then opens the
/// "marvin-review" window — which reads from here. A singleton because the
/// window scene and the chat view live in different view trees and a sheet's
/// captured value isn't available across that boundary.
@MainActor
@Observable
final class ReviewWindowTarget {
    static let shared = ReviewWindowTarget()
    private init() {}
    var cwd: String? = nil
    var sid: String? = nil
    /// Changes whenever the target pair changes — drives the window's
    /// model rebuild so reopening for a different session re-fetches.
    var token: String { "\(cwd ?? "—")|\(sid ?? "—")" }
}

// MARK: - Review window (own large resizable window)

struct ReviewChangesWindow: View {
    @Environment(ReviewWindowTarget.self) private var target
    @State private var model: ReviewChangesModel? = nil
    @State private var builtToken: String = ""

    var body: some View {
        Group {
            if let model {
                ReviewChangesScreen(model: model)
                    .id(builtToken)
            } else {
                noSession
            }
        }
        .frame(minWidth: 820, minHeight: 520)
        .onAppear { rebuildIfNeeded() }
        .onChange(of: target.token) { _, _ in rebuildIfNeeded() }
    }

    private func rebuildIfNeeded() {
        guard let cwd = target.cwd, let sid = target.sid else {
            model = nil
            builtToken = ""
            return
        }
        let token = target.token
        if token == builtToken, model != nil { return }
        builtToken = token
        model = ReviewChangesModel(cwd: cwd, marvinSessionId: sid)
    }

    private var noSession: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text("No active session to review")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Review screen (file list + diff editor)

struct ReviewChangesScreen: View {
    @State var model: ReviewChangesModel

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if model.files.isEmpty {
                emptyState
            } else {
                HSplitView {
                    fileList
                        .frame(minWidth: 240, idealWidth: 280, maxWidth: 380)
                    diffPane
                        .frame(minWidth: 520, maxWidth: .infinity)
                }
            }
        }
        .task(id: model.marvinSessionId) { await model.refresh() }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Image(systemName: "checklist")
                .foregroundStyle(.secondary)
            Text("Review agent changes")
                .font(.system(size: 13, weight: .semibold))
            if !model.files.isEmpty {
                Text("\(model.files.count) file\(model.files.count == 1 ? "" : "s")")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("", selection: Binding(
                get: { model.viewMode },
                set: { model.viewMode = $0 }
            )) {
                Image(systemName: "rectangle.split.2x1").tag(DiffViewMode.split)
                Image(systemName: "list.bullet.rectangle").tag(DiffViewMode.inline)
            }
            .pickerStyle(.segmented)
            .frame(width: 92)
            .help("Split — side-by-side. Inline — unified single column.")
            Divider().frame(height: 16)
            Button("Reject all") { model.resolve(action: "reject") }
                .disabled(model.busy || model.files.isEmpty)
            Button("Accept all") { model.resolve(action: "accept") }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy || model.files.isEmpty)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 28))
                .foregroundStyle(.green)
            Text("No pending agent changes")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var fileList: some View {
        List(model.files, selection: Binding(
            get: { model.selectedPath },
            set: { if let p = $0 { model.select(p) } }
        )) { file in
            HStack(spacing: 6) {
                statusGlyph(file.status)
                VStack(alignment: .leading, spacing: 1) {
                    Text((file.path as NSString).lastPathComponent)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                    Text((file.path as NSString).deletingLastPathComponent)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 4)
                Text("+\(file.additions)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.green)
                Text("−\(file.deletions)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.red)
            }
            .tag(file.path)
            .contextMenu {
                Button("Accept file") { model.resolve(action: "accept", path: file.path) }
                Button("Reject file") { model.resolve(action: "reject", path: file.path) }
            }
        }
        .listStyle(.sidebar)
    }

    private var diffPane: some View {
        VStack(spacing: 0) {
            if let diff = model.diff {
                HStack(spacing: 8) {
                    statusGlyph(diff.status)
                    Text(diff.path)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Reject file") { model.resolve(action: "reject", path: diff.path) }
                        .disabled(model.busy)
                    Button("Accept file") { model.resolve(action: "accept", path: diff.path) }
                        .disabled(model.busy)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                // Opaque + raised so the scrolling diff (line numbers) can
                // never ride up over the file name / path / actions. The
                // ScrollView below is .clipped() and given a lower zIndex.
                .background(Color(nsColor: .windowBackgroundColor))
                .zIndex(1)
                Divider()
                    .zIndex(1)
                if model.viewMode == .split {
                    columnHeader
                        .zIndex(1)
                    Divider()
                        .zIndex(1)
                }
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(diff.hunks) { hunk in
                            if model.viewMode == .split {
                                splitHunkBlock(hunk, path: diff.path)
                            } else {
                                inlineHunkBlock(hunk, path: diff.path)
                            }
                        }
                    }
                    .padding(12)
                    .frame(minWidth: model.viewMode == .split ? 760 : 480, alignment: .leading)
                }
                .zIndex(0)
                .clipped()
            } else if let err = model.loadError {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text("Select a file")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    /// "Original / Modified" captions over the two diff columns.
    private var columnHeader: some View {
        HStack(spacing: 0) {
            Text("Original")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 12)
            Text("Modified")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 12)
        }
        .padding(.vertical, 4)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    // MARK: Split (side-by-side) rendering

    private func splitHunkBlock(_ hunk: AgentDiffHunk, path: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            hunkHeaderBar(hunk, path: path)
            Divider()
            let rows = sideBySideRows(hunk)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    HStack(spacing: 0) {
                        sbCell(num: row.leftNum, text: row.leftText, tint: leftTint(row.kind))
                        Divider()
                        sbCell(num: row.rightNum, text: row.rightText, tint: rightTint(row.kind))
                    }
                }
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func sbCell(num: Int?, text: String?, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(num.map(String.init) ?? "")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 40, alignment: .trailing)
                .padding(.trailing, 8)
            Text(text ?? " ")
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint)
    }

    private func leftTint(_ kind: SBRowKind) -> Color {
        switch kind {
        case .removed, .modified: return Color.red.opacity(0.10)
        case .added: return Color.primary.opacity(0.03)  // empty gutter on the original side
        case .context: return .clear
        }
    }

    private func rightTint(_ kind: SBRowKind) -> Color {
        switch kind {
        case .added, .modified: return Color.green.opacity(0.10)
        case .removed: return Color.primary.opacity(0.03)  // empty gutter on the modified side
        case .context: return .clear
        }
    }

    // MARK: Inline (unified) rendering

    private func inlineHunkBlock(_ hunk: AgentDiffHunk, path: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            hunkHeaderBar(hunk, path: path)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    diffLineRow(line)
                }
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func diffLineRow(_ line: AgentDiffLine) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(line.kind == "added" ? "+" : line.kind == "removed" ? "−" : " ")
                .font(.system(size: 11.5, design: .monospaced))
                .frame(width: 16, alignment: .center)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 11.5, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(
            line.kind == "added" ? Color.green
            : line.kind == "removed" ? Color.red
            : Color.primary.opacity(0.75)
        )
        .background(
            line.kind == "added" ? Color.green.opacity(0.08)
            : line.kind == "removed" ? Color.red.opacity(0.08)
            : Color.clear
        )
    }

    // MARK: Shared hunk header (accept/reject buttons)

    private func hunkHeaderBar(_ hunk: AgentDiffHunk, path: String) -> some View {
        HStack(spacing: 8) {
            Text(hunk.header)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                model.resolve(action: "reject", path: path, hunkIndex: hunk.index)
            } label: {
                Label("Reject", systemImage: "xmark")
                    .font(.system(size: 10))
            }
            .disabled(model.busy)
            .help("Revert this hunk on disk; the rest of the file stays.")
            Button {
                model.resolve(action: "accept", path: path, hunkIndex: hunk.index)
            } label: {
                Label("Accept", systemImage: "checkmark")
                    .font(.system(size: 10))
            }
            .disabled(model.busy)
            .help("Keep this hunk; it stops counting as a pending change.")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    private func statusGlyph(_ status: String) -> some View {
        let (symbol, colour): (String, Color) = switch status {
        case "added": ("plus.circle.fill", .green)
        case "deleted": ("minus.circle.fill", .red)
        default: ("pencil.circle.fill", .orange)
        }
        return Image(systemName: symbol)
            .font(.system(size: 11))
            .foregroundStyle(colour)
    }
}

// MARK: - Side-by-side row construction

enum SBRowKind { case context, modified, added, removed }

struct SBRow: Identifiable {
    let id: Int
    let leftNum: Int?
    let leftText: String?
    let rightNum: Int?
    let rightText: String?
    let kind: SBRowKind
}

/// Pull the original/modified starting line numbers out of a unified hunk
/// header: `@@ -<old>,<n> +<new>,<m> @@ …`. Defaults to 1/1 if malformed.
private func parseHunkStarts(_ header: String) -> (old: Int, new: Int) {
    var old = 1, new = 1
    for token in header.split(separator: " ") {
        if token.hasPrefix("-") {
            if let n = token.dropFirst().split(separator: ",").first.flatMap({ Int($0) }) { old = n }
        } else if token.hasPrefix("+") {
            if let n = token.dropFirst().split(separator: ",").first.flatMap({ Int($0) }) { new = n }
        }
    }
    return (old, new)
}

/// Convert a unified hunk into aligned side-by-side rows. A run of removed
/// lines followed by added lines is paired up index-by-index (the common
/// "N lines changed to M lines" shape); leftover removed lines render as
/// left-only (delete), leftover added as right-only (insert). Context lines
/// flush any pending pair and then advance both columns together.
func sideBySideRows(_ hunk: AgentDiffHunk) -> [SBRow] {
    var rows: [SBRow] = []
    var (oldLine, newLine) = parseHunkStarts(hunk.header)
    var rem: [String] = []
    var add: [String] = []
    var idx = 0

    func flush() {
        let n = max(rem.count, add.count)
        var i = 0
        while i < n {
            let l = i < rem.count ? rem[i] : nil
            let r = i < add.count ? add[i] : nil
            let kind: SBRowKind = (l != nil && r != nil) ? .modified : (l != nil ? .removed : .added)
            rows.append(SBRow(
                id: idx,
                leftNum: l != nil ? oldLine : nil,
                leftText: l,
                rightNum: r != nil ? newLine : nil,
                rightText: r,
                kind: kind))
            if l != nil { oldLine += 1 }
            if r != nil { newLine += 1 }
            idx += 1
            i += 1
        }
        rem.removeAll(keepingCapacity: true)
        add.removeAll(keepingCapacity: true)
    }

    for line in hunk.lines {
        switch line.kind {
        case "removed": rem.append(line.text)
        case "added": add.append(line.text)
        default:
            flush()
            rows.append(SBRow(
                id: idx,
                leftNum: oldLine, leftText: line.text,
                rightNum: newLine, rightText: line.text,
                kind: .context))
            oldLine += 1
            newLine += 1
            idx += 1
        }
    }
    flush()
    return rows
}

// MARK: - Live chip strip (hosted by ChatPreviewView)

struct AgentChangesStrip: View {
    let files: [AgentChangedFile]
    let onReview: () -> Void

    private var additions: Int { files.reduce(0) { $0 + $1.additions } }
    private var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "pencil.and.outline")
                .font(.system(size: 10))
                .foregroundStyle(.orange)
            Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                .font(.system(size: 11, design: .monospaced))
            Text("+\(additions)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.green)
            Text("−\(deletions)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.red)
            Spacer()
            Button("Review", action: onReview)
                .font(.system(size: 11))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.06))
    }
}

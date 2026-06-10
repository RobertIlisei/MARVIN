// ReviewChangesView — Cursor-style review of agent edits (ADR-0034).
//
// The sidecar checkpoints every file's pre-image the first time an agent
// Edit / Write / NotebookEdit touches it in a session. This surface is
// the client of the /api/changes/* family built on those checkpoints:
//
//   • ChangesService        — list / per-file hunks / accept-reject calls.
//   • ReviewChangesSheet    — split view: changed files left, hunks right,
//                             per-hunk ✓/✗ + per-file and all-file actions.
//   • AgentChangesStrip     — the live "N files changed" chip that sits
//                             above the chat input while edits stream.
//
// Distinct from SourceControlView on purpose: that pane reviews the git
// working tree vs HEAD (the user's whole world); this reviews ONLY what
// the agent changed since the user last accepted, against pre-agent
// baselines — rejecting here restores the user's uncommitted state, not
// HEAD. (See ADR-0034 for why git discard is the wrong revert.)

import SwiftUI

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

// MARK: - Review model

@MainActor
@Observable
final class ReviewChangesModel {
    let cwd: String
    let marvinSessionId: String
    /// Called after every successful mutation so the host chip refreshes.
    var onMutate: (() -> Void)?

    var files: [AgentChangedFile] = []
    var selectedPath: String? = nil
    var diff: AgentFileDiff? = nil
    var busy = false
    var loadError: String? = nil

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
        }
    }
}

// MARK: - Review sheet

struct ReviewChangesSheet: View {
    @State var model: ReviewChangesModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if model.files.isEmpty {
                emptyState
            } else {
                HSplitView {
                    fileList
                        .frame(minWidth: 220, idealWidth: 260, maxWidth: 360)
                    diffPane
                        .frame(minWidth: 420, maxWidth: .infinity)
                }
            }
        }
        .frame(minWidth: 760, idealWidth: 960, minHeight: 420, idealHeight: 620)
        .task { await model.refresh() }
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
            Button("Reject all") { model.resolve(action: "reject") }
                .disabled(model.busy || model.files.isEmpty)
            Button("Accept all") { model.resolve(action: "accept") }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy || model.files.isEmpty)
            Button("Done") { dismiss() }
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
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(diff.hunks) { hunk in
                            hunkBlock(hunk, path: diff.path)
                        }
                    }
                    .padding(12)
                }
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

    private func hunkBlock(_ hunk: AgentDiffHunk, path: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
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
        HStack(spacing: 0) {
            Text(line.kind == "added" ? "+" : line.kind == "removed" ? "−" : " ")
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 16, alignment: .center)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
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

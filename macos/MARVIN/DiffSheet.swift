// DiffSheet — Phase 3f. Native unified-diff viewer.
//
// Renders the response from GET /api/git/diff through the same line
// vocabulary as Review Changes (DiffRows.swift): the text is parsed once
// (`UnifiedDiff`), git's own header lines become one summary strip, and each
// hunk is drawn with numbered, signed, washed rows. Text that does not parse
// is shown as git said it, never dropped. Mode picker at the top lets the
// user switch between working / staged / combined diffs without
// closing the sheet.
//
// ## Why a sheet, not an inline / right-pane viewer
//
// The main window's HSplitView already has three panes (left =
// files+SCM, middle = chat, right = WebView). Adding a fourth
// would push the chat / WebView too narrow at typical window
// widths. A modal sheet is the macOS-native affordance for
// "transient inspection of one item from a list" — same pattern
// Xcode's "View Changes…" uses.
//
// Phase 5 will absorb this into the Monaco-port side-by-side diff
// viewer; the unified-text approach here is deliberately minimal
// per ADR-0018 §4 (out of scope: side-by-side until Phase 5).

import MARVINLogic
import SwiftUI

/// Diff mode the sheet's Picker drives. Wire values match the
/// route's `?mode=` query param exactly — the Picker writes a
/// String and we hand that straight to FilesService.fetchDiff.
/// Internal (not private) so SourceControlView can pick the
/// natural initial mode for a row before constructing the model.
enum DiffMode: String, CaseIterable, Identifiable {
    case working
    case staged
    case head
    var id: String { rawValue }

    var label: String {
        switch self {
        case .working: return "Working"
        case .staged: return "Staged"
        case .head: return "Combined"
        }
    }
}

/// View-model for the sheet. Owns the in-flight fetch + the
/// rendered response. One model per sheet instance — no singleton.
/// Caller passes the cwd + relative path on init; the model
/// re-fetches when the mode changes.
@MainActor
@Observable
final class DiffSheetModel {
    let cwd: String
    let relativePath: String

    var mode: DiffMode = .working
    private(set) var response: GitDiffResponse? = nil
    /// `response.diff` parsed; nil when it is not one file's unified diff, in
    /// which case the sheet shows the raw text.
    private(set) var parsed: UnifiedDiff? = nil
    private(set) var isLoading: Bool = false
    private(set) var lastError: String? = nil

    private var fetchTask: Task<Void, Never>?

    init(cwd: String, relativePath: String, initialMode: DiffMode = .working) {
        self.cwd = cwd
        self.relativePath = relativePath
        self.mode = initialMode
    }

    /// Fetch the diff for the current mode. Cancels any in-flight
    /// fetch so a rapid mode-toggle doesn't race.
    func load() {
        fetchTask?.cancel()
        isLoading = true
        lastError = nil
        let captured = mode
        fetchTask = Task { @MainActor in
            defer { isLoading = false }
            do {
                let res = try await FilesService.shared.fetchDiff(
                    cwd: cwd,
                    path: relativePath,
                    mode: captured.rawValue
                )
                guard !Task.isCancelled, mode == captured else { return }
                response = res
                parsed = (res.binary || res.truncated) ? nil : UnifiedDiff.parse(res.diff)
            } catch is CancellationError {
                /* mode flipped under us — quiet */
            } catch {
                guard !BenignCancellation.matches(error) else { return }
                lastError = "\(error)"
            }
        }
    }
}

@MainActor struct DiffSheet: View {
    @State var model: DiffSheetModel
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            MarvinDivider()
            body_
            if let err = model.lastError {
                MarvinDivider()
                errorBanner(err)
            }
        }
        .frame(minWidth: 720, idealWidth: 900, minHeight: 480, idealHeight: 640)
        .onAppear { model.load() }
        .onChange(of: model.mode) { _, _ in
            model.load()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.relativePath)
                    .font(.callout.weight(.semibold).monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("git diff")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Picker("Diff mode", selection: Bindable(model).mode) {
                ForEach(DiffMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 240)
            if model.isLoading {
                ProgressView().controlSize(.small)
            }
            Button("Done") { onDismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(12)
    }

    @ViewBuilder
    private var body_: some View {
        if let response = model.response {
            if response.binary {
                placeholder("(binary file — diff not shown)")
            } else if response.truncated {
                placeholder("(diff exceeded 2 MB cap — open in editor for full view)")
            } else if response.diff.isEmpty {
                placeholder("(no changes for this mode)")
            } else if let parsed = model.parsed {
                structured(parsed)
            } else {
                rawText(response.diff)
            }
        } else if model.isLoading {
            placeholder("Loading…")
        } else {
            placeholder(" ")
        }
    }

    /// One flat list of rows, so a long diff virtualises and every hunk draws
    /// with the same rows Review Changes uses.
    private struct Row: Identifiable {
        let id: Int
        let content: Content
        enum Content {
            case hunk(String)
            case line(UnifiedDiffLine)
        }
    }

    private func rows(for diff: UnifiedDiff) -> [Row] {
        var out: [Row] = []
        for hunk in diff.hunks {
            out.append(Row(id: out.count, content: .hunk(hunk.header)))
            for line in hunk.lines { out.append(Row(id: out.count, content: .line(line))) }
        }
        return out
    }

    private func structured(_ diff: UnifiedDiff) -> some View {
        VStack(spacing: 0) {
            summaryStrip(diff)
            if diff.hunks.isEmpty {
                placeholder(diff.isBinary ? "(binary file — diff not shown)" : "(no content changes)")
            } else {
                // Top-aligned and vertical-only: a two-axis ScrollView centres
                // content shorter than the viewport, which left the sheet's
                // diff floating under a tall empty band (U16).
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(rows(for: diff)) { row in
                            switch row.content {
                            case let .hunk(header): DiffHunkBar(header: header) { EmptyView() }
                            case let .line(line):
                                DiffLineRow(kind: line.kind, text: line.text,
                                            number: line.newNumber ?? line.oldNumber, showsNumbers: true)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .background(MarvinTheme.panel)
            }
        }
    }

    /// git's `diff --git` / `index` / `---` / `+++` header said in one line, and
    /// only what the title does not already say: a rename, a new or deleted
    /// file, a mode change, and the counts.
    @ViewBuilder
    private func summaryStrip(_ diff: UnifiedDiff) -> some View {
        let notes = [
            diff.isNewFile ? "New file" : nil,
            diff.isDeletedFile ? "Deleted file" : nil,
            diff.renamedFrom.map { "Renamed from \($0)" },
            (diff.oldMode != nil && diff.newMode != nil) ? "Mode \(diff.oldMode!) → \(diff.newMode!)" : nil,
        ].compactMap { $0 }
        if !notes.isEmpty || diff.additions + diff.deletions > 0 {
            HStack(spacing: 10) {
                Text(notes.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                if diff.additions + diff.deletions > 0 {
                    Text("+\(diff.additions)")
                        .foregroundStyle(GitDecorationColor.added)
                    Text("\u{2212}\(diff.deletions)")
                        .foregroundStyle(GitDecorationColor.deleted)
                }
            }
            .font(.system(size: 11, design: .monospaced))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            MarvinDivider()
        }
    }

    /// The parse failed: show git's text unchanged, with a line saying why it
    /// is plain.
    private func rawText(_ text: String) -> some View {
        VStack(spacing: 0) {
            Text("Couldn't read this as a diff — showing git's output as is.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            MarvinDivider()
            ScrollView([.vertical, .horizontal]) {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(MarvinTheme.panel)
        }
    }

    private func placeholder(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(.body.monospaced())
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Diff fetch error")
                    .font(.caption.weight(.semibold))
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
    }
}

extension DiffSheet {
    /// Pick the natural initial mode for a given SCM file. Staged-
    /// only changes default to "Staged"; everything else defaults to
    /// "Working". The user can flip in the sheet.
    static func initialMode(for file: GitStatusFile) -> String {
        if file.workingStatus == "." && file.indexStatus != "." {
            return "staged"
        }
        return "working"
    }
}

// DiffSheet — Phase 3f. Native unified-diff viewer.
//
// Renders the response from GET /api/git/diff as monospace text
// with per-line tinting (green for `+`, red for `-`, gray for hunk
// headers, default for context). Mode picker at the top lets the
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
            } catch is CancellationError {
                /* mode flipped under us — quiet */
            } catch {
                lastError = "\(error)"
            }
        }
    }
}

/// One line classified for tinting. We split the raw diff text on
/// "\n" once and tag each line so SwiftUI's diff stays cheap on
/// updates. (A full attributed-string would re-render on every
/// scroll — measured slower for our 50-line typical diff.)
private enum DiffLineKind {
    case header   // "diff --git", "index", "@@"
    case added    // "+ ..."
    case removed  // "- ..."
    case context  // " ..."
    case meta     // "--- a/..." / "+++ b/..."

    var foreground: Color {
        switch self {
        case .header, .meta: return .secondary
        case .added: return .green
        case .removed: return .red
        case .context: return .primary
        }
    }

    var background: Color {
        switch self {
        case .added: return Color.green.opacity(0.08)
        case .removed: return Color.red.opacity(0.08)
        case .header, .meta, .context: return .clear
        }
    }
}

private struct DiffLine: Identifiable {
    let id: Int
    let kind: DiffLineKind
    let text: String
}

/// Classify one diff line. Order matters: hunk headers start with
/// "@@" but contain "+" mid-line; check prefixes most-specific-first.
private func classify(_ line: String) -> DiffLineKind {
    if line.hasPrefix("diff --git") || line.hasPrefix("index ")
        || line.hasPrefix("@@") {
        return .header
    }
    if line.hasPrefix("--- ") || line.hasPrefix("+++ ") {
        return .meta
    }
    if line.hasPrefix("+") { return .added }
    if line.hasPrefix("-") { return .removed }
    return .context
}

struct DiffSheet: View {
    @State var model: DiffSheetModel
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            body_
            if let err = model.lastError {
                Divider()
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
            } else {
                diffBody(text: response.diff)
            }
        } else if model.isLoading {
            placeholder("Loading…")
        } else {
            placeholder(" ")
        }
    }

    private func diffBody(text: String) -> some View {
        // Split + classify once on render. ScrollViewReader is
        // omitted because we don't need to programmatically scroll;
        // the user drives via trackpad / scroll wheel.
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated()
            .map { (i, sub) in
                DiffLine(id: i, kind: classify(String(sub)), text: String(sub))
            }
        return ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lines) { line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(line.kind.foreground)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.kind.background)
                }
            }
            .textSelection(.enabled)
        }
        .background(Color(nsColor: .textBackgroundColor))
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

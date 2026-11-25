// SourceControlPreview — the selected file's diff, under the list.
//
// A hundred changed files means a person walks the list with the arrow keys, and
// a walk must never wait on git. So the preview is lazy in four ways: nothing is
// fetched until a file is SELECTED; a selection that moves on within 150 ms never
// reaches git at all (arrowing through twenty files is one request, not twenty);
// the request is cancelled the moment the selection moves; and the diff is
// parsed and cut down off the main actor, so a 2 MB diff costs the list nothing.
// The full diff stays the sheet — this is the glance (`DiffPreview`).
//
// Measured, 2026-11-25, on a 2.2 MB / 40,000-line diff: parse + preview 30 ms
// (MARVINTests prints it), run on a detached task.

import MARVINLogic
import SwiftUI

@MainActor
@Observable
final class SourceControlPreviewModel {
    enum State: Equatable {
        case idle
        case loading
        case ready(DiffPreview)
        /// Nothing to draw, and why.
        case note(String)
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var item: ChangeItem? = nil
    /// Wall time of the last load, fetch + parse, for the snapshot harness.
    private(set) var lastLoadMs: Int? = nil

    static let maxRows = 14
    private static let debounce: Duration = .milliseconds(150)
    private var task: Task<Void, Never>?

    func show(cwd: String, item: ChangeItem, force: Bool = false) {
        if !force, self.item == item, state != .idle { return }
        task?.cancel()
        self.item = item
        switch item.group {
        case .untracked:
            state = .note("Untracked — git has no earlier version to compare. Stage it to include it in a commit.")
            return
        case .conflicts:
            state = .note("Conflicted — open the diff to see both sides.")
            return
        case .staged, .changes:
            break
        }
        state = .loading
        let mode = item.group == .staged ? "staged" : "working"
        let path = item.path
        task = Task { @MainActor in
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            let started = Date()
            do {
                let res = try await FilesService.shared.fetchDiff(cwd: cwd, path: path, mode: mode)
                guard !Task.isCancelled else { return }
                if let why = DiffPreview.empty(binary: res.binary, truncated: res.truncated, empty: res.diff.isEmpty) {
                    state = .note(why)
                    return
                }
                let text = res.diff
                let preview = await Task.detached(priority: .userInitiated) { () -> DiffPreview? in
                    UnifiedDiff.parse(text).map { DiffPreview.make($0, maxRows: SourceControlPreviewModel.maxRows) }
                }.value
                guard !Task.isCancelled else { return }
                lastLoadMs = Int(Date().timeIntervalSince(started) * 1000)
                state = preview.map(State.ready) ?? .note("Could not read this as a diff — open it to see git's own output.")
            } catch is CancellationError {
                /* the selection moved — quiet */
            } catch {
                guard !BenignCancellation.matches(error) else { return }
                state = .failed("\(error)")
            }
        }
    }

    func clear() {
        task?.cancel()
        task = nil
        item = nil
        state = .idle
    }
}

@MainActor struct SourceControlPreviewView: View {
    let model: SourceControlPreviewModel
    let name: String
    /// What the pane can spare for the diff below the header; the plan decides, not this view.
    var maxBodyHeight: CGFloat = 150
    let onOpen: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            MarvinDivider()
            HStack(spacing: 6) {
                Text(name)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if case .ready(let p) = model.state, !p.summary.isEmpty {
                    Text(p.summary)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Button("Open diff", action: onOpen).rowChip(.neutral)
                    .help("Open the whole diff (⏎)")
                Button(action: onClose) { Image(systemName: "xmark") }
                    .paneIconButton(8)
                    .help("Close preview")
                    .accessibilityLabel("Close preview")
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            content
        }
        .background(MarvinTheme.panel)
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle:
            EmptyView()
        case .loading:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 12, height: 12)
                Text("Loading diff…").font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8)
        case .note(let text):
            Text(text)
                .font(.system(size: 10.5))
                .foregroundStyle(MarvinTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 8)
        case .failed(let text):
            PaneNoticeStrip(notice: PaneNotice(kind: .error, text: "Could not load the diff: \(text)"))
                .padding(.bottom, 4)
        case .ready(let p):
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(p.rows.enumerated()), id: \.offset) { _, row in
                        switch row {
                        case .hunk(let header): DiffHunkBar(header: header) { EmptyView() }
                        case .line(let line):
                            DiffLineRow(kind: line.kind, text: line.text, number: line.newNumber ?? line.oldNumber)
                        }
                    }
                    if p.hiddenRows > 0 {
                        Text("\(p.hiddenRows) more rows — open the diff to see them")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12).padding(.vertical, 4)
                    }
                }
            }
            .frame(maxHeight: maxBodyHeight)
        }
    }
}

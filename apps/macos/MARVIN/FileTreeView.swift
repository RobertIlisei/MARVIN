// FileTreeView — Phase 3b dev surface for the native file tree.
//
// A separate Window scene hosting a SwiftUI `OutlineGroup` rendering
// of the active project's `/api/files/tree` response. The main
// MARVIN window's WebView keeps rendering the existing web file tree
// independently; Phase 3d promotes this content into the main left
// pane once 3c (selection wiring) reaches parity.
//
// ## Why a separate window during 3b
//
//   1. Decoupled iteration. The main window's left pane currently
//      hosts the web file tree the user actively works in. We don't
//      want a half-built native tree replacing it while we're still
//      figuring out renderer perf and selection semantics.
//   2. Independent observation. The dev window can run alongside
//      the web tree in the main window, so we can A/B parity
//      between them — open the same project, watch the same file
//      list populate in both surfaces.
//
// ## Why OutlineGroup before NSOutlineView
//
// ADR-0018 §5 defers the OutlineGroup-vs-NSOutlineView call until
// we have a measurement on a real ~5k-file repo. SwiftUI's
// OutlineGroup ships in 2 lines of code and exposes the `children`
// keyPath natively — perfect for our `FileNode.children?` shape.
// If frame drops show up at scale we drop down to NSOutlineView via
// `NSViewRepresentable`; the model layer (FileTreeModel) stays
// unchanged either way.

import SwiftUI

/// View-model for the file tree preview. Owns the fetch state, the
/// rendered tree, and a terminal-state surface for fetch errors.
/// Phase 3b: read-only — selection / expand-state / refresh are
/// stubbed for 3c.
@MainActor
@Observable
final class FileTreeModel {
    /// Last successful tree response. Nil until first fetch
    /// completes (or after a failed initial fetch).
    private(set) var response: FileTreeResponse? = nil

    /// True while a fetch is in flight. Drives the spinner shown
    /// next to the project name in the header.
    private(set) var isLoading: Bool = false

    /// Last error surfaced as a banner. Cleared on next refresh.
    private(set) var lastError: String? = nil

    /// The cwd the response in `response` was fetched against —
    /// guards against rendering a stale tree after a project switch
    /// races a slow fetch. The fetch task drops its result if cwd
    /// has changed under it.
    private(set) var loadedCwd: String? = nil

    /// In-flight fetch task. Retained so we can cancel on a rapid
    /// project switch — otherwise two concurrent fetches race and
    /// the loser overwrites the winner.
    private var fetchTask: Task<Void, Never>?

    /// Phase 3c — currently-selected file path. nil means nothing
    /// selected (the empty initial state, or the most-recently-
    /// selected file's project was just closed). The view diffs
    /// rows on this to draw the highlighted selection background;
    /// the dispatch to the web side is performed in the row tap
    /// handler, not here, so the model stays bridge-agnostic.
    var selectedPath: String? = nil

    /// Kick off a tree fetch for `cwd`. Idempotent: re-calling with
    /// a cwd that matches the most-recently loaded one is a no-op
    /// when we already have a response (caller can pass `force:
    /// true` after a known mutation to bypass the dedupe).
    func refresh(cwd: String, force: Bool = false) {
        if !force, response != nil, loadedCwd == cwd, !isLoading {
            return
        }
        fetchTask?.cancel()
        isLoading = true
        lastError = nil
        fetchTask = Task { @MainActor in
            defer { isLoading = false }
            do {
                let res = try await FilesService.shared.fetchTree(cwd: cwd)
                // Drop late results from a previous project — the
                // caller has since asked for a different cwd, and
                // rendering this would flash old content.
                guard !Task.isCancelled else { return }
                response = res
                loadedCwd = cwd
            } catch is CancellationError {
                // Quiet — racing with a project switch.
            } catch {
                lastError = "\(error)"
            }
        }
    }

    /// Clear all state. Called when the bridge reports no active
    /// project, so the user doesn't see a stale tree from a project
    /// they just closed.
    func clear() {
        fetchTask?.cancel()
        fetchTask = nil
        response = nil
        loadedCwd = nil
        lastError = nil
        isLoading = false
        selectedPath = nil
    }
}

/// The preview window itself. Layout:
///
///   ┌──────────────────────────────────┐
///   │ Files preview · projectName      │
///   ├──────────────────────────────────┤
///   │ ▾ src                            │
///   │   ▸ components                   │
///   │   ▾ lib                          │
///   │     ▫ csrf.ts                    │
///   ├──────────────────────────────────┤
///   │ ⚠ error banner (if any)          │
///   └──────────────────────────────────┘
struct FileTreeView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = FileTreeModel()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            if let err = model.lastError {
                Divider()
                errorBanner(err)
            }
        }
        // Sizing is owned by the parent (LeftPane / HSplitView in
        // ContentView) — this view fills whatever it's given. We
        // used to set minWidth: 320 / minHeight: 420 here for the
        // standalone preview window in 3b; that window retired in
        // 3d so the floor goes away.
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFetchFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            syncFetchFromBridge()
        }
        // Phase 3h — Finder-style space-bar Quick Look. .focusable()
        // gives the tree a focus ring (subtle; SwiftUI's default
        // styling is appropriate here) so macOS routes key events
        // through `.onKeyPress` once the user has clicked into the
        // tree. We swallow the press by returning `.handled` only
        // when there's a selected file to preview — otherwise the
        // event bubbles up so a non-file selection (or no selection)
        // doesn't eat the space-bar in case some ancestor wants it.
        .focusable()
        .onKeyPress(.space) {
            guard let selected = model.selectedPath,
                  !selected.isEmpty else {
                return .ignored
            }
            QuickLookCoordinator.shared.show(
                url: URL(fileURLWithPath: selected)
            )
            return .handled
        }
    }

    /// Phase 3c — handle a tap on a row. Files dispatch through the
    /// bridge so the existing web FileViewer (Monaco) opens them in
    /// the main window. Directories don't dispatch — taps on a
    /// directory row should expand/collapse via the disclosure
    /// triangle, which OutlineGroup handles itself; we just
    /// suppress the no-op dispatch here. Selection state still
    /// updates so the user sees the row highlight regardless.
    ///
    /// Reverse direction (web tree click → native highlight) is
    /// deferred to Phase 3d per ADR-0018 §3 — once the native tree
    /// is the main left pane, only one source of truth exists for
    /// selection and the round-trip becomes redundant.
    private func selectRow(_ node: FileNode) {
        model.selectedPath = node.path
        guard !node.isDirectory else { return }
        WebViewCommands.shared.dispatchWebCommand(
            "select-file",
            detail: ["path": node.path]
        )
    }

    /// Phase 3b — drive the model from bridge.projectWorkDir.
    /// Mirrors the pattern ChatPreviewView uses for sessionId in
    /// Phase 2h: an .onAppear + .onChange pair funnel through one
    /// helper that's idempotent at the model layer. Centralising
    /// the trigger logic here means the model itself doesn't need
    /// to know the bridge exists — keeps the view-model testable
    /// without a bridge mock.
    private func syncFetchFromBridge() {
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty else {
            model.clear()
            return
        }
        model.refresh(cwd: cwd)
    }

    private var header: some View {
        HStack {
            Text(bridge.projectName ?? "no project active")
                .font(.callout.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if model.isLoading {
                ProgressView()
                    .controlSize(.small)
            }
            Button {
                if let cwd = bridge.projectWorkDir {
                    model.refresh(cwd: cwd, force: true)
                }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(bridge.projectWorkDir == nil)
            .help("Re-fetch /api/files/tree for the active project.")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        if bridge.projectWorkDir == nil {
            placeholder("(no project active)")
        } else if let response = model.response {
            if response.tree.isEmpty {
                placeholder("(empty tree)")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // OutlineGroup binds disclosure state to the
                        // recursive `children` keyPath — directories
                        // open / close on the disclosure triangle
                        // automatically. SwiftUI handles the diff,
                        // so we don't need a parent-id map ourselves.
                        OutlineGroup(
                            response.tree,
                            children: \.outlineChildren
                        ) { node in
                            FileTreeRow(
                                node: node,
                                isSelected: model.selectedPath == node.path,
                                onTap: { selectRow(node) }
                            )
                        }
                        .padding(.horizontal, 8)
                    }
                    .padding(.vertical, 6)
                }
                if response.truncated {
                    truncatedBanner(count: response.count)
                }
            }
        } else if model.isLoading {
            placeholder("Loading…")
        } else {
            // No response yet, no fetch in flight, no error — the
            // model hasn't been kicked yet. Hits on the very first
            // .onAppear before the .task fires; transient.
            placeholder("(initialising)")
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
        .frame(maxWidth: .infinity)
    }

    private func truncatedBanner(count: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Tree truncated")
                    .font(.caption.weight(.semibold))
                Text("\(count) entries shown — increase MARVIN_TREE_MAX_ENTRIES on the sidecar to see more.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Fetch error")
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

/// One row in the tree. Phase 3c: clicking a file fires `onTap`
/// which the parent uses to dispatch a `marvin:select-file` event
/// to the web side. Phase 3h: file rows are drag sources for
/// Finder (drop into a Finder window copies the file) and offer
/// Quick Look via context menu / space bar (handled at the
/// FileTreeView level).
///
/// The folder/file icon is an SF Symbol so we get the user's accent
/// colour for free; the row is tagged with the node's absolute path
/// so tests / future drag-source code can pick rows up by path.
private struct FileTreeRow: View {
    let node: FileNode
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: node.isDirectory ? "folder.fill" : "doc")
                .foregroundStyle(node.isDirectory ? .blue : .secondary)
                .frame(width: 16)
            Text(node.name)
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(isSelected ? Color.white : .primary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(isSelected ? Color.accentColor : .clear)
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        // Phase 3h — drag a file row into Finder to copy the file.
        // SwiftUI's `.draggable` with a URL transferable produces the
        // standard NSPasteboard fileURL type Finder accepts; the OS
        // handles the copy operation including drag preview, drop
        // animation, and post-drop progress UI without us doing
        // anything else. Folders are deliberately not draggable —
        // dragging a directory into Finder would copy the whole
        // subtree which is rarely what the user wants from the
        // sidebar; Reveal in Finder via context menu + use Finder
        // is the more sensible flow.
        .ifLet(node.isDirectory ? nil : URL(fileURLWithPath: node.path)) { view, fileURL in
            view.draggable(fileURL)
        }
        // Phase 3h — context menu surfaces the affordances that
        // don't fit on a tappable row: Quick Look (also bound to
        // space bar at the tree level), Reveal in Finder, Copy path.
        // Folders get only Reveal + Copy — Quick Look on a directory
        // would just open Finder, which the Reveal action already
        // does directly.
        .contextMenu {
            if !node.isDirectory {
                Button("Quick Look") {
                    QuickLookCoordinator.shared.show(
                        url: URL(fileURLWithPath: node.path)
                    )
                }
                .keyboardShortcut(.space, modifiers: [])
                Divider()
            }
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting(
                    [URL(fileURLWithPath: node.path)]
                )
            }
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.path, forType: .string)
            }
        }
        .accessibilityIdentifier("file-tree-row:\(node.path)")
    }
}

/// Conditional view-builder helper. SwiftUI doesn't have a native
/// `.if` modifier (and adding `.draggable(nil)` directly isn't
/// supported), so we wrap the optional-conditional shape that the
/// drag source needs into a small extension. Used here only —
/// keeps the modifier private.
private extension View {
    @ViewBuilder
    func ifLet<T, Content: View>(
        _ value: T?,
        @ViewBuilder transform: (Self, T) -> Content
    ) -> some View {
        if let value {
            transform(self, value)
        } else {
            self
        }
    }
}

/// SwiftUI's OutlineGroup needs a recursive `children` keyPath that
/// returns nil for leaves and the (possibly empty) child array for
/// branches. FileNode's wire shape uses `nil` for leaf files; an
/// empty children array on a directory means "empty folder, still
/// expandable". We keep both shapes intact and surface them through
/// this computed accessor — wraps a `nil → nil`, `[] → []`, `[…] →
/// […]` mapping in one place so the view doesn't reach into the
/// model's optional handling repeatedly.
private extension FileNode {
    var outlineChildren: [FileNode]? {
        guard isDirectory else { return nil }
        return children ?? []
    }
}

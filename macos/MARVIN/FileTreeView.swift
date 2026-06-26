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

    // Phase 5c (ADR-0020) — file mutation dialog state. The IDE-feel
    // context-menu actions (New File / New Folder / Rename / Move to
    // Trash) drive a small set of sheets + alerts here. We keep the
    // state hoisted on FileTreeView (rather than per-row) so the
    // OutlineGroup row identity stays stable when a sheet opens.

    /// Backing state for the "New file" / "New folder" sheet.
    @State private var newEntryContext: NewEntryContext? = nil
    /// Backing state for the "Rename" sheet.
    @State private var renameContext: RenameContext? = nil
    /// Backing state for the "Move to Trash" confirm alert.
    @State private var trashContext: FileNode? = nil
    /// Surface mutation errors (HTTP 4xx/5xx, transport) inline.
    @State private var mutationError: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            if let err = model.lastError {
                Divider()
                errorBanner(err)
            }
            if let err = mutationError {
                Divider()
                errorBanner("Mutation: \(err)")
            }
        }
        // New file / folder sheet — bound to newEntryContext.
        .sheet(item: $newEntryContext) { ctx in
            NewEntrySheet(
                context: ctx,
                onCreate: { name in
                    Task { await performCreate(parent: ctx.parentDir, kind: ctx.kind, name: name) }
                },
                onCancel: { newEntryContext = nil }
            )
        }
        // Rename sheet.
        .sheet(item: $renameContext) { ctx in
            RenameSheet(
                context: ctx,
                onRename: { newName in
                    Task { await performRename(node: ctx.node, newName: newName) }
                },
                onCancel: { renameContext = nil }
            )
        }
        // Trash confirm alert.
        .alert(
            "Move to Trash?",
            isPresented: Binding(
                get: { trashContext != nil },
                set: { if !$0 { trashContext = nil } }
            ),
            presenting: trashContext
        ) { node in
            Button("Move to Trash", role: .destructive) {
                Task { await performTrash(node: node) }
            }
            Button("Cancel", role: .cancel) { trashContext = nil }
        } message: { node in
            Text("Move \"\(node.name)\" to the Trash? You can restore it from the Trash if you change your mind.")
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
        // Phase 3h — Finder-style space-bar Quick Look. `.focusable()`
        // makes the tree key-targetable; `.focusEffectDisabled()`
        // hides the system focus ring (a stark blue rectangle around
        // the WHOLE pane every time the user clicked a row). We
        // already render selection per-row via FileTreeRow's own
        // accent background, so the ring was visual noise and the
        // pane wasn't the right thing to outline anyway. Phase 5f.
        .focusable()
        .focusEffectDisabled()
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
        // Phase 5a — also publish the selection on the bridge so the
        // native file viewer (FileViewerView, in a side preview window
        // during 5a; promoted inline at 5c) sees the same source. The
        // WebView's Monaco still consumes the dispatchWebCommand
        // event; the native viewer reads from bridge.selectedFilePath.
        bridge.setSelectedFile(node.path)
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
        HStack(spacing: 6) {
            Text(bridge.projectName ?? "no project active")
                .font(.callout.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if model.isLoading {
                ProgressView()
                    .controlSize(.small)
            }
            // Phase 5c — IDE-style "new file" + "new folder" buttons
            // in the tree header. They both create at the project
            // root by default; a right-click on a directory row offers
            // the same actions scoped to that directory.
            Button {
                if let workDir = bridge.projectWorkDir {
                    newEntryContext = NewEntryContext(
                        parentDir: workDir,
                        kind: .file
                    )
                }
            } label: {
                Image(systemName: "doc.badge.plus")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(bridge.projectWorkDir == nil)
            .help("New file in project root")
            Button {
                if let workDir = bridge.projectWorkDir {
                    newEntryContext = NewEntryContext(
                        parentDir: workDir,
                        kind: .dir
                    )
                }
            } label: {
                Image(systemName: "folder.badge.plus")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(bridge.projectWorkDir == nil)
            .help("New folder in project root")
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
                // Phase 5f — tree rendered with `List` instead of
                // `LazyVStack`, because `OutlineGroup` only auto-indents
                // its descendants when it's hosted inside a `List`.
                // Inside a LazyVStack every row draws at depth-0, so
                // the tree looked flat — every file at the same x as
                // the project root. `.listStyle(.sidebar)` gives us
                // the native macOS sidebar look with disclosure
                // triangles + per-depth indentation guides, matching
                // Xcode's project navigator and Finder's column view.
                //
                // The row still owns its selection highlight; we
                // suppress List's default row background + separators
                // so List's selection style doesn't double-stack with
                // the row's accent fill.
                List {
                    OutlineGroup(
                        response.tree,
                        children: \.outlineChildren
                    ) { node in
                        FileTreeRow(
                            node: node,
                            isSelected: model.selectedPath == node.path,
                            onTap: { selectRow(node) },
                            onNewFile: {
                                newEntryContext = NewEntryContext(
                                    parentDir: parentDir(for: node),
                                    kind: .file
                                )
                            },
                            onNewFolder: {
                                newEntryContext = NewEntryContext(
                                    parentDir: parentDir(for: node),
                                    kind: .dir
                                )
                            },
                            onRename: {
                                renameContext = RenameContext(node: node)
                            },
                            onTrash: { trashContext = node }
                        )
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                // Crash fix (v0.1.26): SwiftUI's `List` + `OutlineGroup` +
                // `.sidebar` has a framework bug — when the list reconciles
                // while a folder is expanded, `OutlineListCoordinator`
                // animates a row collapse through `_NSOutlineViewAnimator`
                // and asserts (`ViewListTree.visitItem` → SIGTRAP). This
                // fires on EVERY reconcile, and the git-status badges
                // (dirtyStatus) re-render the rows on every turn + a 15s
                // poll — so a long session reliably hits it. Disabling
                // animations on the list subtree means updates reload
                // instantly instead of through the crashing animator. The
                // tree has no animation worth keeping (selection + badges
                // are instant anyway), so this is pure crash-avoidance.
                .transaction { $0.disablesAnimations = true }
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

    // MARK: - Mutation helpers (Phase 5c)

    /// Resolve the directory the user wants a new entry created
    /// inside, given a context-menu invocation on `node`. A directory
    /// row creates inside that directory; a file row creates beside
    /// it (in the file's parent dir).
    private func parentDir(for node: FileNode) -> String {
        if node.isDirectory {
            return node.path
        }
        return (node.path as NSString).deletingLastPathComponent
    }

    /// Compute the cwd-relative path of `absolute` against the
    /// project's workDir. The /api/files/write/* endpoints accept
    /// paths in either shape but normalising to cwd-relative is what
    /// the existing web client emits, so we mirror that.
    private func relativePath(_ absolute: String, in cwd: String) -> String {
        let cwdSlash = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if absolute.hasPrefix(cwdSlash) {
            return String(absolute.dropFirst(cwdSlash.count))
        }
        return absolute
    }

    private func performCreate(parent: String, kind: NewEntryContext.Kind, name: String) async {
        guard let cwd = bridge.projectWorkDir else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let target = (parent as NSString).appendingPathComponent(trimmed)
        let relTarget = relativePath(target, in: cwd)
        do {
            let outcome = try await FilesService.shared.createFile(
                cwd: cwd,
                path: relTarget,
                kind: kind == .dir ? "dir" : "file"
            )
            switch outcome {
            case .ok:
                newEntryContext = nil
                mutationError = nil
                model.refresh(cwd: cwd, force: true)
            case .needsConfirm(_, let reason, _):
                mutationError = "Refused: \(reason). Use the WebView to confirm."
            }
        } catch {
            mutationError = "\(error)"
        }
    }

    private func performRename(node: FileNode, newName: String) async {
        guard let cwd = bridge.projectWorkDir else { return }
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != node.name else {
            renameContext = nil
            return
        }
        let parent = (node.path as NSString).deletingLastPathComponent
        let toAbs = (parent as NSString).appendingPathComponent(trimmed)
        let fromRel = relativePath(node.path, in: cwd)
        let toRel = relativePath(toAbs, in: cwd)
        do {
            let outcome = try await FilesService.shared.renameFile(
                cwd: cwd,
                from: fromRel,
                to: toRel
            )
            switch outcome {
            case .ok:
                renameContext = nil
                mutationError = nil
                // If we just renamed the open file, retarget the
                // viewer at its new path so it doesn't 404 the next
                // tick. Selection state in the model also moves so
                // the row highlight stays on the renamed file.
                bridge.renameOpenFile(from: node.path, to: toAbs)
                if model.selectedPath == node.path {
                    model.selectedPath = toAbs
                }
                model.refresh(cwd: cwd, force: true)
            case .needsConfirm(_, let reason, _):
                mutationError = "Refused: \(reason)"
            }
        } catch {
            mutationError = "\(error)"
        }
    }

    private func performTrash(node: FileNode) async {
        guard let cwd = bridge.projectWorkDir else { return }
        do {
            let outcome = try await FilesService.shared.deleteFiles(
                cwd: cwd,
                paths: [node.path],
                mode: "trash"
            )
            switch outcome {
            case .ok:
                trashContext = nil
                mutationError = nil
                bridge.closeFile(node.path)
                if model.selectedPath == node.path {
                    model.selectedPath = nil
                }
                model.refresh(cwd: cwd, force: true)
            case .needsConfirm(_, let reason, _):
                mutationError = "Refused: \(reason)"
            }
        } catch {
            mutationError = "\(error)"
        }
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
    /// Phase 5c — file ops surfaced via the row's context menu.
    /// Closures hoist the action up to FileTreeView, which owns the
    /// dialog state + the FilesService calls. Keeps row stateless.
    let onNewFile: () -> Void
    let onNewFolder: () -> Void
    let onRename: () -> Void
    let onTrash: () -> Void

    /// Phase 5e — preview-pane support is gated to file types where
    /// "rendered output" makes sense (HTML, SVG, PDF). Other file
    /// types open in the editor as before.
    static func isBrowserPreviewable(path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ["html", "htm", "svg", "pdf"].contains(ext)
    }

    var body: some View {
        // Phase 5d — VS Code-style icons + tint per file kind.
        // Resolution lives in FileTypeIcon; the row only consumes
        // the symbol + colour pair so adding a kind is one place.
        let kind: FileTypeIcon.Kind = node.isDirectory
            ? .directory
            : FileTypeIcon.kind(for: node.path)
        // Git-status badge resolution. For files: look up the row's
        // absolute path in the bridge's dirtyStatus map (populated
        // by BranchService from `git status --porcelain=v1`). For
        // directories: roll up — show a tint dot when any descendant
        // is dirty. The roll-up scan is O(dirtyCount) per directory
        // row; at typical project sizes (a few hundred dirty files
        // at most, a few dozen visible directory rows) it's free.
        let dirty = GitStatusBadge.resolve(for: node, bridge: MarvinBridge.shared)
        return HStack(spacing: 6) {
            Image(systemName: FileTypeIcon.symbol(for: kind))
                .foregroundStyle(FileTypeIcon.color(for: kind))
                .frame(width: 16)
            Text(node.name)
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(rowTextColour(dirty: dirty))
            Spacer(minLength: 0)
            if let dirty = dirty {
                Text(dirty.label)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(isSelected ? Color.white : dirty.colour)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(
                        RoundedRectangle(cornerRadius: 3)
                            .fill(dirty.colour.opacity(isSelected ? 0.0 : 0.15))
                    )
                    .help(dirty.tooltip)
            }
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
        // Phase 5c (ADR-0020) — adds IDE-grade file ops: New File /
        // New Folder (relative to the row), Rename, Move to Trash.
        // The actions hit /api/files/write/{create,rename,delete}
        // through FilesService; FileTreeView owns the dialogs.
        .contextMenu {
            // Create — directories show "in this folder"; files show
            // "next to this file" via parentDir resolution upstream.
            Button("New File…", action: onNewFile)
            Button("New Folder…", action: onNewFolder)
            Divider()
            if !node.isDirectory {
                Button("Quick Look") {
                    QuickLookCoordinator.shared.show(
                        url: URL(fileURLWithPath: node.path)
                    )
                }
                .keyboardShortcut(.space, modifiers: [])
            }
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting(
                    [URL(fileURLWithPath: node.path)]
                )
            }
            // Phase 5e — "Open in Browser" for HTML / SVG / PDF.
            // Loads the file as file:// in the native PreviewPane,
            // matching the IDE convention (VS Code + JetBrains'
            // built-in browser preview).
            if !node.isDirectory && Self.isBrowserPreviewable(path: node.path) {
                Button("Open in Browser") {
                    MarvinBridge.shared.openInPreview(
                        url: "file://\(node.path)"
                    )
                }
            }
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.path, forType: .string)
            }
            Button("Copy Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.name, forType: .string)
            }
            Divider()
            Button("Rename…", action: onRename)
                .keyboardShortcut(.return, modifiers: [])
            Button("Move to Trash", role: .destructive, action: onTrash)
                .keyboardShortcut(.delete, modifiers: [.command])
        }
        .accessibilityIdentifier("file-tree-row:\(node.path)")
    }

    /// Tint the row's filename when the file is dirty. Selected rows
    /// always read on white (the accent fill below the row already
    /// carries the selection signal). Unselected dirty rows borrow
    /// the badge colour at slightly muted alpha so the user can see
    /// at a glance which files were touched without scanning the
    /// badge column. Untouched rows fall back to the system primary
    /// foreground so the file tree stays calm by default.
    private func rowTextColour(dirty: GitStatusBadge?) -> AnyShapeStyle {
        if isSelected { return AnyShapeStyle(Color.white) }
        guard let dirty = dirty else { return AnyShapeStyle(.primary) }
        return AnyShapeStyle(dirty.colour.opacity(0.95))
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
        let kids = children ?? []
        // CRASH FIX — SwiftUI's `OutlineGroup` / `List(children:)` traps
        // (EXC_BREAKPOINT in `OutlineListCoordinator.recursivelyDiffRows` →
        // `collapseItem` → `_assertionFailure`) when this keypath returns a
        // NON-NIL EMPTY array: an "expandable but empty" directory. The
        // coordinator expects nil (leaf) or a NON-EMPTY array. An agent
        // mutating files mid-session (a dir emptied/created, then a tree
        // re-fetch) flips a node into the `[]` shape, and the next row diff
        // crashes the whole app. Collapse an empty directory to a LEAF (no
        // disclosure triangle — it simply doesn't expand into nothing); the
        // folder icon still comes from `isDirectory`, so it reads correctly.
        guard !kids.isEmpty else { return nil }
        // Defensive: OutlineGroup requires IDs unique across the WHOLE tree
        // and asserts (crash) on a duplicate. `id` is the absolute path, so
        // a symlink loop or a case-folding collision could produce dupes —
        // dedupe siblings by path so a bad tree degrades gracefully instead
        // of taking down the outline. No-op for well-formed trees.
        guard kids.count > 1 else { return kids }
        var seen = Set<String>()
        return kids.filter { seen.insert($0.path).inserted }
    }
}

// MARK: - File mutation dialogs (Phase 5c)

/// Backing state for the "New File" / "New Folder" sheet. The
/// `parentDir` is the absolute path the new entry will be created
/// inside (project root from header buttons; the directory itself
/// or the file's parent when invoked from a row). Identifiable so
/// SwiftUI's `.sheet(item:)` re-presents on each invocation.
struct NewEntryContext: Identifiable {
    enum Kind { case file, dir }
    let id = UUID()
    let parentDir: String
    let kind: Kind
}

/// Backing state for the "Rename" sheet — captures the node being
/// renamed so the sheet can pre-fill the field with the current name
/// and the action handler knows which path to send to the rename
/// endpoint.
struct RenameContext: Identifiable {
    let id = UUID()
    let node: FileNode
}

/// Sheet that asks for a name and creates a new file/directory.
/// Pre-focuses the text field on appear (NSTextField lookup hop) so
/// the user can type immediately. Empty name disables the create
/// button; trimming happens on submit so leading/trailing spaces
/// don't sneak into filenames.
private struct NewEntrySheet: View {
    let context: NewEntryContext
    let onCreate: (String) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @FocusState private var nameFocused: Bool

    private var isFolder: Bool { context.kind == .dir }
    private var title: String { isFolder ? "New Folder" : "New File" }
    private var placeholder: String {
        isFolder ? "untitled folder" : "untitled.swift"
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
            Text("In \((context.parentDir as NSString).lastPathComponent)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            TextField(placeholder, text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($nameFocused)
                .onSubmit {
                    if !trimmedName.isEmpty {
                        onCreate(trimmedName)
                    }
                }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Create") { onCreate(trimmedName) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmedName.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 360)
        .onAppear { nameFocused = true }
    }
}

/// Sheet for the "Rename" action. Pre-fills with the current name
/// and pre-selects the basename (without extension) for files so the
/// user can type a new name without manually clearing the extension —
/// matches Finder's rename behaviour.
private struct RenameSheet: View {
    let context: RenameContext
    let onRename: (String) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @FocusState private var nameFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename \(context.node.isDirectory ? "Folder" : "File")")
                .font(.headline)
            Text(context.node.path)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            TextField("name", text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($nameFocused)
                .onSubmit {
                    if !trimmedName.isEmpty, trimmedName != context.node.name {
                        onRename(trimmedName)
                    }
                }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Rename") { onRename(trimmedName) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmedName.isEmpty || trimmedName == context.node.name)
            }
        }
        .padding(20)
        .frame(width: 380)
        .onAppear {
            name = context.node.name
            nameFocused = true
        }
    }
}

// FileTreeView — Phase 3b dev surface for the native file tree.
//
// A separate Window scene rendering the active project's
// `/api/files/tree` response as a flat, self-indented list. The main
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
// ## Why a flat list, not OutlineGroup (2026-08-06)
//
// ADR-0018 §5 deferred the OutlineGroup-vs-NSOutlineView call pending a
// measurement on a real repo. Four app-killing crashes settled it before the
// perf question ever came up: `List` + `OutlineGroup` drives NSOutlineView
// through SwiftUI's `OutlineListCoordinator`, which traps whenever its
// lazily-loaded row entries disagree with the SwiftUI view list — and a tree
// that an agent mutates under a 15s refresh poll keeps finding new ways to
// disagree. The tree is now flattened by `flattenFileTree` (MARVINLogic) and
// rendered with a plain `List` + `ForEach`; expansion state is a `Set<String>`
// this view owns. See `MARVINLogic/FileTree.swift` for the crash history.

import MARVINLogic
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
                // Sanitise to a whole-tree-path-unique shape (ADR-0056): a
                // duplicate path would render the same file twice, and since
                // expansion is path-keyed, toggling one would toggle both.
                // No-op for well-formed trees.
                response = res.treeWideUnique()
                loadedCwd = cwd
            } catch {
                // A cancelled request is not a failure: the tree auto-refresh
                // (FSEvents) cancels the in-flight fetch whenever the previous
                // one is still running, and URLSession reports that as
                // URLError(.cancelled) / −999 — not CancellationError, which
                // is why it used to reach the banner.
                guard !BenignCancellation.matches(error) else { return }
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

    /// Expanded directories, keyed by ABSOLUTE PATH (not row id, which also
    /// encodes branch-ness — a folder that gains or loses its last child would
    /// otherwise snap shut). Ours to own now that the tree renders flat; this
    /// is the state `OutlineGroup` used to keep, unreachably, inside AppKit.
    /// Starts empty: roots collapsed, matching the previous behaviour.
    @State private var expanded: Set<String> = []

    // Phase 5c (ADR-0020) — file mutation dialog state. The IDE-feel
    // context-menu actions (New File / New Folder / Rename / Move to
    // Trash) drive a small set of sheets + alerts here. We keep the
    // state hoisted on FileTreeView (rather than per-row) so row
    // identity stays stable when a sheet opens.

    /// Backing state for the "New file" / "New folder" sheet.
    @State private var newEntryContext: NewEntryContext? = nil
    /// Backing state for the "Rename" sheet.
    @State private var renameContext: RenameContext? = nil
    /// Backing state for the "Move to Trash" confirm alert.
    @State private var trashContext: FileNode? = nil
    /// Surface mutation errors (HTTP 4xx/5xx, transport) inline.
    @State private var mutationError: String? = nil
    /// FSEvents watcher on the active project (see FileSystemWatcher). Held
    /// here so its lifetime matches the view's, and torn down on project
    /// switch — a watcher left on the previous project would refetch a tree
    /// nobody is looking at.
    @State private var watcher: FileSystemWatcher? = nil
    /// Coalesces the watcher's callbacks. FSEvents already batches at the
    /// kernel, but a `git checkout` or an agent's multi-file edit still
    /// arrives as several callbacks; without this each one is a whole-tree
    /// refetch.
    @State private var refreshDebounce: Task<Void, Never>? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            MarvinDivider()
            content
            if let err = model.lastError {
                MarvinDivider()
                errorBanner(err)
            }
            if let err = mutationError {
                MarvinDivider()
                errorBanner("Mutation: \(err)")
            }
        }
        // "New Text File" from the File menu. The naming sheet and the
        // create flow both live here, so the menu command posts rather than
        // growing a second copy of them.
        .onReceive(NotificationCenter.default.publisher(for: .marvinRequestNewFile)) { _ in
            guard let root = MarvinBridge.shared.projectWorkDir, !root.isEmpty else { return }
            newEntryContext = NewEntryContext(parentDir: root, kind: .file)
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
        .onAppear {
            syncFetchFromBridge()
            startWatching()
        }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            syncFetchFromBridge()
            startWatching()
        }
        .onDisappear {
            refreshDebounce?.cancel()
            watcher?.stop()
            watcher = nil
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
    /// chevron (`toggleExpanded`); we just suppress the no-op
    /// dispatch here. Selection state still updates so the user
    /// sees the row highlight regardless.
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

    /// Visible rows for the current tree + expansion state.
    ///
    /// Recomputed per render rather than cached: it's a linear walk over the
    /// EXPANDED subtree only (collapsed directories cost one row, not their
    /// subtree), so a large project with a few folders open is a few hundred
    /// rows. A cache here would have to be invalidated on every refresh poll,
    /// every git-status change, and every toggle — which is the staleness the
    /// outline coordinator crashed over.
    private func rows(of tree: [FileNode]) -> [FileTreeDisplayRow] {
        flattenFileTree(tree, expanded: expanded)
    }

    /// Open/close a directory. Path-keyed, so the state survives the node
    /// changing shape (or disappearing and coming back) between refreshes.
    private func toggleExpanded(_ node: FileNode) {
        if expanded.contains(node.path) {
            expanded.remove(node.path)
        } else {
            expanded.insert(node.path)
        }
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

    /// Watch the active project so an agent's file changes reach the tree
    /// without a manual refresh. Idempotent: re-called on every project
    /// switch, and always replaces the previous watcher.
    private func startWatching() {
        refreshDebounce?.cancel()
        watcher?.stop()
        watcher = nil
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty else { return }
        let w = FileSystemWatcher(path: cwd) {
            scheduleWatchedRefresh(cwd: cwd)
        }
        w.start()
        watcher = w
    }

    /// Debounced whole-tree refetch. `force: true` because the model's
    /// short-circuit ("same cwd, already loaded → do nothing") is exactly what
    /// makes a manual refresh necessary in the first place.
    private func scheduleWatchedRefresh(cwd: String) {
        refreshDebounce?.cancel()
        refreshDebounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            // The project may have changed while the debounce was pending.
            guard bridge.projectWorkDir == cwd else { return }
            model.refresh(cwd: cwd, force: true)
        }
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
        .frame(height: MarvinTheme.paneHeaderHeight)
    }

    @ViewBuilder
    private var content: some View {
        if bridge.projectWorkDir == nil {
            placeholder("(no project active)")
        } else if let response = model.response {
            if response.tree.isEmpty {
                placeholder("(empty tree)")
            } else {
                // FLAT list — deliberately NOT `List` + `OutlineGroup`.
                //
                // The outline path crashed the app four times (duplicate ids,
                // a non-nil empty children array, whole-tree id collisions,
                // a branch→leaf flip under a stable id). Each fix removed one
                // way for SwiftUI's `OutlineListCoordinator` to disagree with
                // NSOutlineView's lazily-loaded row entries; none removed the
                // disagreement itself, because that state isn't ours to keep
                // consistent while an agent mutates files under a 15s refresh
                // poll. `flattenFileTree` (MARVINLogic) turns the tree into a
                // plain row array we diff ourselves, so there is no outline
                // coordinator and the whole failure mode is gone. See
                // `MARVINLogic/FileTree.swift` for the full history.
                //
                // Indentation and disclosure are now ours: the row draws its
                // own chevron and leading pad from `depth`. `.listStyle(.sidebar)`
                // still supplies the native sidebar chrome. The row owns its
                // selection highlight, so List's row background + separators
                // stay suppressed to avoid double-stacking.
                // Plain stack, not `List(.sidebar)`: the sidebar list style
                // pads every row to ~28-32pt no matter what the row frame
                // says (defaultMinListRowHeight only sets a floor), which is
                // why the tree still fit far fewer entries than VS Code /
                // Antigravity. A LazyVStack gives exact 22pt rows.
                ScrollView {
                  LazyVStack(spacing: 0) {
                    ForEach(rows(of: response.tree)) { row in
                        FileTreeRow(
                            node: row.node,
                            depth: row.depth,
                            isExpandable: row.isExpandable,
                            isExpanded: row.isExpanded,
                            isSelected: model.selectedPath == row.node.path,
                            onToggle: { toggleExpanded(row.node) },
                            onTap: { selectRow(row.node) },
                            onNewFile: {
                                newEntryContext = NewEntryContext(
                                    parentDir: parentDir(for: row.node),
                                    kind: .file
                                )
                            },
                            onNewFolder: {
                                newEntryContext = NewEntryContext(
                                    parentDir: parentDir(for: row.node),
                                    kind: .dir
                                )
                            },
                            onRename: {
                                renameContext = RenameContext(node: row.node)
                            },
                            onTrash: { trashContext = row.node }
                        )
                        .padding(.horizontal, 4)
                    }
                  }
                  .padding(.vertical, 4)
                }
                .background(MarvinTheme.background)
                // The tree has no animation worth keeping — selection and the
                // git-status badges are instant — and a re-render fires on
                // every turn plus a 15s poll, so animating row insertion just
                // makes a refresh flicker.
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

    /// Only reachable when the user has SET `MARVIN_TREE_MAX_ENTRIES`.
    ///
    /// The walker had a 20,000 default until 2026-09-01, and every time it
    /// fired the cause was machine-generated bulk MARVIN had written into the
    /// project — graphify's cache, its Obsidian export, then `.marvin/worktrees/`
    /// (full checkouts of the repo, inside the repo). The banner told the user
    /// to raise a number when the truth was that their source tree was fine and
    /// something else was eating the budget. The default is now unlimited, so
    /// this only appears for a ceiling someone chose — hence the wording change:
    /// it names the variable as THEIRS, not as a limit to discover.
    private func truncatedBanner(count: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Tree truncated")
                    .font(.caption.weight(.semibold))
                Text("\(count) entries shown — your MARVIN_TREE_MAX_ENTRIES limit. Unset it for the full tree.")
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
    /// Nesting level. `OutlineGroup` used to supply indentation implicitly;
    /// with a flat list the row draws its own leading pad from this.
    let depth: Int
    /// Whether to draw a disclosure chevron at all (false for files and for
    /// empty directories, which would expand into nothing).
    let isExpandable: Bool
    let isExpanded: Bool
    let isSelected: Bool
    /// Open/close this directory. Separate from `onTap` so clicking the
    /// chevron never changes the selection, matching Finder and Xcode.
    let onToggle: () -> Void
    let onTap: () -> Void

    /// Points of indent per nesting level — VS Code's `workbench.tree.indent`
    /// default (8px), so nesting reads exactly like the Antigravity reference.
    // Tree density. VS Code / Antigravity nominally run 22px rows with 13px
    // text and 16px icons; the user read that as "way smaller than
    // Antigravity" side by side (2026-08-29), so MARVIN sits one notch above
    // the reference. Kept as named constants because they move together — a
    // row shorter than the icon clips it.
    static let rowHeight: CGFloat = 24
    static let textSize: CGFloat = 14
    /// Drawn size of the glyph. Symbols' SVGs are 24×24 with ~3px of built-in
    /// padding, so they need a slightly larger box than a full-bleed icon to
    /// land at the same optical weight.
    static let iconSize: CGFloat = 19
    /// Column the glyph is centred in — fixed so names line up regardless of
    /// glyph aspect.
    static let iconSlot: CGFloat = 19

    private static let indentStep: CGFloat = 8
    /// Width reserved for the chevron column (VS Code's twistie is 16px).
    /// Reserved even for leaves, so files line up with their sibling folders'
    /// labels instead of shifting left into the triangle's slot.
    private static let chevronWidth: CGFloat = 16
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
            // Indent + disclosure. The chevron is a plain tappable glyph
            // rather than a Button so it inherits the row's flat styling and
            // doesn't steal the row's hit region beyond its own frame.
            Color.clear
                .frame(width: CGFloat(depth) * Self.indentStep, height: 1)
            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(isSelected ? MarvinTheme.textPrimary : MarvinTheme.textMuted)
                .frame(width: Self.chevronWidth)
                .opacity(isExpandable ? 1 : 0)
                .contentShape(Rectangle())
                .onTapGesture { if isExpandable { onToggle() } }
                .allowsHitTesting(isExpandable)
            // Symbols icon theme — the one Antigravity actually bundles and
            // defaults to (see SymbolsIcon.swift). Colours are baked into each
            // SVG, and the git decoration deliberately does NOT tint the icon:
            // a folder like `apps` or `db` reads red / pink in the reference
            // because Symbols gives it its own glyph, not because it's dirty.
            // The decoration lives on the NAME and the trailing dot, same as
            // the reference. SF Symbols remain the fallback for a glyph the
            // bundle is missing.
            if let glyph = SymbolsIcon.image(
                forPath: node.path, isDirectory: node.isDirectory, size: Self.iconSize
            ) {
                // No `.resizable()`: the bitmap already IS `iconSize`, and
                // resizable re-samples it on every layout pass.
                Image(nsImage: glyph)
                    .frame(width: Self.iconSlot)
            } else if node.isDirectory {
                Image(systemName: "folder")
                    .font(.system(size: Self.textSize))
                    .foregroundStyle(dirty?.colour ?? Color(white: 0.72))
                    .frame(width: Self.iconSlot)
            } else {
                Image(systemName: FileTypeIcon.symbol(for: kind))
                    .font(.system(size: Self.textSize))
                    .foregroundStyle(FileTypeIcon.color(for: kind))
                    .frame(width: Self.iconSlot)
            }
            Text(node.name)
                .font(.system(size: Self.textSize))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(rowTextColour(dirty: dirty))
            Spacer(minLength: 0)
            if let dirty = dirty {
                // VS Code shape: a soft dot for a directory roll-up, a bare
                // letter for a file — no boxed badge.
                Group {
                    if case .directoryRollup = dirty {
                        Circle()
                            .fill(dirty.colour.opacity(0.85))
                            .frame(width: 6, height: 6)
                    } else {
                        Text(dirty.label)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(dirty.colour)
                    }
                }
                    .padding(.trailing, 4)
                    .help(dirty.tooltip)
            }
        }
        .frame(height: Self.rowHeight)
        .padding(.horizontal, 4)
        // A deeply-indented row in a narrow pane can't fit; clip it rather
        // than let the HStack overflow and paint outside the pane.
        .clipped()
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(isSelected ? MarvinTheme.rowSelected : .clear)
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
            // Open With — the applications macOS itself says can handle
            // this file, in its own preference order. Built from
            // `urlsForApplications(toOpen:)` rather than a hardcoded list,
            // so it is right on any machine and needs no maintenance.
            if !node.isDirectory {
                let apps = NSWorkspace.shared.urlsForApplications(
                    toOpen: URL(fileURLWithPath: node.path)
                )
                if !apps.isEmpty {
                    Menu("Open With") {
                        ForEach(apps, id: \.self) { app in
                            Button(
                                FileManager.default.displayName(atPath: app.path)
                            ) {
                                NSWorkspace.shared.open(
                                    [URL(fileURLWithPath: node.path)],
                                    withApplicationAt: app,
                                    configuration: NSWorkspace.OpenConfiguration()
                                )
                            }
                        }
                    }
                }
            }
            // Open in Integrated Terminal — MARVIN's own terminal, not
            // Terminal.app (that is what "Open Terminal Here" in the File
            // menu does). A file opens its containing directory, which is
            // what every IDE does and what the user means by it.
            Button("Open in Integrated Terminal") {
                let dir = node.isDirectory
                    ? node.path
                    : (node.path as NSString).deletingLastPathComponent
                guard let workDir = MarvinBridge.shared.projectWorkDir, !workDir.isEmpty
                else { return }
                NativePrefs.shared.revealPane(.terminal)
                TerminalSessionStore.shared.session(for: workDir)
                    .run(command: "cd \(RunFileCommand.shellQuoted(dir))")
            }
            Divider()
            Button("Copy") {
                // The file itself, not its path — so a paste in Finder or
                // any other app copies the file. `Copy Path` below is the
                // string version, and both are worth having: they are what
                // two different pastes expect.
                NSPasteboard.general.clearContents()
                NSPasteboard.general.writeObjects(
                    [URL(fileURLWithPath: node.path) as NSURL]
                )
            }
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.path, forType: .string)
            }
            // The form people actually paste into a message, an issue or a
            // commit — and the one that means the same thing on someone
            // else's machine.
            if let root = MarvinBridge.shared.projectWorkDir,
               let rel = WorkspaceRelativePath.of(node.path, in: root), !rel.isEmpty {
                Button("Copy Relative Path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(rel, forType: .string)
                }
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
        if isSelected { return AnyShapeStyle(MarvinTheme.textPrimary) }
        guard let dirty = dirty else { return AnyShapeStyle(MarvinTheme.textPrimary) }
        return AnyShapeStyle(dirty.colour)
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

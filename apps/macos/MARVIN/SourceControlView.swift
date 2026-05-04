// SourceControlView — Phase 3e. Native equivalent of the web
// `<SourceControlPanel>` (apps/web/src/components/source-control/
// source-control-panel.tsx).
//
// Read-only in 3e per ADR-0018 §3 — clicking a row does nothing yet.
// 3f wires the diff viewer; 3g adds stage / unstage / commit. We
// land the read-only surface first so the daily-driver experience
// recovers from the 3d→3e gap (where the user lost web SCM access
// when the file-tree panel got hidden).
//
// ## Section model
//
// Porcelain v2 entries land in three buckets per the web parity:
//
//   • Staged (`indexStatus != "."` AND ordinary/rename-copy)
//   • Changes (`workingStatus != "."` AND ordinary/rename-copy)
//   • Untracked (entryType = "untracked")
//
// Conflicted files (entryType = "unmerged") get their own fourth
// section when present — matches Xcode's source-control behaviour
// of surfacing conflicts above everything else.
//
// ## Why this lives next to FileTreeView
//
// The web app puts both surfaces under one column behind a tab
// switch (LeftColumnTabs). Native does the same — a Picker at the
// top of the left pane swaps the body between FileTreeView and
// SourceControlView. ContentView's HSplitView treats the whole
// pane as one unit; the Picker just flips which body renders.

import SwiftUI

/// View-model for the SCM panel. Owns the in-flight fetch state +
/// the rendered status. Mirrors FileTreeModel's idempotence: the
/// view's bridge-change observer can fire repeatedly without re-
/// fetching when the cwd hasn't changed.
@MainActor
@Observable
final class SourceControlModel {
    /// Last successful response. Nil until first fetch completes.
    private(set) var response: GitStatusResponse? = nil
    private(set) var isLoading: Bool = false
    private(set) var lastError: String? = nil
    private(set) var loadedCwd: String? = nil

    private var fetchTask: Task<Void, Never>?

    /// Kick off a fetch for `cwd`. Idempotent: re-calls with the
    /// most-recently loaded cwd are no-ops unless `force: true`.
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
                let res = try await FilesService.shared.fetchGitStatus(cwd: cwd)
                guard !Task.isCancelled else { return }
                response = res
                loadedCwd = cwd
            } catch is CancellationError {
                /* racing with a project switch — quiet */
            } catch {
                lastError = "\(error)"
            }
        }
    }

    func clear() {
        fetchTask?.cancel()
        fetchTask = nil
        response = nil
        loadedCwd = nil
        lastError = nil
        isLoading = false
    }

    // MARK: - Section partitioning

    /// Conflicted files first — matches Xcode's "fix this before
    /// anything else" surface. Phase 3e renders these in their own
    /// section header when non-empty.
    var conflicted: [GitStatusFile] {
        response?.files?.filter { $0.entryType == "unmerged" } ?? []
    }

    /// Staged changes — index column non-".". Excludes unmerged
    /// (those carry both columns set, but live in their own section
    /// so users don't try to commit a conflict).
    var staged: [GitStatusFile] {
        response?.files?.filter {
            $0.entryType != "unmerged" && $0.indexStatus != "."
        } ?? []
    }

    /// Working-tree changes — working column non-".". Same exclusion
    /// for unmerged entries. A file modified-on-disk after a partial
    /// staging shows up in BOTH `staged` and `changes` (the index has
    /// one snapshot, the worktree another) — that's the correct
    /// rendering, matching `git status` two-column output.
    var changes: [GitStatusFile] {
        response?.files?.filter {
            $0.entryType != "unmerged"
                && $0.entryType != "untracked"
                && $0.workingStatus != "."
        } ?? []
    }

    var untracked: [GitStatusFile] {
        response?.files?.filter { $0.entryType == "untracked" } ?? []
    }
}

/// SCM panel view. Layout:
///
///   ┌──────────────────────────────────┐
///   │ projectName · branch ●           │
///   │ ↑2 ↓0                            │
///   ├──────────────────────────────────┤
///   │ ▾ Conflicted (1)                 │
///   │   ▫ packages/ui/foo.ts           │
///   │ ▾ Staged (3)                     │
///   │   ▫ M  apps/web/page.tsx         │
///   │ ▾ Changes (5)                    │
///   │   ▫ M  apps/macos/...            │
///   │ ▾ Untracked (2)                  │
///   │   ▫ ?  notes.txt                 │
///   ├──────────────────────────────────┤
///   │ ⚠ error banner (if any)          │
///   └──────────────────────────────────┘
struct SourceControlView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = SourceControlModel()
    /// Phase 3f — diff-sheet model. Set via row tap; the .sheet
    /// modifier presents it and clears via Binding when dismissed.
    @State private var diffSheet: DiffSheetModel? = nil

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
        .frame(minWidth: 200)
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFetchFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            syncFetchFromBridge()
        }
        // Refresh whenever the bridge reports a turn finished —
        // tool-driven file mutations land in working-tree status the
        // moment the assistant message that performed them returns.
        // Phase 1d.20's `busy-changed` flips false on idle; we re-
        // fetch then. The web side does the same via `fsRefreshTick`.
        .onChange(of: bridge.isBusy) { wasBusy, isBusy in
            if wasBusy, !isBusy, let cwd = bridge.projectWorkDir {
                model.refresh(cwd: cwd, force: true)
            }
        }
        // Phase 3f — present the diff sheet when a row is tapped.
        // Bound via a custom Binding so dismissal (Esc / Done /
        // backdrop click) clears the model. .sheet(item:) requires
        // an Identifiable item but DiffSheetModel is a class; wrap
        // in a thin id'd container instead.
        .sheet(item: Binding(
            get: { diffSheet.map(DiffSheetItem.init) },
            set: { newValue in if newValue == nil { diffSheet = nil } }
        )) { item in
            DiffSheet(model: item.model, onDismiss: { diffSheet = nil })
        }
    }

    private func syncFetchFromBridge() {
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty else {
            model.clear()
            return
        }
        model.refresh(cwd: cwd)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
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
                .help("Refresh git status.")
            }
            branchLine
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var branchLine: some View {
        if let branch = model.response?.branch {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(.secondary)
                    .imageScale(.small)
                Text(branch.name ?? "(detached)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let upstream = branch.upstream, !upstream.isEmpty {
                    Text("→ \(upstream)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer()
                if let ahead = branch.ahead, ahead > 0 {
                    Label("\(ahead)", systemImage: "arrow.up")
                        .font(.caption.monospaced())
                        .foregroundStyle(.green)
                        .labelStyle(.titleAndIcon)
                }
                if let behind = branch.behind, behind > 0 {
                    Label("\(behind)", systemImage: "arrow.down")
                        .font(.caption.monospaced())
                        .foregroundStyle(.orange)
                        .labelStyle(.titleAndIcon)
                }
            }
        } else {
            Text(" ").font(.caption.monospaced())
        }
    }

    @ViewBuilder
    private var content: some View {
        if bridge.projectWorkDir == nil {
            placeholder("(no project active)")
        } else if let response = model.response {
            if response.enabled == false {
                placeholder(response.reason == "not-a-git-repo"
                    ? "(not a git repository)"
                    : "(git unavailable)")
            } else if let error = response.error, !error.isEmpty {
                placeholder("git error: \(error)")
            } else if isClean {
                placeholder("(working tree clean)")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        section("Conflicted", files: model.conflicted)
                        section("Staged", files: model.staged)
                        section("Changes", files: model.changes)
                        section("Untracked", files: model.untracked)
                    }
                    .padding(.vertical, 6)
                }
            }
        } else if model.isLoading {
            placeholder("Loading…")
        } else {
            placeholder("(initialising)")
        }
    }

    private var isClean: Bool {
        model.conflicted.isEmpty
            && model.staged.isEmpty
            && model.changes.isEmpty
            && model.untracked.isEmpty
    }

    @ViewBuilder
    private func section(_ label: String, files: [GitStatusFile]) -> some View {
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(label) (\(files.count))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                ForEach(files, id: \.path) { file in
                    SourceControlRow(
                        file: file,
                        cwd: bridge.projectWorkDir ?? "",
                        onTap: { openDiff(for: file) }
                    )
                    .padding(.horizontal, 8)
                }
            }
        }
    }

    /// Phase 3f — open a diff sheet for one SCM row. The repo-
    /// relative path is computed inside the row helper; the route's
    /// isSafePathspec gate rejects absolute paths so we MUST strip
    /// the cwd prefix here. `initialMode` picks Staged for staged-
    /// only changes, Working for everything else.
    private func openDiff(for file: GitStatusFile) {
        guard let cwd = bridge.projectWorkDir, !cwd.isEmpty else { return }
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        let relative = file.path.hasPrefix(root)
            ? String(file.path.dropFirst(root.count))
            : file.path
        let initial = DiffMode(rawValue: DiffSheet.initialMode(for: file)) ?? .working
        diffSheet = DiffSheetModel(
            cwd: cwd,
            relativePath: relative,
            initialMode: initial
        )
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

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Status fetch error")
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

/// Identifiable wrapper for the diff-sheet model. SwiftUI's
/// .sheet(item:) needs the item to be Identifiable; the model
/// itself is a @MainActor class so we can't read its fields from
/// the nonisolated `id` accessor. Capture the (cwd, path) at
/// construction — those are immutable on the model anyway, and
/// they're enough to identify a sheet for re-mount avoidance.
struct DiffSheetItem: Identifiable {
    let model: DiffSheetModel
    let id: String

    init(model: DiffSheetModel) {
        self.model = model
        self.id = "\(model.cwd):\(model.relativePath)"
    }
}

/// One row in the SCM list. Phase 3f wires the row tap to open
/// DiffSheet. 3g will add per-row stage / unstage actions.
private struct SourceControlRow: View {
    let file: GitStatusFile
    /// Active project's working directory. We strip it from the
    /// per-file absolute path to produce a repo-relative label —
    /// matches what the web SCM panel shows.
    let cwd: String
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(statusBadge)
                .font(.system(size: 11, weight: .semibold).monospaced())
                .foregroundStyle(badgeColor)
                .frame(width: 26, alignment: .leading)
            Text(displayPath)
                .font(.system(size: 12).monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
            if file.entryType == "rename-copy", let from = file.renamedFrom {
                Text("← \(displayRelative(from))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .accessibilityIdentifier("scm-row:\(file.path)")
    }

    /// Two-letter status display: index + working columns. Matches
    /// `git status -s` output. "??" for untracked, "UU" for both-
    /// modified merge conflict, "M " for staged-only, " M" for
    /// unstaged-only modification. Spaces are visible.
    private var statusBadge: String {
        if file.entryType == "untracked" { return "??" }
        return "\(file.indexStatus)\(file.workingStatus)"
    }

    /// Colour per status — green for staged, orange for working-
    /// tree, red for conflicts, gray for untracked. The web side
    /// uses the same palette so users switching between surfaces
    /// don't have to remap.
    private var badgeColor: Color {
        switch file.entryType {
        case "unmerged": return .red
        case "untracked": return .secondary
        default: break
        }
        if file.indexStatus != "." { return .green }
        return .orange
    }

    private var displayPath: String {
        displayRelative(file.path)
    }

    /// Trim the repo root from an absolute path; falls through to
    /// the basename if cwd doesn't prefix-match (rare; defensive).
    private func displayRelative(_ path: String) -> String {
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if path.hasPrefix(root) {
            return String(path.dropFirst(root.count))
        }
        return path
    }
}

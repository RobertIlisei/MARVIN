// SourceControlView — the Source Control panel.
//
// Rebuilt to the VS Code / Antigravity shape. The previous cut showed
// porcelain-v2 two-column codes on the left of every row and pinned a
// commit box to the bottom with a plain Commit button; the branch
// routes that had shipped with ADR-0012 M2 had no caller at all, so
// nothing in the app could switch, create or delete a branch.
//
// ## Layout
//
//   Source Control                                     [ … ]
//   ── Changes ──────────────────────────────────────────────
//    ▾ repo-name   branch ▾              ⟳  ✓  ↻  …
//      ┌ Message (⌘Enter to commit on "branch")   ✨ Generate ┐
//      [ ✓ Commit                                          ▾ ]
//      ▾ Staged Changes                                    (3)
//      ▾ Changes                                         (477)
//    ▸ other-worktree   branch                          (12)
//   ── Graph ────────────────────────────────────── ↓ ↑ ⟳ ──
//    ●─┐ chore: backlog audit — 8 easy wins   [chore/…]  6c8f907
//
// Three things drive the shape:
//
//   • **Composer on top.** The reference puts it above the file list
//     because the list is unbounded — 477 rows push a bottom-anchored
//     box off screen exactly when you have the most to say about it.
//
//   • **One primary action that changes identity.** With something
//     staged it is `Commit` (+ a split menu for the & Push / & Sync /
//     Amend variants). With nothing staged and a diverged branch it
//     becomes `Sync Changes 10↓ 5↑`. Two buttons where only one is
//     ever live is the thing the reference avoids.
//
//   • **Untracked files live inside Changes**, with a `U` letter
//     rather than in a section of their own — that is what the
//     reference does, and a separate section splits "what did I
//     touch" across two lists for no gain.
//
// Every mutation goes through `GitOpRunner` (confirm-token round trip,
// ADR-0012). Worktrees come from `/api/git/repos`, so an implementer
// subagent's checkout (ADR-0081) shows up as its own group instead of
// being invisible.

import AppKit
import SwiftUI

/// View-model for the SCM panel. Owns the status fetch, the repo list,
/// the stash list, and the commit composer state. Mutations delegate to
/// `runner`.
@MainActor
@Observable
final class SourceControlModel {
    private(set) var response: GitStatusResponse? = nil
    private(set) var isLoading: Bool = false
    private(set) var lastError: String? = nil
    private(set) var loadedCwd: String? = nil

    /// Worktrees of the open repo — the main checkout first.
    private(set) var repos: [GitRepoEntry] = []
    private(set) var stashes: [GitStashEntry] = []
    /// Implementer worktrees (ADR-0103), state derived from git server-side.
    private(set) var worktrees: [WorktreeEntry] = []
    /// Result of the last merge/sweep, shown inline until the next action.
    var worktreeNotice: String? = nil
    private(set) var worktreeBusy: Bool = false

    private var fetchTask: Task<Void, Never>?

    /// Commit message input. Reset to "" after a successful commit.
    /// In-memory only; a draft does not survive a relaunch.
    var commitMessage: String = ""

    /// True while `/api/git/commit-message` is drafting one. The
    /// request spawns a model turn server-side, so it is slow enough
    /// to need its own visible state rather than the generic spinner.
    private(set) var isGenerating = false
    var generateError: String? = nil

    let runner = GitOpRunner()

    init() {
        runner.onDidMutate = { [weak self] in
            guard let self, let cwd = self.loadedCwd else { return }
            self.refresh(cwd: cwd, force: true)
        }
    }

    // MARK: - Reads

    /// Kick off a status fetch for `cwd`. Idempotent unless forced.
    /// The repo, stash and worktree lists ride along — they all change
    /// together (a commit moves status AND the graph; a stash moves status
    /// AND the stash list; merging an implementer branch moves status AND
    /// that branch's state to `merged`), so refreshing them separately
    /// would guarantee one of them is stale on screen.
    func refresh(cwd: String, force: Bool = false) {
        if !force, response != nil, loadedCwd == cwd, !isLoading { return }
        fetchTask?.cancel()
        isLoading = true
        lastError = nil
        fetchTask = Task { @MainActor in
            defer { isLoading = false }
            do {
                async let status = FilesService.shared.fetchGitStatus(cwd: cwd)
                async let repoList = FilesService.shared.fetchRepos(cwd: cwd)
                async let stashList = FilesService.shared.fetchStashes(cwd: cwd)
                async let worktreeList = FilesService.shared.fetchWorktrees(cwd: cwd)
                let res = try await status
                guard !Task.isCancelled else { return }
                response = res
                loadedCwd = cwd
                repos = (try? await repoList)?.repos ?? []
                stashes = (try? await stashList)?.entries ?? []
                worktrees = (try? await worktreeList)?.worktrees ?? []
            } catch is CancellationError {
                /* racing a project switch — quiet */
            } catch {
                lastError = "\(error)"
            }
        }
    }

    /// Merge one implementer branch into the current branch, locally.
    ///
    /// Never pushes. On a pipeline-gated project pushing each branch as its
    /// own MR costs a full CI run each; merging where the implementer was cut
    /// from costs nothing, because those commits ride along in the pipeline
    /// the current branch already runs.
    func mergeWorktree(slug: String) {
        guard let cwd = loadedCwd, !worktreeBusy else { return }
        worktreeBusy = true
        Task { @MainActor in
            defer { worktreeBusy = false }
            do {
                let out = try await FilesService.shared.mergeWorktree(cwd: cwd, slug: slug)
                worktreeNotice = out.message ?? out.error ?? "Merge finished."
            } catch {
                worktreeNotice = "Merge failed: \(error)"
            }
            refresh(cwd: cwd, force: true)
        }
    }

    /// Remove one checkout, keeping its branch — the ADR-0081 semantics.
    func dropWorktree(slug: String) {
        guard let cwd = loadedCwd, !worktreeBusy else { return }
        worktreeBusy = true
        Task { @MainActor in
            defer { worktreeBusy = false }
            do {
                let out = try await FilesService.shared.dropWorktree(cwd: cwd, slug: slug)
                worktreeNotice = out.message ?? out.error ?? "Checkout removed."
            } catch {
                worktreeNotice = "Drop failed: \(error)"
            }
            refresh(cwd: cwd, force: true)
        }
    }

    /// Reclaim empty and merged worktrees. Never touches a `ready` branch or
    /// any checkout holding uncommitted work.
    func sweepWorktrees() {
        guard let cwd = loadedCwd, !worktreeBusy else { return }
        worktreeBusy = true
        Task { @MainActor in
            defer { worktreeBusy = false }
            do {
                let out = try await FilesService.shared.sweepWorktrees(cwd: cwd)
                let swept = out.swept ?? []
                worktreeNotice = swept.isEmpty
                    ? "Nothing to reclaim."
                    : swept.map { "\($0.slug): \($0.reason)" }.joined(separator: "\n")
            } catch {
                worktreeNotice = "Sweep failed: \(error)"
            }
            refresh(cwd: cwd, force: true)
        }
    }

    func clear() {
        fetchTask?.cancel()
        fetchTask = nil
        response = nil
        repos = []
        stashes = []
        worktrees = []
        worktreeNotice = nil
        loadedCwd = nil
        lastError = nil
        isLoading = false
    }

    // MARK: - Section partitioning

    /// Conflicts first — nothing else can be committed until they are
    /// resolved, so they go above everything.
    var conflicted: [GitStatusFile] {
        response?.files?.filter { $0.entryType == "unmerged" } ?? []
    }

    var staged: [GitStatusFile] {
        response?.files?.filter {
            $0.entryType != "unmerged" && $0.indexStatus != "."
        } ?? []
    }

    /// Working-tree changes INCLUDING untracked files, matching the
    /// reference's single "Changes" list. A file that is partly staged
    /// appears in both lists — that is `git status`'s two-column truth,
    /// not a rendering bug.
    var changes: [GitStatusFile] {
        response?.files?.filter {
            $0.entryType != "unmerged"
                && ($0.entryType == "untracked" || $0.workingStatus != ".")
        } ?? []
    }

    var isClean: Bool {
        conflicted.isEmpty && staged.isEmpty && changes.isEmpty
    }

    var branch: GitStatusBranch? { response?.branch }
    var branchName: String { branch?.name ?? "(detached)" }
    var ahead: Int { branch?.ahead ?? 0 }
    var behind: Int { branch?.behind ?? 0 }
    var hasUpstream: Bool { !(branch?.upstream ?? "").isEmpty }
    var isDiverged: Bool { ahead > 0 || behind > 0 }

    // MARK: - Per-path mutations

    func stage(_ paths: [String]) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        runner.run(verb: "stage", key: paths.first ?? "", cwd: cwd) { _ in
            try await FilesService.shared.stage(cwd: cwd, paths: paths)
        }
    }

    func unstage(_ paths: [String]) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        runner.run(verb: "unstage", key: paths.first ?? "", cwd: cwd) { _ in
            try await FilesService.shared.unstage(cwd: cwd, paths: paths)
        }
    }

    func discard(_ paths: [String], mode: String) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        runner.run(verb: "discard", key: paths.first ?? "", cwd: cwd) { token in
            try await FilesService.shared.discard(
                cwd: cwd, paths: paths, mode: mode, confirmToken: token
            )
        }
    }

    // MARK: - Bulk mutations

    /// `.` is the repo-root pathspec. It is what `git add .` means and
    /// it keeps the request one call instead of one per file — on the
    /// 477-file tree in the reference screenshot, per-file staging
    /// would be 477 round trips.
    func stageAll() { stage(["."]) }
    func unstageAll() { unstage(["."]) }

    /// "Discard all changes" is two policy decisions, not one: tracked
    /// files are restorable-ish (confirm warn), untracked ones are
    /// deleted outright (confirm danger). Issue them as separate calls
    /// so the user confirms the permanent half on its own terms.
    func discardAllTracked() { discard(["."], mode: "working") }
    func deleteAllUntracked() { discard(["."], mode: "untracked") }

    // MARK: - Commit

    private var trimmedMessage: String {
        commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canCommit: Bool {
        !trimmedMessage.isEmpty && !staged.isEmpty && !runner.isRunning("commit")
    }

    /// Amend is allowed with an empty box — git keeps the old message.
    var canAmend: Bool {
        !runner.isRunning("commit") && response?.enabled == true
    }

    func commit(amend: Bool = false, then followUp: FollowUp = .none) {
        guard let cwd = loadedCwd else { return }
        let message = trimmedMessage
        guard amend || (!message.isEmpty && !staged.isEmpty) else { return }
        runner.run(
            verb: "commit",
            key: "",
            cwd: cwd,
            body: { token in
                try await FilesService.shared.commit(
                    cwd: cwd, message: message, amend: amend, confirmToken: token
                )
            },
            onSuccess: { [weak self] in
                self?.commitMessage = ""
                switch followUp {
                case .none: break
                case .push: self?.push()
                case .sync: self?.sync()
                }
            }
        )
    }

    /// What runs after a successful commit, for the split-button
    /// variants. Modelled as a value rather than three near-identical
    /// commit methods.
    enum FollowUp { case none, push, sync }

    /// Stage everything, then commit. VS Code's "Commit All".
    func stageAllAndCommit() {
        guard let cwd = loadedCwd else { return }
        let message = trimmedMessage
        guard !message.isEmpty else { return }
        runner.run(
            verb: "stage",
            key: ".",
            cwd: cwd,
            body: { _ in
                try await FilesService.shared.stage(cwd: cwd, paths: ["."])
            },
            onSuccess: { [weak self] in self?.commit() }
        )
    }

    // MARK: - Remote

    func fetchRemote() {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "fetch", cwd: cwd) { _ in
            try await FilesService.shared.fetch(cwd: cwd)
        }
    }

    func pull(strategy: String = "ff-only") {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "pull", cwd: cwd) { token in
            try await FilesService.shared.pull(
                cwd: cwd, strategy: strategy, confirmToken: token
            )
        }
    }

    func push(forceWithLease: Bool = false) {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "push", cwd: cwd) { token in
            try await FilesService.shared.push(
                cwd: cwd, forceWithLease: forceWithLease, confirmToken: token
            )
        }
    }

    /// `git push -u` — the only shape that works for a branch with no
    /// upstream, which is why it is a separate menu entry.
    func publish() {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "publish", cwd: cwd) { token in
            try await FilesService.shared.push(
                cwd: cwd, setUpstream: true, confirmToken: token
            )
        }
    }

    /// Pull then push, IN ORDER and only if the pull succeeded.
    /// Firing both concurrently would push a branch the pull was about
    /// to rebase, which is the exact failure this button exists to
    /// prevent — hence `runRemoteAwaiting` rather than two `runRemote`
    /// calls.
    func sync() {
        guard let cwd = loadedCwd else { return }
        Task { @MainActor in
            let pulled = await runner.runRemoteAwaiting(verb: "pull", cwd: cwd) { token in
                try await FilesService.shared.pull(
                    cwd: cwd, strategy: "ff-only", confirmToken: token
                )
            }
            guard pulled else { return }
            _ = await runner.runRemoteAwaiting(verb: "push", cwd: cwd) { token in
                try await FilesService.shared.push(cwd: cwd, confirmToken: token)
            }
            refresh(cwd: cwd, force: true)
        }
    }

    // MARK: - Stash

    func stashPush(includeUntracked: Bool) {
        guard let cwd = loadedCwd else { return }
        let message = trimmedMessage.isEmpty ? nil : trimmedMessage
        runner.run(verb: "stash", key: "push", cwd: cwd) { token in
            try await FilesService.shared.stash(
                cwd: cwd,
                action: "push",
                message: message,
                includeUntracked: includeUntracked,
                confirmToken: token
            )
        }
    }

    func stashAction(_ action: String, index: Int?) {
        guard let cwd = loadedCwd else { return }
        runner.run(verb: "stash", key: action, cwd: cwd) { token in
            try await FilesService.shared.stash(
                cwd: cwd, action: action, index: index, confirmToken: token
            )
        }
    }

    // MARK: - Generated commit message

    func generateCommitMessage(amend: Bool = false) {
        guard let cwd = loadedCwd, !isGenerating else { return }
        isGenerating = true
        generateError = nil
        Task { @MainActor in
            defer { isGenerating = false }
            do {
                commitMessage = try await FilesService.shared
                    .generateCommitMessage(cwd: cwd, amend: amend)
            } catch let FilesServiceError.httpStatus(_, body)
                where (body ?? "").contains("nothing-staged") {
                generateError = "Nothing staged — stage something first."
            } catch {
                generateError = "Could not draft a message: \(error.localizedDescription)"
            }
        }
    }
}

// MARK: - View

struct SourceControlView: View {
    @Environment(MarvinBridge.self) private var bridge
    @State private var model = SourceControlModel()
    @State private var graphModel = GitGraphModel()

    @State private var diffSheet: DiffSheetModel? = nil
    @State private var branchPickerOpen = false

    /// Collapsed section ids. Sections default to open; storing the
    /// closed ones means a newly-added section is visible by default.
    @State private var collapsed: Set<String> = []
    @State private var graphShown = true
    /// Focus on the commit box. ⌘⏎ is scoped to it — see `primaryAction`.
    @FocusState private var composerFocused: Bool
    @State private var graphHeight: CGFloat = 240

    private var cwd: String { bridge.projectWorkDir ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            panelHeader
            MarvinDivider()
            if graphShown, model.response?.enabled == true {
                changesArea
                graphSplitter
                graphSection
                    .frame(height: graphHeight)
            } else {
                changesArea
                if model.response?.enabled == true {
                    MarvinDivider()
                    graphHeaderRow
                }
            }
            banners
        }
        .frame(minWidth: 200)
        .background(MarvinTheme.background)
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in syncFromBridge() }
        .onChange(of: bridge.isBusy) { wasBusy, isBusy in
            // A finished turn is the moment tool-driven file writes
            // become visible to `git status`.
            if wasBusy, !isBusy, !cwd.isEmpty {
                model.refresh(cwd: cwd, force: true)
                graphModel.refresh(cwd: cwd, force: true)
            }
        }
        .sheet(item: Binding(
            get: { diffSheet.map(DiffSheetItem.init) },
            set: { if $0 == nil { diffSheet = nil } }
        )) { item in
            DiffSheet(model: item.model, onDismiss: { diffSheet = nil })
        }
        .sheet(item: Bindable(model.runner).pendingConfirm) { pending in
            GitConfirmSheet(
                actionVerb: pending.actionVerb,
                reason: pending.reason,
                severity: pending.severity,
                paths: pending.paths,
                onConfirm: pending.confirm,
                onCancel: pending.cancel
            )
        }
        .sheet(isPresented: $branchPickerOpen) {
            GitRefPickerSheet(cwd: cwd) {
                model.refresh(cwd: cwd, force: true)
                graphModel.refresh(cwd: cwd, force: true)
            }
        }
    }

    private func syncFromBridge() {
        guard !cwd.isEmpty else {
            model.clear()
            graphModel.clear()
            return
        }
        model.refresh(cwd: cwd)
        graphModel.refresh(cwd: cwd)
    }

    // MARK: - Panel header

    private var panelHeader: some View {
        HStack(spacing: 6) {
            Text("Source Control")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(MarvinTheme.textMuted)
                .textCase(.uppercase)
            Spacer()
            if model.isLoading || model.runner.isBusy {
                ProgressView().controlSize(.small).scaleEffect(0.7)
            }
            overflowMenu
        }
        .padding(.horizontal, 12)
        .frame(height: MarvinTheme.paneHeaderHeight)
    }

    /// The `…` menu. This is where every git command that does not
    /// earn a toolbar slot lives — the reference does the same, and it
    /// is the difference between "the panel can commit" and "the panel
    /// is a source control client".
    private var overflowMenu: some View {
        Menu {
            Section("Changes") {
                Button("Stage All Changes") { model.stageAll() }
                    .disabled(model.changes.isEmpty)
                Button("Unstage All Changes") { model.unstageAll() }
                    .disabled(model.staged.isEmpty)
                Button("Discard All Changes…", role: .destructive) {
                    model.discardAllTracked()
                }
                .disabled(model.changes.isEmpty)
                Button("Delete All Untracked Files…", role: .destructive) {
                    model.deleteAllUntracked()
                }
                .disabled(!model.changes.contains { $0.entryType == "untracked" })
            }
            Section("Commit") {
                Button("Commit") { model.commit() }.disabled(!model.canCommit)
                Button("Commit (Amend)") { model.commit(amend: true) }
                    .disabled(!model.canAmend)
                Button("Stage All & Commit") { model.stageAllAndCommit() }
                    .disabled(model.commitMessage.trimmingCharacters(
                        in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Pull, Push") {
                Button("Sync") { model.sync() }.disabled(!model.hasUpstream)
                Button("Fetch") { model.fetchRemote() }
                Button("Pull") { model.pull() }
                Button("Pull (Rebase)") { model.pull(strategy: "rebase") }
                Button("Push") { model.push() }
                Button("Publish Branch") { model.publish() }
                    .disabled(model.hasUpstream)
                Button("Push (Force with Lease)…", role: .destructive) {
                    model.push(forceWithLease: true)
                }
            }
            Section("Branch") {
                Button("Checkout to…") { branchPickerOpen = true }
                Button("Create Branch…") { branchPickerOpen = true }
            }
            Section("Stash") {
                Button("Stash Changes") { model.stashPush(includeUntracked: false) }
                    .disabled(model.isClean)
                Button("Stash Changes (Include Untracked)") {
                    model.stashPush(includeUntracked: true)
                }
                .disabled(model.isClean)
                Button("Pop Latest Stash") { model.stashAction("pop", index: nil) }
                    .disabled(model.stashes.isEmpty)
                Button("Apply Latest Stash") { model.stashAction("apply", index: nil) }
                    .disabled(model.stashes.isEmpty)
                Button("Drop Latest Stash…", role: .destructive) {
                    model.stashAction("drop", index: nil)
                }
                .disabled(model.stashes.isEmpty)
            }
            Section("View") {
                Button(graphShown ? "Hide Graph" : "Show Graph") {
                    graphShown.toggle()
                    if graphShown, !cwd.isEmpty {
                        graphModel.refresh(cwd: cwd, force: true)
                    }
                }
                Button("Refresh") {
                    guard !cwd.isEmpty else { return }
                    model.refresh(cwd: cwd, force: true)
                    graphModel.refresh(cwd: cwd, force: true)
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 18)
        .disabled(cwd.isEmpty)
        .help("More source control actions")
    }

    // MARK: - Changes area

    @ViewBuilder
    private var changesArea: some View {
        if cwd.isEmpty {
            placeholder("(no project active)")
        } else if let response = model.response {
            if response.enabled == false {
                placeholder(response.reason == "not-a-git-repo"
                    ? "(not a git repository)"
                    : "(git unavailable)")
            } else if let error = response.error, !error.isEmpty {
                placeholder("git error: \(error)")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        repoGroup
                        ForEach(otherRepos) { repo in
                            otherRepoRow(repo)
                        }
                        if !model.worktrees.isEmpty { worktreeSection }
                        if !model.stashes.isEmpty { stashSection }
                    }
                    .padding(.bottom, 8)
                }
                .frame(maxHeight: .infinity)
            }
        } else if model.isLoading {
            placeholder("Loading…")
        } else {
            placeholder("(initialising)")
        }
    }

    /// Every worktree except the one the user has open. These are read
    /// -only rows: switching MARVIN's active project is the way in.
    private var otherRepos: [GitRepoEntry] {
        model.repos.filter { !$0.isCurrent }
    }

    private var repoGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            repoHeaderRow
            composer
            if !model.conflicted.isEmpty {
                section("Merge Changes", id: "conflicted", files: model.conflicted)
            }
            if !model.staged.isEmpty {
                section("Staged Changes", id: "staged", files: model.staged)
            }
            if !model.changes.isEmpty {
                section("Changes", id: "changes", files: model.changes)
            }
            if model.isClean {
                Text("No changes")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
        }
    }

    /// Repo name + branch chip + the four inline actions the reference
    /// puts on this row (sync, commit, refresh, more).
    private var repoHeaderRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(bridge.projectName ?? "repository")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            branchChip
            Spacer(minLength: 4)
            iconButton("arrow.triangle.2.circlepath", help: syncHelp) { model.sync() }
                .disabled(!model.hasUpstream || model.runner.isBusy)
            iconButton("checkmark", help: "Commit staged changes") { model.commit() }
                .disabled(!model.canCommit)
            iconButton("arrow.clockwise", help: "Refresh") {
                model.refresh(cwd: cwd, force: true)
                graphModel.refresh(cwd: cwd, force: true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var syncHelp: String {
        guard model.hasUpstream else { return "No upstream — publish the branch first" }
        if !model.isDiverged { return "Sync — up to date with \(model.branch?.upstream ?? "upstream")" }
        return "Sync — pull \(model.behind) and push \(model.ahead)"
    }

    /// The branch name, clickable. This is the affordance that was
    /// missing entirely: the routes behind it shipped with ADR-0012 and
    /// nothing in the app called them.
    private var branchChip: some View {
        Button {
            branchPickerOpen = true
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 9))
                Text(model.branchName)
                    .font(.system(size: 10))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if model.ahead > 0 || model.behind > 0 {
                    Text(divergenceLabel)
                        .font(.system(size: 9).monospaced())
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 7))
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(MarvinTheme.elevated))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 160)
        .help("Checkout, create or delete a branch")
    }

    private var divergenceLabel: String {
        var parts: [String] = []
        if model.behind > 0 { parts.append("\(model.behind)↓") }
        if model.ahead > 0 { parts.append("\(model.ahead)↑") }
        return parts.joined(separator: " ")
    }

    private func iconButton(
        _ symbol: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10))
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(help)
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                TextField(
                    composerPlaceholder,
                    text: Bindable(model).commitMessage,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...6)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .padding(.trailing, 74)
                .focused($composerFocused)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(MarvinTheme.elevated)
                        .overlay(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .stroke(MarvinTheme.border, lineWidth: 1)
                        )
                )
                .onSubmit { if model.canCommit { model.commit() } }

                generateButton
                    .padding(.top, 4)
                    .padding(.trailing, 4)
            }
            primaryAction
            if let err = model.generateError {
                Text(err)
                    .font(.system(size: 10))
                    .foregroundStyle(GitDecorationColor.modified)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
    }

    /// The reference's placeholder names the branch, which is the one
    /// piece of context that stops a commit landing somewhere you did
    /// not mean.
    private var composerPlaceholder: String {
        "Message (⌘⏎ to commit on \"\(model.branchName)\")"
    }

    private var generateButton: some View {
        Button {
            model.generateCommitMessage()
        } label: {
            HStack(spacing: 3) {
                if model.isGenerating {
                    ProgressView().controlSize(.small).scaleEffect(0.55)
                } else {
                    Image(systemName: "sparkles").font(.system(size: 9))
                }
                Text("Generate").font(.system(size: 10, weight: .medium))
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.accentColor.opacity(model.isGenerating ? 0.10 : 0.18))
            )
            .foregroundStyle(Color.accentColor)
        }
        .buttonStyle(.plain)
        .disabled(model.isGenerating || model.staged.isEmpty)
        .help(model.staged.isEmpty
            ? "Stage something to draft a message from"
            : "Draft a commit message from the staged diff")
    }

    /// One primary button whose identity depends on state — Commit
    /// when there is something to commit, Sync when there is not and
    /// the branch has diverged. Two buttons with one perpetually
    /// disabled is what the reference avoids.
    @ViewBuilder
    private var primaryAction: some View {
        if model.staged.isEmpty && model.isDiverged {
            Button {
                model.sync()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 10))
                    Text("Sync Changes \(divergenceLabel)")
                        .font(.system(size: 12, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.runner.isBusy)
        } else if !model.hasUpstream && model.isClean {
            Button {
                model.publish()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.up.to.line")
                        .font(.system(size: 10))
                    Text("Publish Branch")
                        .font(.system(size: 12, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.runner.isBusy)
        } else {
            HStack(spacing: 1) {
                Button {
                    model.commit()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark").font(.system(size: 10))
                        Text(commitLabel).font(.system(size: 12, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.borderedProminent)
                // ⌘⏎ only while the message box has focus, which is what the
                // placeholder promises and what VS Code does. Declared
                // unconditionally it is a GLOBAL key equivalent for as long
                // as this pane is the visible one — so ⌘⏎ aimed at the chat
                // composer (or at AskQuestionSheet's "Send choice", which
                // also owns ⌘⏎) could commit instead. A shortcut that fires
                // from the wrong surface is worse than no shortcut.
                .modifier(CommitReturnShortcut(enabled: composerFocused))
                .disabled(!model.canCommit)

                Menu {
                    Button("Commit & Push") { model.commit(then: .push) }
                        .disabled(!model.canCommit)
                    Button("Commit & Sync") { model.commit(then: .sync) }
                        .disabled(!model.canCommit || !model.hasUpstream)
                    Divider()
                    Button("Stage All & Commit") { model.stageAllAndCommit() }
                    Button("Commit (Amend)") { model.commit(amend: true) }
                        .disabled(!model.canAmend)
                } label: {
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 22)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Color.accentColor.opacity(0.85))
                )
                .foregroundStyle(.white)
                .help("Commit variants")
            }
        }
    }

    private var commitLabel: String {
        if model.runner.isRunning("commit") { return "Committing…" }
        if model.staged.isEmpty { return "Commit" }
        return "Commit \(model.staged.count)"
    }

    // MARK: - Sections + rows

    @ViewBuilder
    private func section(_ label: String, id: String, files: [GitStatusFile]) -> some View {
        let isCollapsed = collapsed.contains(id)
        Button {
            if isCollapsed { collapsed.remove(id) } else { collapsed.insert(id) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.secondary)
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
                Spacer()
                sectionActions(id: id, files: files)
                Text("\(files.count)")
                    .font(.system(size: 9.5, weight: .semibold).monospaced())
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(MarvinTheme.elevated))
                    .foregroundStyle(MarvinTheme.textMuted)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)

        if !isCollapsed {
            ForEach(files, id: \.path) { file in
                SourceControlRow(
                    file: file,
                    cwd: cwd,
                    section: id,
                    isInFlight: rowIsInFlight(file),
                    onTap: { openDiff(for: file) },
                    onStage: { model.stage([repoRelative(file.path)]) },
                    onUnstage: { model.unstage([repoRelative(file.path)]) },
                    onDiscard: { discardRow(file) },
                    onReveal: { reveal(file) }
                )
            }
        }
    }

    /// Bulk actions on the section header, hover-revealed the way the
    /// reference does it.
    @ViewBuilder
    private func sectionActions(id: String, files: [GitStatusFile]) -> some View {
        if id == "staged" {
            iconButton("minus", help: "Unstage all") { model.unstageAll() }
        } else if id == "changes" {
            iconButton("arrow.uturn.backward", help: "Discard all changes") {
                model.discardAllTracked()
            }
            iconButton("plus", help: "Stage all changes") { model.stageAll() }
        }
    }


    /// Implementer worktrees (ADR-0103).
    ///
    /// This replaces reading an implementer's progress off a dirty count —
    /// which reported 0 for one that had correctly committed, making finished
    /// work indistinguishable from none. `state` is derived from git on every
    /// fetch, so a branch merged in a terminal or another session shows as
    /// merged here without MARVIN having witnessed it.
    private var worktreeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Worktrees")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
                Spacer()
                let ready = model.worktrees.filter(\.isReady).count
                if ready > 0 {
                    Text("\(ready) ready")
                        .font(.system(size: 9.5, weight: .semibold).monospaced())
                        .padding(.horizontal, 5)
                        .background(Capsule().fill(MarvinTheme.elevated))
                        .foregroundStyle(GitDecorationColor.added)
                }
                if model.worktrees.contains(where: \.isSpent) {
                    Button("Reclaim") { model.sweepWorktrees() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(MarvinTheme.textMuted)
                        .disabled(model.worktreeBusy)
                        .help("Remove checkouts and delete branches that are empty or already merged. Never touches unmerged or uncommitted work.")
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 3)

            ForEach(model.worktrees) { w in worktreeRow(w) }

            if let notice = model.worktreeNotice {
                Text(notice)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(4)
                    .padding(.horizontal, 14)
                    .padding(.top, 2)
                    .textSelection(.enabled)
            }
        }
    }

    private func worktreeRow(_ w: WorktreeEntry) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(worktreeTint(w))
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(w.branch)
                    .font(.system(size: 11))
                    .foregroundStyle(MarvinTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(w.summary)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if w.isReady {
                Button("Merge") { model.mergeWorktree(slug: w.slug) }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(GitDecorationColor.added)
                    .disabled(model.worktreeBusy)
                    .help("Merge \(w.branch) into the current branch, locally. Never pushes — the commits ride along in whatever pipeline this branch already runs.")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .help("\(w.task)\n\(w.path)")
        .contextMenu {
            Button("Copy Review Command") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(
                    "git diff \(w.base)...\(w.branch)", forType: .string
                )
            }
            Button("Copy Branch Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(w.branch, forType: .string)
            }
            if w.checkoutPresent {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: w.path)
                }
                Divider()
                Button("Drop Checkout (keep branch)") {
                    model.dropWorktree(slug: w.slug)
                }
                .disabled(model.worktreeBusy)
            }
        }
    }

    private func worktreeTint(_ w: WorktreeEntry) -> Color {
        switch w.state {
        case "ready": return GitDecorationColor.added
        case "running": return GitDecorationColor.modified
        case "merged": return MarvinTheme.textMuted
        default: return .secondary
        }
    }

    private var stashSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Image(systemName: "tray.full")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                Text("Stashes")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(MarvinTheme.textMuted)
                Spacer()
                Text("\(model.stashes.count)")
                    .font(.system(size: 9.5, weight: .semibold).monospaced())
                    .foregroundStyle(MarvinTheme.textMuted)
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 3)

            ForEach(model.stashes) { entry in
                HStack(spacing: 6) {
                    Text(entry.message)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(MarvinTheme.textPrimary)
                    Spacer(minLength: 4)
                    Text(entry.relativeDate)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
                .contextMenu {
                    Button("Pop") { model.stashAction("pop", index: entry.index) }
                    Button("Apply") { model.stashAction("apply", index: entry.index) }
                    Divider()
                    Button("Drop…", role: .destructive) {
                        model.stashAction("drop", index: entry.index)
                    }
                }
            }
        }
    }

    /// A linked worktree. Read-only here — the row exists so a
    /// checkout MARVIN created for an implementer subagent (ADR-0081)
    /// is visible rather than silently absent.
    private func otherRepoRow(_ repo: GitRepoEntry) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "square.split.2x1")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
            Text(repo.name)
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textMuted)
                .lineLimit(1)
            Text(repo.detached ? "(detached)" : (repo.branch ?? "?"))
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if repo.dirtyCount > 0 {
                Text("\(repo.dirtyCount)")
                    .font(.system(size: 9.5, weight: .semibold).monospaced())
                    .padding(.horizontal, 5)
                    .background(Capsule().fill(MarvinTheme.elevated))
                    .foregroundStyle(GitDecorationColor.modified)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .help("Linked worktree at \(repo.path)")
        .contextMenu {
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(repo.path, forType: .string)
            }
            Button("Reveal in Finder") {
                NSWorkspace.shared.selectFile(
                    nil, inFileViewerRootedAtPath: repo.path
                )
            }
        }
    }

    // MARK: - Graph

    /// Drag handle between the changes list and the graph. Plain
    /// gesture rather than a real split view: the panel is already
    /// inside one, and nesting NSSplitViews is what produced the
    /// divider crashes recorded in SplitDividerTheme.swift.
    private var graphSplitter: some View {
        MarvinDivider()
            .frame(height: 5)
            .background(MarvinTheme.background)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture()
                    .onChanged { value in
                        graphHeight = min(max(graphHeight - value.translation.height, 90), 600)
                    }
            )
    }

    private var graphSection: some View {
        VStack(spacing: 0) {
            graphHeaderRow
            MarvinDivider()
            GitGraphView(cwd: cwd, model: graphModel)
        }
    }

    private var graphHeaderRow: some View {
        HStack(spacing: 6) {
            Button {
                graphShown.toggle()
                if graphShown, !cwd.isEmpty {
                    graphModel.refresh(cwd: cwd, force: true)
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: graphShown ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                    Text("Graph")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                }
                .foregroundStyle(MarvinTheme.textMuted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
            iconButton("arrow.down.to.line", help: "Fetch from origin") {
                model.fetchRemote()
            }
            iconButton("arrow.down.circle", help: "Pull (fast-forward only)") {
                model.pull()
            }
            iconButton("arrow.up.circle", help: "Push to origin") { model.push() }
            iconButton("arrow.clockwise", help: "Refresh graph") {
                graphModel.refresh(cwd: cwd, force: true)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(MarvinTheme.background)
    }

    // MARK: - Banners

    @ViewBuilder
    private var banners: some View {
        if let err = model.runner.lastError {
            MarvinDivider()
            banner(err, isError: true) { model.runner.dismissError() }
        } else if let note = model.runner.lastNote, !note.isEmpty {
            MarvinDivider()
            banner(note, isError: false) { model.runner.dismissNote() }
        }
        if let err = model.lastError {
            MarvinDivider()
            banner("Status fetch error: \(err)", isError: true) {}
        }
    }

    private func banner(
        _ message: String,
        isError: Bool,
        dismiss: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isError
                ? "exclamationmark.triangle.fill"
                : "checkmark.circle.fill")
                .foregroundStyle(isError
                    ? GitDecorationColor.deleted : GitDecorationColor.added)
            Text(message)
                .font(.system(size: 10).monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(4)
            Spacer()
            Button { dismiss() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
        }
        .padding(8)
        .background(
            (isError ? GitDecorationColor.deleted : GitDecorationColor.added)
                .opacity(0.08)
        )
    }

    // MARK: - Helpers

    private func rowIsInFlight(_ file: GitStatusFile) -> Bool {
        let relative = repoRelative(file.path)
        return ["stage", "unstage", "discard"].contains {
            model.runner.isRunning("\($0):\(relative)")
        }
    }

    /// Untracked rows are a `git clean`, not a `git restore` — the two
    /// carry different policy severities for a reason.
    private func discardRow(_ file: GitStatusFile) {
        let relative = repoRelative(file.path)
        if file.entryType == "untracked" {
            model.discard([relative], mode: "untracked")
        } else if file.workingStatus == "." && file.indexStatus != "." {
            model.discard([relative], mode: "staged")
        } else {
            model.discard([relative], mode: "working")
        }
    }

    private func repoRelative(_ path: String) -> String {
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return path.hasPrefix(root) ? String(path.dropFirst(root.count)) : path
    }

    private func openDiff(for file: GitStatusFile) {
        guard !cwd.isEmpty else { return }
        let initial = DiffMode(rawValue: DiffSheet.initialMode(for: file)) ?? .working
        diffSheet = DiffSheetModel(
            cwd: cwd,
            relativePath: repoRelative(file.path),
            initialMode: initial
        )
    }

    private func reveal(_ file: GitStatusFile) {
        NSWorkspace.shared.selectFile(
            file.path, inFileViewerRootedAtPath: cwd
        )
    }

    private func placeholder(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Applies ⌘⏎ only while `enabled`. SwiftUI has no conditional
/// `.keyboardShortcut`, and passing `nil` is not available on the
/// deployment target, so the branch is on the view itself.
private struct CommitReturnShortcut: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.keyboardShortcut(.return, modifiers: [.command])
        } else {
            content
        }
    }
}

/// Identifiable wrapper for the diff-sheet model — `.sheet(item:)`
/// needs Identifiable and `DiffSheetModel` is a `@MainActor` class, so
/// the id is captured from its immutable fields at construction.
struct DiffSheetItem: Identifiable {
    let model: DiffSheetModel
    let id: String

    init(model: DiffSheetModel) {
        self.model = model
        self.id = "\(model.cwd):\(model.relativePath)"
    }
}

/// One file row: `icon · filename · dimmed directory · [hover actions] ·
/// status letter`. This is the reference's layout, and it is a
/// different reading order from the porcelain two-column badge the
/// panel used to lead with — the filename is what you scan for, so it
/// goes first and the status code goes last.
private struct SourceControlRow: View {
    let file: GitStatusFile
    let cwd: String
    /// Section id — decides which inline action is offered.
    let section: String
    let isInFlight: Bool
    let onTap: () -> Void
    let onStage: () -> Void
    let onUnstage: () -> Void
    let onDiscard: () -> Void
    let onReveal: () -> Void

    @State private var hovering = false

    private static let rowHeight: CGFloat = 22

    var body: some View {
        HStack(spacing: 6) {
            icon
            Text(fileName)
                .font(.system(size: 12))
                .foregroundStyle(nameColor)
                .lineLimit(1)
                .strikethrough(badge == .deleted, color: nameColor)
            Text(directory)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            if isInFlight {
                ProgressView().controlSize(.small).scaleEffect(0.6)
            } else if hovering {
                hoverActions
            }
            Text(badge.label)
                .font(.system(size: 11, weight: .semibold).monospaced())
                .foregroundStyle(badge.colour)
                .frame(width: 12)
        }
        .padding(.horizontal, 12)
        .frame(height: Self.rowHeight)
        .background(hovering ? MarvinTheme.rowHover : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: onTap)
        .help(relativePath)
        .contextMenu { menu }
        .accessibilityIdentifier("scm-row:\(file.path)")
    }

    /// Actions in the reference's order: open diff, discard, then
    /// stage/unstage closest to the status letter.
    private var hoverActions: some View {
        HStack(spacing: 2) {
            rowIcon("arrow.left.arrow.right", help: "Open changes", action: onTap)
            if section != "conflicted" {
                rowIcon(
                    "arrow.uturn.backward",
                    help: file.entryType == "untracked"
                        ? "Delete file" : "Discard changes",
                    action: onDiscard
                )
                if section == "staged" {
                    rowIcon("minus", help: "Unstage", action: onUnstage)
                } else {
                    rowIcon("plus", help: "Stage", action: onStage)
                }
            }
        }
    }

    private func rowIcon(
        _ symbol: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 9))
                .frame(width: 15, height: 15)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(help)
    }

    @ViewBuilder
    private var menu: some View {
        Button("Open Changes", action: onTap)
        Button("Reveal in Finder", action: onReveal)
        Divider()
        if section != "conflicted" {
            if section == "staged" {
                Button("Unstage", action: onUnstage)
            } else {
                Button("Stage", action: onStage)
            }
        }
        Button("Copy Path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(relativePath, forType: .string)
        }
        Divider()
        Button(role: .destructive, action: onDiscard) {
            Text(file.entryType == "untracked"
                ? "Delete File…" : "Discard Changes…")
        }
    }

    @ViewBuilder
    private var icon: some View {
        if let glyph = SymbolsIcon.image(
            forPath: file.path, isDirectory: false, size: 15
        ) {
            Image(nsImage: glyph).frame(width: 16)
        } else {
            Image(systemName: "doc")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 16)
        }
    }

    /// Deleted files read as gone; everything else takes its status
    /// colour on the NAME, which is the reference's decoration target.
    private var nameColor: Color {
        badge == .deleted ? .secondary : badge.colour
    }

    private var badge: GitStatusBadge {
        if file.entryType == "untracked" { return .untracked }
        if file.entryType == "unmerged" { return .conflicted }
        // A row lives in exactly one section, so read the column that
        // section cares about — otherwise a file that is staged-modified
        // AND working-deleted renders the same letter twice.
        let code = section == "staged" ? file.indexStatus : file.workingStatus
        return GitStatusBadge.category(forCode: code)
    }

    private var relativePath: String {
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return file.path.hasPrefix(root)
            ? String(file.path.dropFirst(root.count))
            : file.path
    }

    private var fileName: String {
        (relativePath as NSString).lastPathComponent
    }

    private var directory: String {
        let dir = (relativePath as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }
}

// SourceControlView — the Source Control pane.
//
// Two scopes in one pane (owner, 25.11.2026: "Source Control needs a better
// implementation"). The pane used to read the project's shared checkout
// whichever tab was selected, while every tab works in its own git worktree on
// its own branch; the status, stage, commit and push belong to ONE tree, and the
// worktree list, merge all, reclaim and Prepare MR belong to the PROJECT. One
// `cwd` for both is what made a tab's tree impossible to show safely, so there
// are now two, each owned by its own model:
//
//   This tab  /  Checkout      SourceControlModel            cwd = the viewed tree
//     Viewing: <tab> · <branch> · <path>        [pin to the project checkout]
//     branch, ahead/behind, filter, commit box
//     Staged · Changes · Untracked as a tree with counts, a diff preview
//     Stashes, History
//
//   Project                    SourceControlProjectModel     root = the project, always
//     Ready to merge · Building · Open tabs · Merged or empty
//     Integrate ▾  (merge all, Prepare MR, reclaim) — in a menu, each behind a
//     confirmation that names what it touches and what cannot be undone
//
// Which tree the first scope shows is `SourceControlTarget.resolve`, a pure
// decision (MARVINLogic): the pin the person set, the selected tab and the
// project root. It changes with the tab selection and with nothing else.
//
// Every mutation goes through `GitOpRunner` (confirm-token round trip,
// ADR-0012) with the target named in its confirmation. ADR-0102's confirm for a
// HEAD-moving command and ADR-0109's confirm before spending CI minutes are the
// server's and the sheet's; nothing here removes or answers them.

import AppKit
import MARVINLogic
import SwiftUI

/// View-model for the first scope: ONE working tree. Owns the status fetch, the
/// stash list and the commit composer state. Mutations delegate to `runner`.
@MainActor
@Observable
final class SourceControlModel {
    private(set) var response: GitStatusResponse? = nil
    private(set) var isLoading: Bool = false
    private(set) var lastError: String? = nil
    /// The directory every request here uses. Set synchronously by `view`, before
    /// any fetch, so a stage or a discard can never reach the PREVIOUS tree while
    /// the new one is loading.
    private(set) var loadedCwd: String? = nil
    /// "in tab X (branch)" — what a confirmation says about where it acts.
    private(set) var targetPhrase: String = "in the project checkout"
    private(set) var stashes: [GitStashEntry] = []
    /// The response, split into the pane's groups with paths relative to the tree.
    private(set) var groups: [ChangeGroup: [ChangeItem]] = [:]

    /// The status banner's ×; it used to be an empty closure (audit L18).
    func dismissStatusError() { lastError = nil }

    private var fetchTask: Task<Void, Never>?
    private var probeRetryTask: Task<Void, Never>?

    /// Commit message input, per tree: a message typed for one tab's branch must
    /// not be waiting in another's box. In memory only; it does not survive a relaunch.
    var commitMessage: String = ""
    private var drafts: [String: String] = [:]

    /// True while `/api/git/commit-message` is drafting one. The request spawns a
    /// model turn server-side, so it is slow enough to need its own visible state.
    private(set) var isGenerating = false
    var generateError: String? = nil

    let runner = GitOpRunner()

    init() {
        runner.onDidMutate = { [weak self] in
            guard let self, let cwd = self.loadedCwd else { return }
            self.refresh(cwd: cwd, force: true)
        }
    }

    // MARK: - Which tree

    /// Point the model at a tree. The old tree's answer is dropped at once; the
    /// new tree's arrives from `refresh`.
    func view(cwd: String, phrase: String) {
        targetPhrase = phrase
        if loadedCwd != cwd {
            if let old = loadedCwd { drafts[old] = commitMessage }
            fetchTask?.cancel()
            probeRetryTask?.cancel()
            loadedCwd = cwd
            response = nil
            groups = [:]
            stashes = []
            lastError = nil
            isGenerating = false
            generateError = nil
            commitMessage = drafts[cwd] ?? ""
        }
        refresh(cwd: cwd, force: true)
    }

    func clear() {
        fetchTask?.cancel(); fetchTask = nil
        probeRetryTask?.cancel(); probeRetryTask = nil
        response = nil
        groups = [:]
        stashes = []
        loadedCwd = nil
        lastError = nil
        isLoading = false
    }

    // MARK: - Reads

    /// Kick off a status fetch for `cwd`. Idempotent unless forced. The stash list
    /// rides along: a stash moves status AND the stash list, so refreshing them
    /// separately would guarantee one of them is stale on screen.
    func refresh(cwd: String, force: Bool = false) {
        guard loadedCwd == cwd else { return }
        // An `enabled: false` answer is never settled: `probe-failed` means the
        // sidecar was busy, and even `not-a-git-repo` should be asked again on the
        // next appear — a repo can be initialised underneath an open project.
        if !force, let r = response, r.enabled, !isLoading { return }
        fetchTask?.cancel()
        isLoading = true
        lastError = nil
        fetchTask = Task { @MainActor in
            defer { if loadedCwd == cwd { isLoading = false } }
            do {
                async let status = FilesService.shared.fetchGitStatus(cwd: cwd)
                async let stashList = FilesService.shared.fetchStashes(cwd: cwd)
                let res = try await status
                guard !Task.isCancelled, loadedCwd == cwd else { return }
                response = res
                groups = Self.partition(res, cwd: cwd)
                if !res.enabled, res.reason == "probe-failed" { scheduleProbeRetry(cwd: cwd) }
                let entries = (try? await stashList)?.entries ?? []
                guard !Task.isCancelled, loadedCwd == cwd else { return }
                stashes = entries
            } catch is CancellationError {
                /* racing a tree switch — quiet */
            } catch {
                guard !BenignCancellation.matches(error), loadedCwd == cwd else { return }
                lastError = "\(error)"
            }
        }
    }

    private static func partition(_ res: GitStatusResponse, cwd: String) -> [ChangeGroup: [ChangeItem]] {
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        func relative(_ p: String) -> String { p.hasPrefix(root) ? String(p.dropFirst(root.count)) : p }
        return ChangeTree.partition((res.files ?? []).map {
            RawChange(path: relative($0.path), indexStatus: $0.indexStatus, workingStatus: $0.workingStatus,
                      entryType: $0.entryType, renamedFrom: $0.renamedFrom.map(relative))
        })
    }

    /// The status probe timed out because the sidecar's event loop was busy, not
    /// because the answer was "no". Ask again after a beat.
    private func scheduleProbeRetry(cwd: String) {
        probeRetryTask?.cancel()
        probeRetryTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, loadedCwd == cwd else { return }
            refresh(cwd: cwd, force: true)
        }
    }

    // MARK: - Partitions

    func items(_ group: ChangeGroup) -> [ChangeItem] { groups[group] ?? [] }
    var conflictCount: Int { items(.conflicts).count }
    var stagedCount: Int { items(.staged).count }
    var changeCount: Int { items(.changes).count }
    var untrackedCount: Int { items(.untracked).count }
    var isClean: Bool { ChangeGroup.allCases.allSatisfy { items($0).isEmpty } }
    var totalFiles: Int { Set(groups.values.joined().map(\.path)).count }

    var branch: GitStatusBranch? { response?.branch }
    var branchName: String { branch?.name ?? "(detached)" }
    var ahead: Int { branch?.ahead ?? 0 }
    var behind: Int { branch?.behind ?? 0 }
    var hasUpstream: Bool { !(branch?.upstream ?? "").isEmpty }
    var isDiverged: Bool { ahead > 0 || behind > 0 }

    // MARK: - Per-path mutations

    private var context: GitConfirmContext { GitConfirmContext(target: targetPhrase) }

    func stage(_ paths: [String]) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        runner.run(verb: "stage", key: paths.count == 1 ? paths[0] : "*", cwd: cwd, context: context) { _ in
            try await FilesService.shared.stage(cwd: cwd, paths: paths)
        }
    }

    func unstage(_ paths: [String]) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        runner.run(verb: "unstage", key: paths.count == 1 ? paths[0] : "*", cwd: cwd, context: context) { _ in
            try await FilesService.shared.unstage(cwd: cwd, paths: paths)
        }
    }

    /// Discard working-tree changes (`untracked: false`, `git restore`) or delete
    /// untracked files (`git clean`) — two policy decisions, not one: tracked
    /// files are restorable-ish (confirm warn), untracked ones are deleted
    /// outright (confirm danger). The confirmation names the tree, the count and
    /// that it cannot be undone.
    func discard(_ paths: [String], untracked: Bool) {
        guard let cwd = loadedCwd, !paths.isEmpty else { return }
        let text = SourceControlConfirmText.discard(count: paths.count, untracked: untracked, target: targetPhrase)
        runner.run(
            verb: "discard", key: paths.count == 1 ? paths[0] : "*", cwd: cwd,
            context: GitConfirmContext(target: targetPhrase, text: text)
        ) { token in
            try await FilesService.shared.discard(
                cwd: cwd, paths: paths, mode: untracked ? "untracked" : "working", confirmToken: token)
        }
    }

    // MARK: - Bulk mutations

    func stageAllChanges() { stage(items(.changes).map(\.path)) }
    func stageAllUntracked() { stage(items(.untracked).map(\.path)) }
    func stageEverything() { stage(["."]) }
    func unstageAll() { unstage(items(.staged).map(\.path)) }
    func discardAllTracked() { discard(items(.changes).map(\.path), untracked: false) }
    func deleteAllUntracked() { discard(items(.untracked).map(\.path), untracked: true) }

    // MARK: - Commit

    private var trimmedMessage: String {
        commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canCommit: Bool {
        !trimmedMessage.isEmpty && stagedCount > 0 && !runner.isRunning("commit")
    }

    /// Amend is allowed with an empty box — git keeps the old message.
    var canAmend: Bool {
        !runner.isRunning("commit") && response?.enabled == true
    }

    func commit(amend: Bool = false, then followUp: FollowUp = .none) {
        guard let cwd = loadedCwd else { return }
        let message = trimmedMessage
        guard amend || (!message.isEmpty && stagedCount > 0) else { return }
        runner.run(
            verb: "commit",
            key: "",
            cwd: cwd,
            context: context,
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

    /// What runs after a successful commit, for the split-button variants.
    enum FollowUp { case none, push, sync }

    /// Stage everything, then commit. VS Code's "Commit All".
    func stageAllAndCommit() {
        guard let cwd = loadedCwd else { return }
        guard !trimmedMessage.isEmpty else { return }
        runner.run(
            verb: "stage", key: ".", cwd: cwd, context: context,
            body: { _ in try await FilesService.shared.stage(cwd: cwd, paths: ["."]) },
            onSuccess: { [weak self] in self?.commit() }
        )
    }

    // MARK: - Remote

    func fetchRemote() {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "fetch", cwd: cwd, context: context) { _ in
            try await FilesService.shared.fetch(cwd: cwd)
        }
    }

    func pull(strategy: String = "ff-only") {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "pull", cwd: cwd, context: context) { token in
            try await FilesService.shared.pull(cwd: cwd, strategy: strategy, confirmToken: token)
        }
    }

    func push(forceWithLease: Bool = false) {
        guard let cwd = loadedCwd else { return }
        let ctx = forceWithLease
            ? GitConfirmContext(target: targetPhrase, text: SourceControlConfirmText.forcePush(target: targetPhrase))
            : context
        runner.runRemote(verb: "push", cwd: cwd, context: ctx) { token in
            try await FilesService.shared.push(cwd: cwd, forceWithLease: forceWithLease, confirmToken: token)
        }
    }

    /// `git push -u` — the only shape that works for a branch with no upstream.
    func publish() {
        guard let cwd = loadedCwd else { return }
        runner.runRemote(verb: "publish", cwd: cwd, context: context) { token in
            try await FilesService.shared.push(cwd: cwd, setUpstream: true, confirmToken: token)
        }
    }

    /// Pull then push, IN ORDER and only if the pull succeeded. Firing both
    /// concurrently would push a branch the pull was about to rebase, which is the
    /// exact failure this button exists to prevent.
    func sync() {
        guard let cwd = loadedCwd else { return }
        let ctx = context
        Task { @MainActor in
            let pulled = await runner.runRemoteAwaiting(verb: "pull", cwd: cwd, context: ctx) { token in
                try await FilesService.shared.pull(cwd: cwd, strategy: "ff-only", confirmToken: token)
            }
            guard pulled else { return }
            _ = await runner.runRemoteAwaiting(verb: "push", cwd: cwd, context: ctx) { token in
                try await FilesService.shared.push(cwd: cwd, confirmToken: token)
            }
            refresh(cwd: cwd, force: true)
        }
    }

    // MARK: - Stash

    func stashPush(includeUntracked: Bool) {
        guard let cwd = loadedCwd else { return }
        let message = trimmedMessage.isEmpty ? nil : trimmedMessage
        runner.run(verb: "stash", key: "push", cwd: cwd, context: context) { token in
            try await FilesService.shared.stash(
                cwd: cwd, action: "push", message: message,
                includeUntracked: includeUntracked, confirmToken: token)
        }
    }

    func stashAction(_ action: String, index: Int?) {
        guard let cwd = loadedCwd else { return }
        runner.run(verb: "stash", key: action, cwd: cwd, context: context) { token in
            try await FilesService.shared.stash(cwd: cwd, action: action, index: index, confirmToken: token)
        }
    }

    // MARK: - Generated commit message

    func generateCommitMessage(amend: Bool = false) {
        guard let cwd = loadedCwd, !isGenerating else { return }
        isGenerating = true
        generateError = nil
        Task { @MainActor in
            defer { if loadedCwd == cwd { isGenerating = false } }
            do {
                let drafted = try await FilesService.shared.generateCommitMessage(cwd: cwd, amend: amend)
                if loadedCwd == cwd { commitMessage = drafted }
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

/// The pane's two scopes.
enum SourceControlScope: Hashable { case tree, project }

/// What a project-level act asks before it runs.
private enum ProjectConfirmation: Identifiable {
    case mergeAll
    case sweep
    case drop(slug: String, branch: String)

    var id: String {
        switch self {
        case .mergeAll: return "mergeAll"
        case .sweep: return "sweep"
        case .drop(let slug, _): return "drop:\(slug)"
        }
    }
}

/// A starting state for the view, so the snapshot harness can render the pane
/// mid-use (a filter typed, a file selected, the project scope open) without
/// synthesising clicks. A real launch passes none.
struct SourceControlInitialState {
    var scope: SourceControlScope = .tree
    var pin: SourceControlPin = .followTab
    var filter = ""
    var selection: String? = nil
    var folderOverrides: [String: Bool] = [:]
    /// Folded section ids; nil is what the person has saved (or the defaults).
    var collapsed: Set<String>? = nil
}

@MainActor struct SourceControlView: View {
    init(initial: SourceControlInitialState = SourceControlInitialState()) {
        _scope = State(initialValue: initial.scope)
        _pin = State(initialValue: initial.pin)
        _filter = State(initialValue: initial.filter)
        _selection = State(initialValue: initial.selection)
        _folderOverrides = State(initialValue: initial.folderOverrides)
        if let folded = initial.collapsed { _collapsed = State(initialValue: folded) }
    }

    @Environment(MarvinBridge.self) private var bridge
    @State private var model = SourceControlModel()
    @State private var project = SourceControlProjectModel()
    @State private var graphModel = GitGraphModel()
    @State private var preview = SourceControlPreviewModel()

    @State private var scope: SourceControlScope
    @State private var pin: SourceControlPin

    @State private var diffSheet: DiffSheetModel? = nil
    @State private var branchPickerOpen = false
    @State private var prepareMROpen = false
    @State private var confirmation: ProjectConfirmation? = nil

    /// Collapsed group ids, remembered across launches. Sections default to open
    /// except the reference ones (`SourceControlCollapse.defaultClosed`).
    @State private var collapsed: Set<String> = SourceControlView.loadCollapsed()
    /// A person's own open / closed choice per directory; the default decides the rest.
    @State private var folderOverrides: [String: Bool]
    @State private var filter: String

    private static let collapsedKey = "marvin.sourceControl.collapsed.v1"

    static func loadCollapsed() -> Set<String> {
        SourceControlCollapse.initial(stored: UserDefaults.standard.stringArray(forKey: collapsedKey))
    }

    private var root: String { bridge.projectWorkDir ?? "" }

    // MARK: Which tree

    /// The tree the first scope shows. Recomputed from the selected tab, so it
    /// follows the selection and nothing else (a pin aside).
    private var target: SourceControlTarget? {
        guard !root.isEmpty else { return nil }
        let id = bridge.activeMarvinSessionId
        let entry = id.flatMap { SessionRegistry.shared.entry($0) }
        let path = entry?.tree?.path
        return SourceControlTarget.resolve(pin: pin, SourceControlTargetInput(
            projectRoot: root,
            projectName: bridge.projectName,
            projectBranch: scopeIsProjectCheckoutBranch,
            tabName: id.map { SessionRegistry.shared.displayName($0) },
            tabMode: entry?.mode,
            tabTree: entry?.tree,
            tabTreePresent: path.map { FileManager.default.fileExists(atPath: $0) },
            home: NSHomeDirectory()))
    }

    /// The branch the PROJECT checkout is on. The first scope's own status may be
    /// a tab's tree, so the project's branch comes from the project model's list.
    private var scopeIsProjectCheckoutBranch: String? {
        project.repos.first(where: { $0.isMain })?.branch
            ?? (model.loadedCwd == root ? model.response?.branch?.name : nil)
    }

    var body: some View {
        let target = self.target
        VStack(spacing: 0) {
            header(target)
            scopePicker(target)
            MarvinDivider()
            content(target)
            banners
        }
        .frame(minWidth: 200)
        .background(MarvinTheme.background)
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            pin = .followTab
            syncFromBridge()
        }
        // The tree follows the tab selection (and a pin): a new path is a new view.
        .onChange(of: target?.path) { _, _ in viewTarget() }
        .onChange(of: bridge.isBusy) { wasBusy, isBusy in
            // A finished turn is the moment tool-driven file writes become visible
            // to `git status`, and a tab's branch may have a new commit.
            if wasBusy, !isBusy, !root.isEmpty {
                model.refresh(cwd: model.loadedCwd ?? root, force: true)
                graphModel.refresh(cwd: model.loadedCwd ?? root, force: true)
                project.refresh(root: root, force: true)
            }
        }
        .onChange(of: project.worktrees) { _, list in
            // A pinned worktree that was removed is not a tree any more.
            if case .worktree(let path, _, _) = pin, !FileManager.default.fileExists(atPath: path) || !list.contains(where: { $0.path == path }) {
                pin = .followTab
            }
        }
        .onChange(of: scope) { _, now in
            if now == .project, !root.isEmpty { project.refresh(root: root, force: true) }
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
                context: pending.context,
                onConfirm: pending.confirm,
                onCancel: pending.cancel
            )
        }
        .sheet(isPresented: $branchPickerOpen) {
            GitRefPickerSheet(cwd: model.loadedCwd ?? root) {
                refreshAll()
            }
        }
        // ADR-0111 — the Sessions pane's "Prepare MR…" lands here, on the project scope.
        .onChange(of: bridge.sourceControlRequest) { _, request in
            guard let request else { return }
            switch request {
            case .prepareMR:
                scope = .project
                project.refresh(root: root, force: true)
                project.refreshIntegrationPreview()
                prepareMROpen = true
            }
            bridge.clearSourceControlRequest()
        }
        .sheet(isPresented: $prepareMROpen) {
            PrepareMRSheet(worktrees: project.worktrees, preview: project.integrationPreview) { slugs, name, message, push, openMR in
                project.prepareMergeRequest(slugs: slugs, name: name, message: message, push: push, openMergeRequest: openMR)
            }
        }
        .confirmationDialog(
            confirmationText?.title ?? "",
            isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
            titleVisibility: .visible,
            presenting: confirmation
        ) { c in
            if let text = confirmationText {
                Button(text.confirmLabel, role: isDestructive(c) ? .destructive : nil) { run(c) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text(confirmationText?.message ?? "")
        }
        // A pane absorbs compression and clips; it never negotiates for width. All
        // seven stay mounted in one ZStack, so the widest intrinsic minimum among
        // them becomes the sidebar's, and the overflow pushes the 44pt rail off the
        // left edge (ADR-0114).
        // Top-aligned in every state: a short one (no project, a clean tree) used to float in
        // the middle of the slot with its header halfway down.
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .clipped()
    }

    // MARK: Syncing

    private func syncFromBridge() {
        guard !root.isEmpty else {
            model.clear()
            project.clear()
            graphModel.clear()
            preview.clear()
            return
        }
        let projectRoot = root
        project.onIntegrated = { [model, graphModel] in
            // A merge landed in the project checkout: if that is what is on screen, reload it.
            if let cwd = model.loadedCwd, cwd == projectRoot {
                model.refresh(cwd: cwd, force: true)
                graphModel.refresh(cwd: cwd, force: true)
            }
        }
        project.refresh(root: root)
        viewTarget()
    }

    private func viewTarget() {
        guard let target else { return }
        // A different tree is a different list: the selection and the preview belong to the old one.
        if let loaded = model.loadedCwd, loaded != target.path {
            preview.clear()
            selection = nil
            folderOverrides = [:]
        }
        model.view(cwd: target.path, phrase: target.actionPhrase)
        graphModel.refresh(cwd: target.path, force: true)
    }

    private func refreshAll() {
        guard !root.isEmpty else { return }
        model.refresh(cwd: model.loadedCwd ?? root, force: true)
        graphModel.refresh(cwd: model.loadedCwd ?? root, force: true)
        project.refresh(root: root, force: true)
    }

    // MARK: Selection (the first scope's list)

    @State private var selection: String?

    // MARK: Header

    private func header(_ target: SourceControlTarget?) -> some View {
        PaneHeader(title: "Source Control", symbol: "arrow.triangle.branch") {
            if model.isLoading || model.runner.isBusy || project.isLoading || project.busy {
                ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 14, height: 14)
            }
            Button { refreshAll() } label: { Image(systemName: "arrow.clockwise") }
                .paneIconButton(10)
                .disabled(root.isEmpty)
                .help("Refresh")
                .accessibilityLabel("Refresh")
            if scope == .tree {
                SourceControlTreeMenu(
                    model: model, target: target,
                    pickBranch: { branchPickerOpen = true },
                    expandAll: { setAllFolders(closed: false) },
                    collapseAll: { setAllFolders(closed: true) })
            } else {
                SourceControlIntegrateMenu(
                    project: project,
                    mergeAll: { confirmation = .mergeAll },
                    prepareMR: { project.refreshIntegrationPreview(); prepareMROpen = true },
                    sweep: { confirmation = .sweep })
            }
        }
    }

    private func setAllFolders(closed: Bool) {
        var next: [String: Bool] = [:]
        for group in ChangeGroup.allCases {
            let rows = ChangeTree.rows(items: model.items(group), group: group, filter: "", overrides: [:], autoCollapseAbove: .max)
            for r in rows where r.kind == .directory { next[r.id] = closed }
        }
        folderOverrides = next
    }

    @ViewBuilder
    private func scopePicker(_ target: SourceControlTarget?) -> some View {
        if target != nil {
            let ready = project.readyCount
            ViewThatFits(in: .horizontal) {
                scopeSegments(first: target?.segmentTitle ?? "Checkout", second: ready > 0 ? "Project · \(ready) ready" : "Project")
                scopeSegments(first: target?.segmentTitle ?? "Checkout", second: "Project")
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 6)
        }
    }

    private func scopeSegments(first: String, second: String) -> some View {
        Picker("Scope", selection: $scope) {
            Text(first).tag(SourceControlScope.tree)
            Text(second).tag(SourceControlScope.project)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Source control scope")
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ target: SourceControlTarget?) -> some View {
        if let target {
            switch scope {
            case .tree:
                SourceControlChangesView(
                    model: model, graphModel: graphModel, preview: preview,
                    target: target, pin: $pin, collapsed: $collapsed, folderOverrides: $folderOverrides,
                    filter: $filter, selection: $selection,
                    openDiff: openDiff, pickBranch: { branchPickerOpen = true },
                    toggleCollapsed: toggleCollapsed)
            case .project:
                SourceControlProjectView(
                    project: project, projectName: bridge.projectName ?? "project",
                    collapsed: collapsed, toggleCollapsed: toggleCollapsed,
                    tabName: tabName(forSlug:),
                    mergeAll: { confirmation = .mergeAll },
                    merge: { project.merge(slug: $0) },
                    view: viewWorktree,
                    drop: { slug, branch in confirmation = .drop(slug: slug, branch: branch) })
            }
        } else {
            PaneEmptyView(state: .noProject("changes"))
        }
    }

    private func toggleCollapsed(_ id: String) {
        collapsed = SourceControlCollapse.toggled(id, in: collapsed)
        UserDefaults.standard.set(SourceControlCollapse.encode(collapsed), forKey: Self.collapsedKey)
    }

    private func tabName(forSlug slug: String) -> String? {
        let registry = SessionRegistry.shared
        guard let id = registry.fleetSessionIds.first(where: { registry.entry($0)?.tree?.slug == slug }) else { return nil }
        return registry.displayName(id)
    }

    private func viewWorktree(_ w: WorktreeEntry, name: String) {
        pin = .worktree(path: w.path, branch: w.branch, name: name)
        scope = .tree
    }

    private func openDiff(_ item: ChangeItem) {
        guard let cwd = model.loadedCwd else { return }
        diffSheet = DiffSheetModel(cwd: cwd, relativePath: item.path, initialMode: item.group == .staged ? .staged : .working)
    }

    // MARK: Project confirmations

    private var confirmationText: SourceControlConfirmText? {
        switch confirmation {
        case .mergeAll:
            return SourceControlConfirmText.mergeAll(
                readyCount: project.lines.filter { $0.state == "ready" }.count,
                targetBranch: project.repos.first(where: { $0.isMain })?.branch)
        case .sweep:
            return SourceControlConfirmText.sweep(spentCount: WorktreeSections.integration(project.lines).spentCount)
        case .drop(_, let branch):
            return SourceControlConfirmText.dropCheckout(branch: branch)
        case nil:
            return nil
        }
    }

    private func isDestructive(_ c: ProjectConfirmation) -> Bool {
        switch c {
        case .mergeAll: return false
        case .sweep, .drop: return true
        }
    }

    private func run(_ c: ProjectConfirmation) {
        switch c {
        case .mergeAll: project.mergeAll()
        case .sweep: project.sweep()
        case .drop(let slug, _): project.dropCheckout(slug: slug)
        }
    }

    // MARK: Banners

    @ViewBuilder
    private var banners: some View {
        if let err = model.runner.lastError {
            PaneNoticeStrip(notice: PaneNotice(kind: .error, text: err), onDismiss: { model.runner.dismissError() })
                .padding(.bottom, 4)
        } else if let note = model.runner.lastNote, !note.isEmpty {
            PaneNoticeStrip(notice: PaneNotice(kind: .success, text: note), onDismiss: { model.runner.dismissNote() })
                .padding(.bottom, 4)
        }
        if let err = model.lastError {
            PaneNoticeStrip(notice: PaneNotice(kind: .error, text: "Status fetch error: \(err)"), onDismiss: { model.dismissStatusError() })
                .padding(.bottom, 4)
        }
    }
}

/// Identifiable wrapper for the diff-sheet model — `.sheet(item:)` needs
/// Identifiable and `DiffSheetModel` is a `@MainActor` class, so the id is
/// captured from its immutable fields at construction.
struct DiffSheetItem: Identifiable {
    let model: DiffSheetModel
    let id: String

    init(model: DiffSheetModel) {
        self.model = model
        self.id = "\(model.cwd):\(model.relativePath)"
    }
}

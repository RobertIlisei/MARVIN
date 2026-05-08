// SourceControlView — Phase 3e. Native equivalent of the web
// `<SourceControlPanel>` (sidecar/src/components/source-control/
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

    /// Phase 3g — commit message input. Bound by ChatPreviewModel-
    /// style Bindable in the view; reset to "" after a successful
    /// commit. Persisted only in-memory; users can copy from here
    /// to a notes file if they want to preserve a draft across
    /// app restarts.
    var commitMessage: String = ""

    /// Phase 3g — row-level action in flight (stage / unstage /
    /// discard / commit). Tracked by repo-relative path + verb so
    /// the row can show a per-row spinner and the panel can disable
    /// the global commit button while individual rows mutate.
    private(set) var inFlightOps: Set<String> = []

    /// Phase 3g — confirm dialog state. When non-nil, the SCM panel
    /// presents `GitConfirmSheet`; the user's response triggers the
    /// stored `onConfirm` callback (which mints a token + retries
    /// the original mutation). Cleared on dismiss.
    var pendingConfirm: PendingGitConfirm? = nil

    /// Phase 3g — last terminal failure for a mutation. Surfaces as
    /// a banner above the commit area. Cleared when the user
    /// dismisses or starts a new mutation.
    var lastMutationError: String? = nil

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

    // MARK: - Mutations (Phase 3g)

    /// Stage one path — the repo-relative form. The button on the
    /// row passes `relative` directly; SourceControlView strips the
    /// cwd prefix before calling.
    func stage(relative: String) {
        runMutation(verb: "stage", path: relative) { cwd in
            try await FilesService.shared.stage(cwd: cwd, paths: [relative])
        }
    }

    /// Unstage one path. Symmetric with `stage`.
    func unstage(relative: String) {
        runMutation(verb: "unstage", path: relative) { cwd in
            try await FilesService.shared.unstage(cwd: cwd, paths: [relative])
        }
    }

    /// Discard one path. `mode: "staged"` is auto; `mode: "working"`
    /// goes through the confirm gate (the user has to OK the sheet).
    func discard(relative: String, mode: String) {
        runMutation(verb: "discard", path: relative) { cwd in
            try await FilesService.shared.discard(
                cwd: cwd,
                paths: [relative],
                mode: mode
            )
        }
    }

    /// Commit the staged changes with the current `commitMessage`.
    /// No-op when there are no staged files or the message is empty
    /// — the button itself is disabled in those states; this is a
    /// defensive double-check.
    func commit() {
        let trimmed = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !staged.isEmpty else { return }
        runMutation(verb: "commit", path: "") { cwd in
            try await FilesService.shared.commit(
                cwd: cwd,
                message: trimmed,
                amend: false
            )
        } onSuccess: { [weak self] in
            self?.commitMessage = ""
        }
    }

    // MARK: - Remote ops (fetch / pull / push)

    private(set) var remoteOp: String? = nil   // "fetch" | "pull" | "push" — drives header spinner
    var remoteNote: String? = nil              // last success note ("To github.com/…")
    var remoteError: String? = nil             // last remote failure message

    func fetch() {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        runRemoteOp(verb: "fetch") {
            try await FilesService.shared.fetch(cwd: cwd)
        }
    }

    func pull(strategy: String = "ff-only", confirmToken: String? = nil) {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        runRemoteOp(verb: "pull") {
            try await FilesService.shared.pull(cwd: cwd, strategy: strategy, confirmToken: confirmToken)
        }
    }

    func push(confirmToken: String? = nil) {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        runRemoteOp(verb: "push") {
            try await FilesService.shared.push(cwd: cwd, confirmToken: confirmToken)
        }
    }

    private func runRemoteOp(
        verb: String,
        body: @escaping () async throws -> FilesService.GitRemoteOutcome
    ) {
        guard remoteOp == nil else { return }
        remoteOp = verb
        remoteNote = nil
        remoteError = nil
        Task { @MainActor in
            defer { remoteOp = nil }
            do {
                let outcome = try await body()
                switch outcome {
                case .ok(let note):
                    remoteNote = note
                    if let cwd = loadedCwd { refresh(cwd: cwd, force: true) }
                case .needsConfirm(let severity, let reason, let op):
                    presentConfirm(
                        verb: verb,
                        severity: severity,
                        reason: reason,
                        op: op,
                        retry: { [weak self] token in
                            self?.runRemoteWithToken(verb: verb, token: token)
                        }
                    )
                }
            } catch {
                remoteError = "\(verb) failed: \(error.localizedDescription)"
            }
        }
    }

    private func runRemoteWithToken(verb: String, token: String) {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        Task { @MainActor in
            do {
                let outcome: FilesService.GitRemoteOutcome
                switch verb {
                case "pull":
                    outcome = try await FilesService.shared.pull(
                        cwd: cwd, strategy: "rebase", confirmToken: token
                    )
                case "push":
                    outcome = try await FilesService.shared.push(cwd: cwd, confirmToken: token)
                default:
                    return
                }
                if case .ok(let note) = outcome {
                    remoteNote = note
                    refresh(cwd: cwd, force: true)
                }
            } catch {
                remoteError = "\(verb) (confirmed) failed: \(error.localizedDescription)"
            }
        }
    }

    func dismissRemoteError() { remoteError = nil }

    /// Shared mutation runner. Tracks in-flight state, surfaces
    /// confirm-class results into `pendingConfirm`, refreshes the
    /// status feed on success, and writes errors into
    /// `lastMutationError`. Each public method above wires its
    /// closure + verb here so the bookkeeping stays in one place.
    private func runMutation(
        verb: String,
        path: String,
        body: @escaping (_ cwd: String) async throws -> FilesService.GitMutationOutcome,
        onSuccess: (() -> Void)? = nil
    ) {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        let opKey = "\(verb):\(path)"
        if inFlightOps.contains(opKey) { return }
        inFlightOps.insert(opKey)
        lastMutationError = nil
        Task { @MainActor in
            defer { inFlightOps.remove(opKey) }
            do {
                let outcome = try await body(cwd)
                switch outcome {
                case .ok:
                    onSuccess?()
                    refresh(cwd: cwd, force: true)
                case .needsConfirm(let severity, let reason, let op):
                    presentConfirm(
                        verb: verb,
                        severity: severity,
                        reason: reason,
                        op: op,
                        retry: { [weak self] token in
                            self?.runMutationWithToken(
                                verb: verb,
                                path: path,
                                token: token,
                                body: body,
                                onSuccess: onSuccess
                            )
                        }
                    )
                }
            } catch {
                lastMutationError = "\(verb) failed: \(error)"
            }
        }
    }

    /// Retry the same mutation with the X-Marvin-Confirmed token.
    /// Called by the GitConfirmSheet's confirm handler after a
    /// successful mint round-trip. We re-issue the original closure
    /// — but FilesService's per-method API takes the token directly
    /// (the closure form here doesn't), so each verb gets a small
    /// re-issue here. Less elegant than a single dispatcher but
    /// keeps each method's request shape explicit.
    private func runMutationWithToken(
        verb: String,
        path: String,
        token: String,
        body: @escaping (_ cwd: String) async throws -> FilesService.GitMutationOutcome,
        onSuccess: (() -> Void)?
    ) {
        guard let cwd = loadedCwd, !cwd.isEmpty else { return }
        Task { @MainActor in
            do {
                let outcome: FilesService.GitMutationOutcome
                switch verb {
                case "discard":
                    // Path-keyed retries — the closure already
                    // captures `relative` for discard; the only
                    // mutation that needs a token retry today is
                    // discard with mode=working. Re-call with token.
                    outcome = try await FilesService.shared.discard(
                        cwd: cwd,
                        paths: [path],
                        mode: "working",
                        confirmToken: token
                    )
                case "commit":
                    let msg = commitMessage.trimmingCharacters(
                        in: .whitespacesAndNewlines
                    )
                    outcome = try await FilesService.shared.commit(
                        cwd: cwd,
                        message: msg,
                        amend: false,
                        confirmToken: token
                    )
                default:
                    NSLog("[SourceControl] unexpected confirm retry verb=\(verb)")
                    return
                }
                switch outcome {
                case .ok:
                    onSuccess?()
                    refresh(cwd: cwd, force: true)
                case .needsConfirm:
                    // The token was supposed to satisfy the gate.
                    // If we still get a needs-confirm, something
                    // changed under us — surface the failure rather
                    // than loop.
                    lastMutationError =
                        "\(verb) still needs confirmation after token mint"
                }
            } catch {
                lastMutationError = "\(verb) (with token) failed: \(error)"
            }
        }
    }

    /// Mint a token from /api/git/confirm, then call `retry(token)`
    /// once it lands. Errors surface inline via `lastMutationError`.
    private func presentConfirm(
        verb: String,
        severity: String,
        reason: String,
        op: ChatJSON,
        retry: @escaping (String) -> Void
    ) {
        guard let cwd = loadedCwd else { return }
        // Pull a paths preview out of the op echo so the sheet can
        // show what's about to happen. Safe-falls to empty list.
        let pathsPreview: [String] = {
            guard case let .object(dict) = op,
                  let pathsField = dict["paths"],
                  case let .array(items) = pathsField else { return [] }
            return items.compactMap {
                if case let .string(s) = $0 { return s } else { return nil }
            }
        }()
        pendingConfirm = PendingGitConfirm(
            actionVerb: verb.capitalized,
            reason: reason,
            severity: severity,
            paths: pathsPreview,
            confirm: { [weak self] in
                guard let self else { return }
                self.pendingConfirm = nil
                Task { @MainActor in
                    do {
                        let minted = try await FilesService.shared
                            .mintGitConfirmToken(cwd: cwd, op: op)
                        retry(minted.token)
                    } catch {
                        self.lastMutationError =
                            "Token mint failed: \(error)"
                    }
                }
            },
            cancel: { [weak self] in
                self?.pendingConfirm = nil
            }
        )
    }

    func dismissError() {
        lastMutationError = nil
    }
}

/// Pending guarded mutation — drives the GitConfirmSheet. The
/// closures bind to the model's retry/cancel paths so the sheet
/// itself stays state-free.
struct PendingGitConfirm: Identifiable {
    let id = UUID()
    let actionVerb: String
    let reason: String
    let severity: String
    let paths: [String]
    let confirm: () -> Void
    let cancel: () -> Void
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
///   │   ▫ M  sidecar/page.tsx         │
///   │ ▾ Changes (5)                    │
///   │   ▫ M  macos/...                 │
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
            if let err = model.lastMutationError {
                Divider()
                mutationErrorBanner(err)
            }
            if let err = model.remoteError {
                Divider()
                remoteBanner(text: err, isError: true)
            } else if let note = model.remoteNote, !note.isEmpty {
                Divider()
                remoteBanner(text: note, isError: false)
            }
            if let err = model.lastError {
                Divider()
                errorBanner(err)
            }
            if model.response?.enabled == true {
                Divider()
                commitArea
            }
        }
        .frame(minWidth: 200)
        .preferredColorScheme(bridge.preferredColorScheme)
        .onAppear { syncFetchFromBridge() }
        .onChange(of: bridge.projectWorkDir) { _, _ in
            syncFetchFromBridge()
        }
        .onChange(of: model.remoteError) { _, err in
            if err != nil {
                // Auto-dismiss after 6 s so the banner doesn't stick forever.
                Task { try? await Task.sleep(nanoseconds: 6_000_000_000); model.dismissRemoteError() }
            }
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
        // Phase 3g — guarded-mutation confirm sheet. Driven by
        // model.pendingConfirm; the user's response (confirm /
        // cancel) is carried via the closures stored on the
        // PendingGitConfirm value.
        .sheet(item: Bindable(model).pendingConfirm) { pending in
            GitConfirmSheet(
                actionVerb: pending.actionVerb,
                reason: pending.reason,
                severity: pending.severity,
                paths: pending.paths,
                onConfirm: pending.confirm,
                onCancel: pending.cancel
            )
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
                if model.isLoading || model.remoteOp != nil {
                    ProgressView()
                        .controlSize(.small)
                }
                // Fetch
                Button {
                    model.fetch()
                } label: {
                    Image(systemName: "arrow.down.to.line")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(bridge.projectWorkDir == nil || model.remoteOp != nil)
                .help("Fetch from origin")
                // Pull
                Button {
                    model.pull()
                } label: {
                    Image(systemName: "arrow.down.circle")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(bridge.projectWorkDir == nil || model.remoteOp != nil)
                .help("Pull (fast-forward only)")
                // Push
                Button {
                    model.push()
                } label: {
                    Image(systemName: "arrow.up.circle")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(bridge.projectWorkDir == nil || model.remoteOp != nil)
                .help("Push to origin")
                // Refresh
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
                .help("Refresh git status")
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
                        section: label,
                        isInFlight: rowIsInFlight(file),
                        onTap: { openDiff(for: file) },
                        onStage: { mutate(.stage, file) },
                        onUnstage: { mutate(.unstage, file) },
                        onDiscard: { mutate(.discard, file) }
                    )
                    .padding(.horizontal, 8)
                }
            }
        }
    }

    /// Phase 3g — true when any mutation is currently in flight
    /// against this row. Drives the per-row spinner state.
    private func rowIsInFlight(_ file: GitStatusFile) -> Bool {
        let relative = repoRelative(file.path)
        for verb in ["stage", "unstage", "discard"] {
            if model.inFlightOps.contains("\(verb):\(relative)") { return true }
        }
        return false
    }

    /// Available row actions. Routed through one helper so the row
    /// view doesn't have to plumb three closures separately.
    private enum RowAction { case stage, unstage, discard }

    private func mutate(_ action: RowAction, _ file: GitStatusFile) {
        let relative = repoRelative(file.path)
        switch action {
        case .stage:
            model.stage(relative: relative)
        case .unstage:
            model.unstage(relative: relative)
        case .discard:
            // Section determines mode: staged-only changes get
            // mode=staged (auto, just unstages); everything else
            // (working-tree changes, untracked) goes mode=working
            // (confirm-class).
            let mode = (file.workingStatus == "." && file.indexStatus != "."
                ? "staged" : "working")
            model.discard(relative: relative, mode: mode)
        }
    }

    /// Strip the cwd prefix to produce a repo-relative path. Same
    /// helper SourceControlRow uses internally; kept here so the
    /// View → Model boundary speaks repo-relative paths.
    private func repoRelative(_ path: String) -> String {
        let cwd = bridge.projectWorkDir ?? ""
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        if path.hasPrefix(root) {
            return String(path.dropFirst(root.count))
        }
        return path
    }

    /// Phase 3g — commit area pinned at the bottom. Two-line text
    /// editor + Commit button. Disabled when there's nothing staged
    /// (the button label flips to "(no staged changes)" so users
    /// know why) or the message is whitespace-only.
    private var commitArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: Bindable(model).commitMessage)
                .font(.body)
                .frame(minHeight: 56, maxHeight: 96)
                .padding(6)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(nsColor: .textBackgroundColor))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
                        )
                )
                .overlay(alignment: .topLeading) {
                    if model.commitMessage.isEmpty {
                        Text("Commit message")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                Text(commitFooterLabel)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Commit") { model.commit() }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(!commitEnabled)
                    .help("Commit staged changes. ⌘⏎")
            }
        }
        .padding(10)
    }

    private var commitEnabled: Bool {
        let trimmed = model.commitMessage.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        return !trimmed.isEmpty
            && !model.staged.isEmpty
            && !model.inFlightOps.contains("commit:")
    }

    private var commitFooterLabel: String {
        if model.inFlightOps.contains("commit:") {
            return "committing…"
        }
        if model.staged.isEmpty {
            return "no staged changes"
        }
        return "\(model.staged.count) staged"
    }

    private func mutationErrorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Mutation failed")
                    .font(.caption.weight(.semibold))
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            Button {
                model.dismissError()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.red.opacity(0.08))
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

    private func remoteBanner(text: String, isError: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isError
                ? "exclamationmark.triangle.fill"
                : "checkmark.circle.fill")
                .foregroundStyle(isError ? Color.orange : Color.green)
            Text(text)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(4)
            Spacer()
            Button {
                model.remoteNote = nil
                model.dismissRemoteError()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
        }
        .padding(10)
        .background((isError ? Color.orange : Color.green).opacity(0.08))
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
/// DiffSheet. Phase 3g adds per-row stage / unstage / discard
/// actions — Stage on Changes/Untracked rows, Unstage on Staged
/// rows, Discard on every row via context menu.
private struct SourceControlRow: View {
    let file: GitStatusFile
    /// Active project's working directory. We strip it from the
    /// per-file absolute path to produce a repo-relative label —
    /// matches what the web SCM panel shows.
    let cwd: String
    /// Section label this row belongs to ("Staged", "Changes",
    /// "Untracked", "Conflicted") — drives which inline action
    /// button shows up. Conflicted rows show no stage/unstage
    /// affordance because the file needs resolving first.
    let section: String
    /// True while a mutation is in flight against this row. The
    /// row dims its inline action button and shows a spinner.
    let isInFlight: Bool
    let onTap: () -> Void
    let onStage: () -> Void
    let onUnstage: () -> Void
    let onDiscard: () -> Void

    @State private var hovering = false

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
            actionButton
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(hovering ? Color.accentColor.opacity(0.06) : .clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: onTap)
        .contextMenu {
            // Phase 3g — context menu surfaces all three actions
            // for both discoverability and keyboard-light flow.
            // Stage / Unstage land contextually in their own sections
            // already, but having them in the menu means a user who
            // missed the inline button doesn't have to scrub for it.
            if section != "Conflicted" {
                if section == "Staged" {
                    Button("Unstage", action: onUnstage)
                } else {
                    Button("Stage", action: onStage)
                }
                Divider()
            }
            Button("View diff…", action: onTap)
            Divider()
            // Discard is destructive — labelled clearly and
            // separated from the auto-class actions above. The
            // confirm sheet (for working-tree mode) re-emphasises
            // the consequence.
            Button(role: .destructive,
                   action: onDiscard) {
                Text(section == "Untracked" ? "Delete file…" : "Discard changes…")
            }
        }
        .accessibilityIdentifier("scm-row:\(file.path)")
    }

    /// Inline action button — visible when the row is hovered, or
    /// always when an op is in flight. Stage/Unstage are the
    /// affordances; discard stays in the context menu only because
    /// it's destructive and warrants a deliberate two-step.
    @ViewBuilder
    private var actionButton: some View {
        if isInFlight {
            ProgressView().controlSize(.small)
        } else if section == "Conflicted" {
            // Conflicted rows surface no inline action — resolve
            // first, then stage. The diff sheet still opens via
            // tap so the user can see what's in conflict.
            EmptyView()
        } else if section == "Staged" {
            Button {
                onUnstage()
            } label: {
                Image(systemName: "minus")
                    .imageScale(.small)
            }
            .buttonStyle(.borderless)
            .opacity(hovering ? 1 : 0.35)
            .help("Unstage")
        } else {
            Button {
                onStage()
            } label: {
                Image(systemName: "plus")
                    .imageScale(.small)
            }
            .buttonStyle(.borderless)
            .opacity(hovering ? 1 : 0.35)
            .help("Stage")
        }
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

// SourceControlProjectModel — the Source Control pane's PROJECT scope.
//
// The pane has two scopes (owner, 25.11.2026). The first shows one working
// tree — the selected tab's own, or the project checkout — and its status,
// stage, commit and push belong to THAT tree. This is the second: every tab's
// branch, merge all, reclaim, Prepare MR. Those reconcile every tab's branch
// against the project checkout, so they run on the project root and nowhere
// else, whichever tree the first scope is looking at. Keeping the two in two
// models is the whole guarantee: there is no `cwd` here that a tab selection or
// a pin can change.
//
// The behaviour is the pane's previous worktree section, moved, not rewritten:
// ADR-0103 (state derived from git on every read), ADR-0109 (batch integration,
// local only, an integration outlives the request that started it).

import Foundation
import MARVINLogic
import SwiftUI

@MainActor
@Observable
final class SourceControlProjectModel {
    private(set) var root: String? = nil
    /// Linked worktrees git knows of, the project checkout first.
    private(set) var repos: [GitRepoEntry] = []
    /// Implementer and tab worktrees (ADR-0103), state derived from git server-side.
    private(set) var worktrees: [WorktreeEntry] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    /// Result of the last merge/sweep, shown until dismissed — with its kind,
    /// so a failure never renders like a success.
    var notice: PaneNotice? = nil
    private(set) var busy = false
    private(set) var loadError: String? = nil

    /// ADR-0109 amendment — the running integration, polled from the sidecar. It
    /// is the sidecar's record, not this app's: a Prepare MR outlives the HTTP
    /// request that started it, the app that fired it, and the project being
    /// switched away from.
    private(set) var integrationJob: IntegrationJobEntry? = nil
    /// ADR-0111 — the dry-run verdict per finished branch, keyed by slug.
    var integrationPreview: [String: IntegrationPreviewRow] = [:]

    /// Something changed the project checkout (a merge landed): the first scope
    /// reloads if it is looking at it.
    var onIntegrated: (() -> Void)? = nil

    private var fetchTask: Task<Void, Never>?
    private var jobPollTask: Task<Void, Never>?
    private var announcedJobId: String?

    /// True while anything is integrating — the local call, or a run this app
    /// merely found. Both must disable the buttons: two merges into one checkout
    /// is the failure the sidecar refuses, and offering it is worse than not.
    var integrationRunning: Bool { busy || (integrationJob?.running == true) }

    var lines: [WorktreeLine] {
        worktrees.map {
            WorktreeLine(
                slug: $0.slug, branch: $0.branch, task: $0.task, state: $0.state, commits: $0.commits,
                filesChanged: $0.filesChanged, dirty: $0.dirty, checkoutPresent: $0.checkoutPresent,
                mergedInto: $0.mergedInto, lastCommitAt: $0.lastCommitAt, added: $0.added, removed: $0.removed)
        }
    }

    var readyCount: Int { lines.filter { $0.state == "ready" }.count }

    /// Worktrees git lists that MARVIN does not manage — made by hand, or by
    /// another tool. Read-only rows; the tab and implementer ones are above.
    var unmanagedRepos: [GitRepoEntry] {
        // Compared as resolved paths: the sidecar and git may spell one folder two ways (/tmp, /private/tmp).
        func resolved(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().path }
        let managed = Set(worktrees.map { resolved($0.path) })
        return repos.filter { !$0.isMain && !managed.contains(resolved($0.path)) }
    }

    func clear() {
        fetchTask?.cancel(); fetchTask = nil
        jobPollTask?.cancel(); jobPollTask = nil
        root = nil
        repos = []
        worktrees = []
        notice = nil
        integrationJob = nil
        integrationPreview = [:]
        loadError = nil
        hasLoaded = false
        isLoading = false
    }

    /// The repo and worktree lists. Worktree state needs a synchronous git
    /// reconcile in the sidecar (~1.5 s on 15 trees), so this is NOT called on
    /// every tab switch — only on appear, after a turn, after an action, and when
    /// the project scope is opened.
    func refresh(root: String, force: Bool = false) {
        if self.root != root { clear(); self.root = root }
        if !force, hasLoaded, !isLoading { return }
        fetchTask?.cancel()
        isLoading = true
        loadError = nil
        fetchTask = Task { @MainActor in
            defer { isLoading = false }
            async let repoList = FilesService.shared.fetchRepos(cwd: root)
            async let worktreeList = FilesService.shared.fetchWorktrees(cwd: root)
            let list: WorktreeListResponse?
            do { list = try await worktreeList } catch {
                guard !BenignCancellation.matches(error), !(error is CancellationError) else { return }
                loadError = "\(error)"
                list = nil
            }
            guard !Task.isCancelled, self.root == root else { return }
            repos = (try? await repoList)?.repos ?? repos
            if let list {
                worktrees = list.worktrees ?? []
                hasLoaded = true
                // An integration started before this refresh — by a previous launch
                // of this app, or by the run whose HTTP call timed out — is found
                // here and watched from here.
                if let job = list.job {
                    integrationJob = job
                    if job.running { watchIntegrationJob(root: root) } else { announcedJobId = job.id }
                }
            }
        }
    }

    func refreshIntegrationPreview() {
        guard let root else { return }
        Task { @MainActor in
            if let out = try? await FilesService.shared.previewIntegration(cwd: root), self.root == root {
                integrationPreview = Dictionary(uniqueKeysWithValues: (out.rows ?? []).map { ($0.slug, $0) })
            }
        }
    }

    private func watchIntegrationJob(root: String) {
        jobPollTask?.cancel()
        jobPollTask = Task { @MainActor in
            while !Task.isCancelled {
                guard let res = try? await FilesService.shared.fetchIntegrationJob(cwd: root) else {
                    // A failed poll is not an answer — the sidecar may be busy
                    // holding the event loop with the very git this is reporting
                    // on. Keep watching.
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    continue
                }
                guard !Task.isCancelled, self.root == root else { return }
                integrationJob = res.job
                guard let job = res.job else { return }
                if !job.running {
                    if announcedJobId != job.id {
                        announcedJobId = job.id
                        // The outcome, even when the HTTP call that started it
                        // timed out or was never waited on.
                        notice = PaneNotice(
                            kind: (job.ok ?? false) ? .success : .error,
                            text: IntegrationJobStatus.finishedNotice(ok: job.ok ?? false, summary: job.summary ?? ""))
                        refresh(root: root, force: true)
                        onIntegrated?()
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 1_200_000_000)
            }
        }
    }

    // MARK: - Actions (all on the project root)

    /// Merge one branch into the current branch, locally. Never pushes: on a
    /// pipeline-gated project each pushed branch is a full CI run, while commits
    /// merged where the branch was cut ride along in the pipeline the current
    /// branch already runs.
    func merge(slug: String) {
        guard let root, !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let out = try await FilesService.shared.mergeWorktree(cwd: root, slug: slug)
                notice = PaneNotice(kind: out.ok == true ? .success : .warning, text: out.message ?? out.error ?? "Merge finished.")
            } catch {
                notice = PaneNotice(kind: .error, text: "Merge failed: \(error)")
            }
            refresh(root: root, force: true)
            onIntegrated?()
        }
    }

    /// Fold every finished branch into the current branch in one pass, locally
    /// (ADR-0109). One trip instead of N: the friction of merging one at a time
    /// is what pushes people toward a merge request per branch, which is the
    /// expensive path.
    func mergeAll() {
        guard let root, !integrationRunning else { return }
        busy = true
        notice = nil
        watchIntegrationJob(root: root)
        Task { @MainActor in
            defer { busy = false }
            do {
                let out = try await FilesService.shared.mergeAllWorktrees(cwd: root)
                var lines: [String] = [out.message ?? out.error ?? "Merge finished."]
                // Name what was passed over. "It did nothing" and "there was
                // nothing to do" must not read the same.
                for s in out.skipped ?? [] { lines.append("skipped \(s.branch): \(s.reason)") }
                notice = PaneNotice(kind: out.stopped != nil ? .warning : .success, text: lines.joined(separator: "\n"))
            } catch {
                notice = PaneNotice(kind: .error, text: "Merge all failed: \(error)")
            }
            refresh(root: root, force: true)
            onIntegrated?()
        }
    }

    /// Squash the chosen finished branches into one commit on an `mr/…` branch,
    /// and push / open the merge request when the sheet said so. The tab
    /// branches are untouched; the user's checkout is never entered.
    func prepareMergeRequest(slugs: [String], name: String, message: String, push: Bool, openMergeRequest: Bool) {
        guard let root, !integrationRunning else { return }
        busy = true
        notice = nil
        // The watch, not the reply, is what reports this run: the squash commit
        // runs the project's hooks and can outlive the request.
        watchIntegrationJob(root: root)
        Task { @MainActor in
            defer { busy = false }
            do {
                let out = try await FilesService.shared.prepareMergeRequest(
                    cwd: root, slugs: slugs, name: name, message: message,
                    push: push, openMergeRequest: openMergeRequest)
                var lines: [String] = [out.summary ?? out.error ?? "Done."]
                for s in out.skipped ?? [] { lines.append("skipped \(s.branch): \(s.reason)") }
                notice = PaneNotice(
                    kind: out.ok != true ? .warning : (out.stopped != nil ? .warning : .success),
                    text: lines.joined(separator: "\n"))
                if let url = out.pushed?.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(url) }
            } catch FilesServiceError.transport(let underlying) where (underlying as? URLError)?.code == .timedOut {
                // The sidecar keeps going when the client stops waiting; the
                // outcome is in its log and the branch appears on refresh.
                notice = PaneNotice(kind: .warning, text: "Prepare MR is taking longer than the app waited — the project's commit hooks are probably still running in the sidecar. Refresh in a minute: the mr/ branch appears once the squash commit lands, and ~/Library/Logs/MARVIN/sidecar.log has the outcome.")
            } catch {
                notice = PaneNotice(kind: .error, text: "Prepare MR failed: \(error)")
            }
            refresh(root: root, force: true)
        }
    }

    /// Remove one checkout, keeping its branch — the ADR-0081 semantics.
    func dropCheckout(slug: String) {
        guard let root, !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let out = try await FilesService.shared.dropWorktree(cwd: root, slug: slug)
                notice = PaneNotice(kind: out.ok == true ? .success : .warning, text: out.message ?? out.error ?? "Checkout removed.")
            } catch {
                notice = PaneNotice(kind: .error, text: "Drop failed: \(error)")
            }
            refresh(root: root, force: true)
        }
    }

    /// Reclaim empty and merged worktrees. Never touches a `ready` branch or any
    /// checkout holding uncommitted work.
    func sweep() {
        guard let root, !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let out = try await FilesService.shared.sweepWorktrees(cwd: root)
                let swept = out.swept ?? []
                notice = swept.isEmpty
                    ? PaneNotice(kind: .info, headline: "Nothing to reclaim.")
                    : PaneNotice(
                        kind: .success,
                        headline: "Reclaimed \(swept.count) checkout\(swept.count == 1 ? "" : "s").",
                        detail: swept.map { "\($0.slug): \($0.reason)" }.joined(separator: "\n"))
            } catch {
                notice = PaneNotice(kind: .error, text: "Sweep failed: \(error)")
            }
            refresh(root: root, force: true)
        }
    }
}

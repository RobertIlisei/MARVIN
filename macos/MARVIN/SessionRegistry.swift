// SessionRegistry — the one place that knows about EVERY chat session of the
// active project, not just the one on screen (ADR-0107).
//
// `ChatPreviewModel` holds selected-session state: messages, confirms, plans,
// the strips. It used to also hold the open-tab list as a bare `[String]`
// with no per-tab state, which is why a session that needed an answer,
// failed, or finished was invisible until you switched to it. The registry
// owns the tab set and a per-session ledger fed by the project-wide announce
// stream plus a cold-start snapshot, so tab dots, the dock badge and the
// Sessions pane are cheap observers over it. One transcript stays on screen;
// the brain keeps describing the selected session (BrainStateGate).
//
// Persistence: `marvin.chatTabs.<pid>` — a NEW key. The old one collided
// with the editor's file tabs (see `ChatTabsMigration`).

import Foundation
import MARVINLogic

@MainActor
@Observable
final class SessionRegistry {
    static let shared = SessionRegistry()

    /// Project the registry is scoped to. Tabs are per project.
    private(set) var projectId: String?
    /// Open chat tabs, in strip order. Persisted.
    private(set) var openTabs: [String] = []
    /// Tabs minted in this process that have not sent a turn yet. A draft
    /// has no transcript on disk, so the "drop ids that are not on disk"
    /// reconcile must leave it alone.
    private(set) var draftIds: Set<String> = []
    /// Per-session state, every session of the project.
    private(set) var ledger = SessionLedger()
    /// True while the project feed is attached.
    private(set) var feedConnected = false
    /// A clock for "4m ago" and idle collapse. Ticked from a Task, never from
    /// inside a layout pass (ADR-0062).
    private(set) var now = Date()

    private var feedTask: Task<Void, Never>?
    private var clockTask: Task<Void, Never>?

    private init() {}

    // MARK: - Lifecycle

    /// Bind to a project: load (and migrate) its tab set, take a snapshot,
    /// attach to the project feed. Idempotent per project.
    func start(projectId pid: String) {
        guard projectId != pid else { return }
        stop()
        projectId = pid
        loadOpenTabs(projectId: pid)
        loadReviewed(projectId: pid)
        loadGroupCollapse(projectId: pid)
        for id in openTabs { ledger.ensure(id) }
        refreshSnapshot()
        ensureFeed(projectId: pid)
        ensureClock()
        SupervisorModel.shared.start(projectId: pid)
        BacklogLiveStore.shared.start(projectId: pid)
    }

    func stop() {
        feedTask?.cancel()
        feedTask = nil
        clockTask?.cancel()
        clockTask = nil
        BacklogLiveStore.shared.stop()
        stateRefreshTask?.cancel()
        stateRefreshTask = nil
        feedConnected = false
        projectId = nil
        openTabs = []
        draftIds.removeAll()
        reviewedAt = [:]
        groupCollapse = SessionGroupCollapse()
        reviewUndo = nil
        undoExpiry?.cancel()
        dismissedCutOffs = []
        firstMessages = [:]
        snapshotSeen = []
        ledger = SessionLedger()
    }

    // MARK: - Reading

    func entry(_ id: String) -> SessionEntry? { ledger[id] }

    func rowState(_ id: String) -> SessionRowState {
        guard let e = ledger[id] else { return draftIds.contains(id) ? .draft : .idle }
        return SessionRowStateDeriver.derive(e, unreviewed: isUnreviewed(e))
    }

    // MARK: - Finished, not yet reviewed (W-08)

    /// When the person last looked at each tab. Persisted per project beside
    /// the tab set (`marvin.reviewed.<pid>`): a restart must not turn every
    /// tab back into "not looked at".
    private(set) var reviewedAt: [String: Date] = [:]
    /// When the rule first ran for this project: turns that ended before it
    /// are not asked for a review (see `FinishedReview.isUnreviewed`).
    private var reviewBaseline = Date()

    /// The tab on screen is being looked at, so it is never "unreviewed". A
    /// session nobody can select (no tab) stops being "unreviewed" by itself
    /// once `FinishedPolicy` says nobody will look: derived from the clock, so
    /// no mark is written and nothing is lost.
    private func isUnreviewed(_ e: SessionEntry) -> Bool {
        if e.id == MarvinBridge.shared.activeMarvinSessionId { return false }
        if FinishedPolicy.isSettled(hasTab: isOpenTab(e.id), merged: e.isMergedOrGone, endedAt: e.lastTurnAt, now: now) { return false }
        return FinishedReview.isUnreviewed(lastTurnAt: e.lastTurnAt, reviewedAt: reviewedAt[e.id], baseline: reviewBaseline)
    }

    /// Record that the person has seen the tab as it is now.
    func markReviewed(_ id: String) {
        guard projectId != nil,
              let seen = ReviewMarks.mark(existing: reviewedAt[id], lastTurnAt: ledger[id]?.lastTurnAt, now: Date()) else { return }
        reviewedAt[id] = seen
        persistReviewed()
    }

    /// The last bulk review, until it expires or is undone. The pane offers
    /// Undo while it is set.
    private(set) var reviewUndo: (count: Int, undo: ReviewUndo)?
    private var undoExpiry: Task<Void, Never>?
    /// How long Undo is offered.
    private static let undoWindow: UInt64 = 8_000_000_000

    /// Mark these sessions reviewed in one step. Writes reviewed marks and
    /// nothing else: no tab is closed, no worktree touched.
    func markAllReviewed(_ ids: [String]) {
        guard projectId != nil else { return }
        let out = ReviewMarks.markAll(ids: ids, reviewed: reviewedAt, lastTurnAt: { self.ledger[$0]?.lastTurnAt }, now: Date())
        guard !out.undo.isEmpty else { return }
        reviewedAt = out.reviewed
        persistReviewed()
        reviewUndo = (out.undo.changes.count, out.undo)
        undoExpiry?.cancel()
        undoExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.undoWindow)
            guard !Task.isCancelled else { return }
            self?.reviewUndo = nil
        }
    }

    func undoMarkAllReviewed() {
        guard let pending = reviewUndo else { return }
        reviewedAt = ReviewMarks.undo(pending.undo, reviewed: reviewedAt)
        persistReviewed()
        undoExpiry?.cancel()
        reviewUndo = nil
    }

    // MARK: - Group collapse (remembered per project)

    private(set) var groupCollapse = SessionGroupCollapse()

    func isGroupCollapsed(_ id: SessionGroupId) -> Bool { groupCollapse.isCollapsed(id) }

    func setGroup(_ id: SessionGroupId, collapsed: Bool) {
        groupCollapse.set(id, collapsed: collapsed)
        persistGroupCollapse()
    }

    func toggleGroup(_ id: SessionGroupId) {
        groupCollapse.toggle(id)
        persistGroupCollapse()
    }

    private func loadGroupCollapse(projectId pid: String) {
        groupCollapse = SessionGroupCollapse(stored: UserDefaults.standard.stringArray(forKey: SessionGroupCollapse.storageKey(projectId: pid)))
    }

    private func persistGroupCollapse() {
        guard let pid = projectId else { return }
        UserDefaults.standard.set(groupCollapse.stored, forKey: SessionGroupCollapse.storageKey(projectId: pid))
    }

    /// Selection moved: the tab being left was seen up to now, the one
    /// arrived at is seen now. Called from the one funnel the bridge has.
    func noteSelection(from previous: String?, to next: String?) {
        if let previous { markReviewed(previous) }
        if let next { markReviewed(next) }
    }

    /// Confirms and questions waiting on the user, across every session.
    var needsYouCount: Int { ledger.needsYouCount }

    /// Open tabs plus every other session the feed reports as working, waiting,
    /// needing the person, failed, cut off or finished and not yet looked at —
    /// the sessions the Sessions pane lists, the status bar counts, the rail
    /// badge counts and "next tab that needs me" walks (W-06, R2-01). This was
    /// "open tabs plus a running turn", so a session started elsewhere dropped
    /// out of all four the moment it began to wait.
    var fleetSessionIds: [String] {
        SessionFleet.memberIds(openTabs: openTabs, entries: Array(ledger.entries.values), state: { rowState($0.id) })
    }

    /// Working / waiting / needs-you / long waits / finished-unreviewed over `fleetSessionIds`.
    var fleet: FleetCounts {
        SessionFleet.counts(fleetSessionIds.map {
            FleetItem(state: rowState($0), waitingSince: ledger[$0]?.waitSince, hasTab: isOpenTab($0), endedAt: ledger[$0]?.lastTurnAt)
        }, now: now)
    }

    /// Whether the session is a tab in the strip. A fleet member that is not
    /// one is opened by selecting it (`openTab` runs on the select request).
    func isOpenTab(_ id: String) -> Bool { openTabs.contains(id) }

    // MARK: - One name per session (R2-02)

    /// What each session was opened with, from the session list. The tab strip
    /// names a tab from this, so the pane, the overflow list, notifications and
    /// the restart banner do too.
    private(set) var firstMessages: [String: String] = [:]
    /// Sessions some snapshot has listed (see `refreshStates`).
    private var snapshotSeen: Set<String> = []

    /// The name every surface prints for a session. `fallbackTitle` is for a
    /// session this registry has no title for (the supervisor inbox keeps one).
    func displayName(_ id: String, fallbackTitle: String? = nil) -> String {
        let e = ledger[id]
        return SessionDisplayName.make(
            id: id,
            isDraft: e?.isDraft ?? draftIds.contains(id),
            firstMessage: firstMessages[id],
            title: e?.title ?? fallbackTitle,
            branch: e?.worktree?.branch ?? e?.tree?.branch
        )
    }

    // MARK: - A restart leaves a trace (R-01)

    /// Interrupted sessions the person has dismissed from the banner. In
    /// memory only: a relaunch that still finds them cut off says so again.
    private var dismissedCutOffs: Set<String> = []

    var interruptedTabIds: [String] { fleetSessionIds.filter { rowState($0) == .interrupted } }

    /// Sessions a restart cut off that the banner still names.
    var restartCutOffs: [String] {
        SessionRestartTrace.pending(interrupted: interruptedTabIds, acknowledged: dismissedCutOffs)
    }

    func dismissRestartBanner() { dismissedCutOffs.formUnion(interruptedTabIds) }

    // MARK: - The next tab that needs the person (M-02)

    /// The session one press of "Next Tab That Needs Me" lands on, nil when
    /// there is none to go to (which also disables the command). A fleet member
    /// that is not a tab is opened by the select request (R2-01).
    var nextTabNeedingMe: String? {
        let tabs = fleetSessionIds.map { id -> AttentionCandidate in
            let e = ledger[id]
            return AttentionCandidate(id: id, state: rowState(id), waitingSince: e?.waitSince, endedAt: e?.lastTurnAt)
        }
        return SessionAttentionOrder.next(after: MarvinBridge.shared.activeMarvinSessionId, in: tabs)
    }

    // MARK: - Tabs

    func isDraft(_ id: String) -> Bool { draftIds.contains(id) }

    /// Add a session to the strip (idempotent, appends right).
    func openTab(_ id: String) {
        ledger.ensure(id, draft: draftIds.contains(id))
        guard !openTabs.contains(id) else { return }
        openTabs.append(id)
        persistOpenTabs()
    }

    /// Remove a tab. Returns the neighbour to select when the closed tab was
    /// the active one (right neighbour, else the new last), nil when none remain.
    @discardableResult
    func closeTab(_ id: String) -> String? {
        let next = ChatTabsMigration.neighbour(after: id, in: openTabs)
        openTabs.removeAll { $0 == id }
        draftIds.remove(id)
        ledger.markClosed(id)
        persistOpenTabs()
        return next
    }

    /// A brand-new tab with a client-minted id. The server accepts a
    /// client-supplied `marvinSessionId` on the first message, so the tab
    /// exists — and can carry a tree mode — before anything is typed.
    func mintDraft() -> String {
        let id = UUID().uuidString.lowercased()
        draftIds.insert(id)
        ledger.ensure(id, draft: true)
        openTab(id)
        return id
    }

    /// The first turn landed: the draft is a real session now.
    func promoteDraft(_ id: String) {
        draftIds.remove(id)
    }

    /// Drop persisted ids that no longer exist on disk — except drafts, which
    /// never do until their first turn. Called with the freshly fetched
    /// session list so a tab deleted or archived elsewhere does not linger.
    /// Also joins titles, which the snapshot may lack for old sessions.
    func reconcileTabs(with summaries: [SessionSummary]) {
        let onDisk = Set(summaries.map(\.sessionId))
        let kept = openTabs.filter { onDisk.contains($0) || draftIds.contains($0) }
        if kept != openTabs {
            openTabs = kept
            persistOpenTabs()
        }
        for s in summaries where openTabs.contains(s.sessionId) {
            if ledger[s.sessionId]?.title == nil, let first = s.firstUserMessage, !first.isEmpty {
                ledger.setTitle(s.sessionId, title: first)
            }
        }
        // R2-02 — every session's first message, tab or not: a fleet row for a
        // session with no tab is named the way the strip would name it.
        var names: [String: String] = [:]
        for s in summaries {
            if let first = s.firstUserMessage, !first.isEmpty { names[s.sessionId] = first }
        }
        if names != firstMessages { firstMessages = names }
    }

    // MARK: - Feed + snapshot

    func refreshSnapshot() {
        refreshStates()
        refreshClaims()
    }

    /// ADR-0113 — what each tab holds in the backlog, for the row subtitle.
    /// Also re-read whenever the backlog store hears a change (ADR-0044
    /// addendum): a claim made or released elsewhere shows without a restart.
    func refreshClaims() {
        guard let pid = projectId else { return }
        Task { @MainActor in
            guard let cwd = MarvinBridge.shared.projectWorkDir,
                  let items = try? await BacklogService.shared.fetch(workDir: cwd, status: "doing"),
                  self.projectId == pid else { return }
            var map: [String: [String]] = [:]
            for i in items {
                if let by = i.claimedBy, !by.isEmpty { map[by, default: []].append(i.title) }
            }
            self.claimsBySession = map
        }
    }

    /// Re-read every open tab's row from the sidecar. A tab's wait (its job or
    /// wakeup) exists only in this read — no feed event carries it — so it is
    /// repeated when a turn ends and on a slow clock (S-01).
    func refreshStates() {
        guard let pid = projectId else { return }
        // R2-01 — the fleet, not only the tabs: a session with no tab is read
        // too (the sidecar adds every live and recent one regardless).
        let ids = fleetSessionIds
        Task { @MainActor in
            guard let rows = await ChatService.shared.fetchSessionWatch(projectId: pid, ids: ids),
                  self.projectId == pid else { return }
            self.ledger.apply(snapshot: rows, now: Date())
            // A session closed from another client no longer comes back in the
            // snapshot; without this its last known wait would stay on screen.
            // Only a session an earlier snapshot DID list can vanish: one the
            // feed introduced a moment ago (an `ended` for a session this
            // snapshot was built before) is not gone, merely not listed yet.
            let listed = Set(rows.map(\.marvinSessionId))
            let known = self.ledger.entries.values.filter { self.snapshotSeen.contains($0.id) }
            for id in SessionFleet.vanished(entries: Array(known), openTabs: Set(self.openTabs), inSnapshot: listed) {
                self.ledger.markClosed(id)
            }
            self.snapshotSeen.formUnion(listed)
            self.dismissedCutOffs = SessionRestartTrace.stillAcknowledged(self.dismissedCutOffs, interrupted: self.interruptedTabIds)
            // ADR-0108 — a tab restored from disk has no local posture, but
            // the sidecar recorded one on its last turn. Seed from that so a
            // reopened session comes back in the mode it was left in rather
            // than in the app-wide defaults.
            for row in rows {
                guard let wire = row.posture else { continue }
                // ADR-0127 M6 — an API-set posture newer than ours is adopted
                // over the local record; otherwise the server only seeds.
                if !NativePrefs.shared.adoptAPIPosture(wire, revision: row.postureRevision, source: row.postureSource,
                                                       for: row.marvinSessionId) {
                    NativePrefs.shared.adoptPosture(wire, for: row.marvinSessionId)
                }
            }
        }
    }

    /// ADR-0113 — backlog item titles each session holds (`doing`), by session id.
    private(set) var claimsBySession: [String: [String]] = [:]

    private func ensureFeed(projectId pid: String) {
        feedTask?.cancel()
        feedTask = Task { @MainActor [weak self] in
            var backoffMs: UInt64 = 1_500
            while !Task.isCancelled {
                guard let self, self.projectId == pid else { return }
                do {
                    for try await event in ChatService.shared.liveFeed(projectId: pid) {
                        guard self.projectId == pid else { return }
                        // Connected on attach, not on the first tab event: with
                        // every tab idle none arrives.
                        if !self.feedConnected { self.feedConnected = true; backoffMs = 1_500 }
                        if case .attached = event { continue }
                        self.ledger.apply(event, now: Date())
                        if case .registered = event { self.promoteDraft(event.sessionId) }
                        // ADR-0107 addendum — the brain follows the SELECTED
                        // session's activity from the feed, so switching to a
                        // tab that is mid-tool shows "tool", not a generic busy.
                        if case .activity = event { self.pushBrainState(for: event.sessionId) }
                        // ADR-0127 M6 — a posture set through the API: re-read the
                        // rows now, so the toolbar shows it within this one event.
                        if case .posture = event { self.refreshSnapshot() }
                        // S-01 — the wait a turn armed is known only from a snapshot.
                        if SessionLedger.restatesWait(after: event) { self.scheduleStateRefresh() }
                        // ADR-0127 M6 — an answer from elsewhere (the API, the
                        // supervisor, this pane) closes the chat's sheet or card
                        // on this one event, with who answered.
                        if case let .confirmResolved(sid, _, toolUseId, answeredBy, decision) = event {
                            ChatPreviewModel.shared.noteExternalResolution(sessionId: sid, toolUseId: toolUseId,
                                                                           answeredBy: answeredBy, decision: decision ?? "allow")
                        }
                    }
                } catch {
                    /* fall through to the reconnect wait */
                }
                self.feedConnected = false
                try? await Task.sleep(nanoseconds: backoffMs * 1_000_000)
                backoffMs = min(backoffMs * 2, 15_000)
            }
        }
    }

    private func ensureClock() {
        clockTask?.cancel()
        clockTask = Task { @MainActor [weak self] in
            var ticks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                self?.now = Date()
                // A wait that ends with no turn (a cancelled job) or begins
                // outside one has no event either; a minute is the worst lag.
                ticks += 1
                if ticks % 4 == 0 { self?.refreshStates() }
                // The backlog's safety net (ADR-0044 addendum): the stream is
                // the mechanism, this is for the event that never arrived.
                if ticks % 20 == 0 { BacklogLiveStore.shared.refresh() }
            }
        }
    }

    private var stateRefreshTask: Task<Void, Never>?

    /// Coalesce a burst of `ended` events (a merge train ends several tabs
    /// together) into one read, a moment after the last.
    private func scheduleStateRefresh() {
        stateRefreshTask?.cancel()
        stateRefreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.refreshStates()
        }
    }

    // MARK: - Brain (one slot, described by the selected session — ADR-0107 addendum)

    /// Push the session's known activity into the brain, if it is the one on
    /// screen. `BrainStateGate` drops the write otherwise. A cancel in
    /// progress keeps "cancelling" until the turn actually ends.
    func pushBrainState(for id: String) {
        let bridge = MarvinBridge.shared
        guard bridge.activeMarvinSessionId == id, bridge.marvinState != "cancelling" else { return }
        guard let e = ledger[id] else { return }
        bridge.setMarvinState(e.brainState, forSession: id)
    }

    // MARK: - Local observations (the selected session sees its own events first)

    func noteLocalTurnStarted(id: String, turnId: String) {
        ledger.noteTurnStarted(id, turnId: turnId)
        promoteDraft(id)
    }

    func noteLocalTurnEnded(id: String, outcome: TurnOutcome, costUsd: Double?) {
        ledger.noteTurnEnded(id, outcome: outcome, costUsd: costUsd)
    }

    func noteLocalConfirm(id: String, turnId: String, toolUseId: String, toolName: String) {
        ledger.apply(.confirmPending(sessionId: id, turnId: turnId, toolUseId: toolUseId, toolName: toolName))
    }

    func noteLocalConfirmResolved(id: String, turnId: String, toolUseId: String) {
        ledger.apply(.confirmResolved(sessionId: id, turnId: turnId, toolUseId: toolUseId))
    }

    func noteTree(id: String, tree: SessionTreeWire) {
        ledger.setMode(id, tree: tree)
    }

    func noteDiff(id: String, added: Int, removed: Int, files: Int) {
        ledger.setDiff(id, diff: files > 0 ? SessionDiffSummary(added: added, removed: removed, files: files) : nil)
    }

    func notePlan(id: String, done: Int, total: Int) {
        ledger.setPlan(id, done: done, total: total)
    }

    // MARK: - Integration (ADR-0111)

    /// The latest dry-run of every finished branch against the current
    /// branch, keyed by slug. Refreshed when the Sessions pane shows the
    /// section and after every integration action.
    private(set) var integrationPreview: [String: IntegrationPreviewRow] = [:]
    private(set) var integrationTarget: String? = nil
    private(set) var integrationBusy = false
    var integrationNotice: String? = nil

    /// Closed tabs whose branch still holds work, newest first.
    var readyEntries: [SessionEntry] {
        ledger.entries.values
            .filter { $0.worktree?.state == "ready" }
            .sorted { ($0.closedAt ?? $0.lastTurnAt ?? .distantPast) > ($1.closedAt ?? $1.lastTurnAt ?? .distantPast) }
    }

    func refreshIntegrationPreview() {
        guard let cwd = MarvinBridge.shared.projectWorkDir, !cwd.isEmpty else { return }
        Task { @MainActor in
            do {
                let out = try await FilesService.shared.previewIntegration(cwd: cwd)
                guard MarvinBridge.shared.projectWorkDir == cwd else { return }
                integrationTarget = out.target
                integrationPreview = Dictionary(uniqueKeysWithValues: (out.rows ?? []).map { ($0.slug, $0) })
            } catch {
                NSLog("[SessionRegistry] preview failed: \(error)")
            }
        }
    }

    /// Ask the owning session to bring its branch up to date with the
    /// target, in its own worktree. The feed's `registered` turns the row
    /// working; the next preview shows the result.
    func sync(_ id: String) async {
        guard let pid = projectId else { return }
        integrationBusy = true
        defer { integrationBusy = false }
        do {
            let out = try await SessionMetaService.sync(projectId: pid, sessionId: id)
            integrationNotice = "Sync started: \(out.branch) ← \(out.target)"
        } catch {
            integrationNotice = "Sync refused: \(error.localizedDescription)"
        }
    }

    /// Fold one kept branch into the current branch, locally (ADR-0103 rules).
    func mergeKept(_ id: String) async {
        guard let cwd = MarvinBridge.shared.projectWorkDir, let slug = entry(id)?.worktree?.slug else { return }
        integrationBusy = true
        defer { integrationBusy = false }
        do {
            let out = try await FilesService.shared.mergeWorktree(cwd: cwd, slug: slug)
            integrationNotice = out.message ?? out.error ?? "Merged."
        } catch {
            integrationNotice = "Merge failed: \(error.localizedDescription)"
        }
        refreshSnapshot()
        refreshIntegrationPreview()
    }

    /// Fold every finished branch into the current branch, oldest first,
    /// stopping at the first conflict (ADR-0109).
    func mergeAllKept() async {
        guard let cwd = MarvinBridge.shared.projectWorkDir else { return }
        integrationBusy = true
        defer { integrationBusy = false }
        do {
            let out = try await FilesService.shared.mergeAllWorktrees(cwd: cwd)
            var lines = [out.message ?? out.error ?? "Merge finished."]
            for s in out.skipped ?? [] { lines.append("skipped \(s.branch): \(s.reason)") }
            integrationNotice = lines.joined(separator: "\n")
        } catch {
            integrationNotice = "Merge all failed: \(error.localizedDescription)"
        }
        refreshSnapshot()
        refreshIntegrationPreview()
    }

    /// Delete a kept branch and its checkout. Only ever on an explicit click.
    func discardKept(_ id: String) async {
        guard let pid = projectId else { return }
        integrationBusy = true
        defer { integrationBusy = false }
        do {
            let out = try await SessionMetaService.close(projectId: pid, sessionId: id, action: .discard)
            integrationNotice = out.message ?? "Discarded."
            ledger.remove(id)
        } catch {
            integrationNotice = "Discard failed: \(error.localizedDescription)"
        }
        refreshSnapshot()
        refreshIntegrationPreview()
    }

    /// ADR-0112 — answer a waiting tab's confirm from the Sessions pane. The
    /// confirm route resolves it and announces `confirm.resolved`, which the
    /// feed turns into the row's dot going quiet.
    ///
    /// `sessionId` is the row's, and it is required: `PendingConfirmInfo`
    /// carries a turn and a tool-use id but not a session, so the optimistic
    /// clear used to be written under an empty key. It landed on a phantom
    /// entry, the answered row stayed in *Needs you*, and with the feed down
    /// nothing ever cleared it (2026-09-11).
    func answer(_ c: PendingConfirmInfo, in sessionId: String, allow: Bool) async {
        do {
            try await ChatService.shared.respondToConfirm(
                turnId: c.turnId, toolUseId: c.toolUseId,
                decision: allow ? .allow : .deny,
                denyMessage: allow ? nil : "Denied from the Sessions pane."
            )
            ledger.apply(.confirmResolved(sessionId: sessionId, turnId: c.turnId, toolUseId: c.toolUseId))
        } catch {
            integrationNotice = "Could not answer: \(error.localizedDescription)"
        }
    }

    // MARK: - Actions that need no model

    /// Stop a session's turn from outside its tab (the Sessions pane).
    func stop(_ id: String) async {
        do {
            try await ChatService.shared.cancelTurn(marvinSessionId: id, source: "sessions-pane")
        } catch {
            NSLog("[SessionRegistry] stop failed: \(error)")
        }
    }

    /// Resume a turn a restart cut off (ADR-0107). Server-initiated through
    /// the wakeup path; the feed's `registered` flips the row to working.
    func resume(_ id: String) async {
        guard let pid = projectId else { return }
        do {
            try await SessionMetaService.resume(projectId: pid, sessionId: id)
            ledger.markInterrupted(id, false)
        } catch {
            NSLog("[SessionRegistry] resume failed: \(error)")
        }
    }

    /// Dismiss a session's attention item (a closing question, a chain-cap
    /// refusal; ADR-0130). Sending the tab a message clears it too.
    func dismissAttention(_ id: String) async {
        guard let pid = projectId else { return }
        do {
            try await SessionMetaService.dismissAttention(projectId: pid, sessionId: id)
            ledger.clearAttention(id)
        } catch {
            integrationNotice = "Could not dismiss: \(error.localizedDescription)"
        }
    }

    /// Hide the interrupted banner for this session without resuming.
    func dismissInterrupted(_ id: String) {
        ledger.markInterrupted(id, false)
    }

    /// Reopen a closed tab: clear its closed mark server-side (a kept
    /// worktree returns to `session`) and select it.
    func reopen(_ id: String) async {
        guard let pid = projectId else { return }
        do {
            _ = try await SessionMetaService.reopen(projectId: pid, sessionId: id)
        } catch {
            NSLog("[SessionRegistry] reopen failed: \(error)")
        }
        var e = ledger.ensure(id)
        e.closedAt = nil
        ledger.replace(e)
        openTab(id)
        MarvinBridge.shared.requestChatTab(.select(id))
    }

    // MARK: - Persistence

    private static func chatTabsKey(_ pid: String) -> String { "marvin.chatTabs.\(pid)" }
    private static func legacyKey(_ pid: String) -> String { "marvin.openTabs.\(pid)" }

    private func loadOpenTabs(projectId pid: String) {
        let d = UserDefaults.standard
        // `stringArray` is nil for the editor's `Data` under the legacy key, so
        // the editor's tabs are never mistaken for ours (ChatTabsMigration).
        let r = ChatTabsMigration.resolve(
            newValue: d.stringArray(forKey: Self.chatTabsKey(pid)),
            legacyStringArray: d.stringArray(forKey: Self.legacyKey(pid))
        )
        if r.writeNewKey { d.set(r.tabs, forKey: Self.chatTabsKey(pid)) }
        if r.removeLegacyKey { d.removeObject(forKey: Self.legacyKey(pid)) }
        openTabs = r.tabs
    }

    private static func reviewedKey(_ pid: String) -> String { "marvin.reviewed.\(pid)" }
    private static func reviewBaselineKey(_ pid: String) -> String { "marvin.reviewedBaseline.\(pid)" }

    private func loadReviewed(projectId pid: String) {
        let d = UserDefaults.standard
        if let stored = d.object(forKey: Self.reviewBaselineKey(pid)) as? Double {
            reviewBaseline = Date(timeIntervalSince1970: stored)
        } else {
            // First run of the rule for this project: everything that has
            // already ended counts as seen.
            reviewBaseline = Date()
            d.set(reviewBaseline.timeIntervalSince1970, forKey: Self.reviewBaselineKey(pid))
        }
        let stored = d.dictionary(forKey: Self.reviewedKey(pid)) as? [String: Double] ?? [:]
        reviewedAt = stored.mapValues { Date(timeIntervalSince1970: $0) }
    }

    private func persistReviewed() {
        guard let pid = projectId else { return }
        UserDefaults.standard.set(reviewedAt.mapValues(\.timeIntervalSince1970), forKey: Self.reviewedKey(pid))
    }

    private func persistOpenTabs() {
        guard let pid = projectId else { return }
        // Drafts are process-local: a relaunch must not restore a tab whose
        // transcript never existed.
        let durable = openTabs.filter { !draftIds.contains($0) }
        UserDefaults.standard.set(durable, forKey: Self.chatTabsKey(pid))
    }
}

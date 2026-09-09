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
        for id in openTabs { ledger.ensure(id) }
        refreshSnapshot()
        ensureFeed(projectId: pid)
        ensureClock()
    }

    func stop() {
        feedTask?.cancel()
        feedTask = nil
        clockTask?.cancel()
        clockTask = nil
        feedConnected = false
        projectId = nil
        openTabs = []
        draftIds.removeAll()
        ledger = SessionLedger()
    }

    // MARK: - Reading

    func entry(_ id: String) -> SessionEntry? { ledger[id] }

    func rowState(_ id: String) -> SessionRowState {
        guard let e = ledger[id] else { return draftIds.contains(id) ? .draft : .idle }
        return SessionRowStateDeriver.derive(e)
    }

    /// Confirms and questions waiting on the user, across every session.
    var needsYouCount: Int { ledger.needsYouCount }

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
    }

    // MARK: - Feed + snapshot

    func refreshSnapshot() {
        guard let pid = projectId else { return }
        let ids = openTabs
        Task { @MainActor in
            guard let rows = await ChatService.shared.fetchSessionWatch(projectId: pid, ids: ids),
                  self.projectId == pid else { return }
            self.ledger.apply(snapshot: rows, now: Date())
        }
    }

    private func ensureFeed(projectId pid: String) {
        feedTask?.cancel()
        feedTask = Task { @MainActor [weak self] in
            var backoffMs: UInt64 = 1_500
            while !Task.isCancelled {
                guard let self, self.projectId == pid else { return }
                do {
                    for try await event in ChatService.shared.liveFeed(projectId: pid) {
                        guard self.projectId == pid else { return }
                        if !self.feedConnected { self.feedConnected = true; backoffMs = 1_500 }
                        self.ledger.apply(event, now: Date())
                        if case .registered = event { self.promoteDraft(event.sessionId) }
                        // ADR-0107 addendum — the brain follows the SELECTED
                        // session's activity from the feed, so switching to a
                        // tab that is mid-tool shows "tool", not a generic busy.
                        if case .activity = event { self.pushBrainState(for: event.sessionId) }
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
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                self?.now = Date()
            }
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

    private func persistOpenTabs() {
        guard let pid = projectId else { return }
        // Drafts are process-local: a relaunch must not restore a tab whose
        // transcript never existed.
        let durable = openTabs.filter { !draftIds.contains($0) }
        UserDefaults.standard.set(durable, forKey: Self.chatTabsKey(pid))
    }
}

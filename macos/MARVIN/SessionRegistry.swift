// SessionRegistry — the one place that knows about EVERY chat session of the
// active project, not just the one on screen (ADR-0107).
//
// `ChatPreviewModel` holds selected-session state: messages, confirms, plans,
// the strips. It used to also hold the open-tab list as a bare `[String]`
// with no per-tab state, which is why a session that needed an answer,
// failed, or finished was invisible until you switched to it. The registry
// owns the tab set (and, from M1, a per-session ledger fed by the project-wide
// announce stream) so tab dots, the dock badge and the Sessions pane can be
// cheap observers over it. One transcript stays on screen.
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

    private init() {}

    // MARK: - Lifecycle

    /// Bind to a project: load (and migrate) its tab set. Idempotent per project.
    func start(projectId pid: String) {
        guard projectId != pid else { return }
        projectId = pid
        draftIds.removeAll()
        loadOpenTabs(projectId: pid)
    }

    func stop() {
        projectId = nil
        openTabs = []
        draftIds.removeAll()
    }

    // MARK: - Tabs

    func isDraft(_ id: String) -> Bool { draftIds.contains(id) }

    /// Add a session to the strip (idempotent, appends right).
    func openTab(_ id: String) {
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
        persistOpenTabs()
        return next
    }

    /// A brand-new tab with a client-minted id. The server accepts a
    /// client-supplied `marvinSessionId` on the first message, so the tab
    /// exists — and can carry a tree mode — before anything is typed.
    func mintDraft() -> String {
        let id = UUID().uuidString.lowercased()
        draftIds.insert(id)
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
    func reconcileTabs(with summaries: [SessionSummary]) {
        let onDisk = Set(summaries.map(\.sessionId))
        let kept = openTabs.filter { onDisk.contains($0) || draftIds.contains($0) }
        if kept != openTabs {
            openTabs = kept
            persistOpenTabs()
        }
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

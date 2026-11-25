// BacklogLiveStore — the ONE place the app holds the project's backlog counts
// (ADR-0044 addendum, 2026-11-25).
//
// The chat's "N backlog items parked" strip used to read its number when a
// session or its view was created, and nothing ever refreshed it: other tabs
// file and resolve items all day, and the Project Backlog window writes too.
// Now the sidecar says when the backlog moved — `backlog.changed` on the
// project's announce stream, one debounced event per change of any origin (a
// tool, a route, a hand edit, a git checkout) — and this store reduces those
// events (`BacklogLiveState`, MARVINLogic) into one set of numbers. The strip,
// the window's scope counts, and the sessions' "holds" lines all read it; a
// source guard (`BacklogCountSourceScan`) fails the test suite if a view keeps
// a count of its own.
//
// Safety nets, because a stream can be missed: a plain re-read when the app
// comes back to the front, and every five minutes (SessionRegistry's clock).
// Neither is the mechanism; both are cheap (`GET /api/backlog/counts`).

import AppKit
import Foundation
import MARVINLogic
import Observation

@MainActor
@Observable
final class BacklogLiveStore {
    static let shared = BacklogLiveStore()

    private(set) var state = BacklogLiveState()
    /// The project the numbers belong to.
    private(set) var projectId: String?

    /// The numbers every surface shows.
    var counts: BacklogStatusCounts { state.counts }
    /// Ticks when the numbers were replaced; a view holding a LIST reloads on it.
    var generation: Int { state.generation }
    var hasData: Bool { state.hasData }

    @ObservationIgnored private var activeObserver: NSObjectProtocol?

    private init() {}

    /// Bind to a project (SessionRegistry's lifecycle). Idempotent per project.
    func start(projectId pid: String) {
        guard projectId != pid else { return }
        stop()
        projectId = pid
        activeObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        refresh()
    }

    func stop() {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        activeObserver = nil
        projectId = nil
        state.reset()
    }

    /// An event off the project's announce stream.
    func apply(_ event: BacklogFeedEvent) {
        // A claim made or released elsewhere moves the sessions' "holds" lines too.
        if state.apply(event, project: projectId) { SessionRegistry.shared.refreshClaims() }
    }

    /// Re-read the counts from the sidecar and adopt them. Callers that just
    /// wrote the backlog themselves (a promote, a park) may poke this for an
    /// instant answer; the event follows a moment later and agrees.
    func refresh() {
        guard let pid = projectId, let wd = MarvinBridge.shared.projectWorkDir else { return }
        let before = state.generation
        Task { @MainActor in
            guard let fresh = await BacklogService.shared.counts(workDir: wd), self.projectId == pid else { return }
            // An event that landed while the read was out is newer than it.
            guard self.state.generation == before else { return }
            self.state.adoptRead(fresh)
        }
    }
}

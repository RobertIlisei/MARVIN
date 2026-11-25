// Snapshot fixture for the backlog strip (ADR-0044 addendum, 2026-11-25).
//
// The strip reads `BacklogLiveStore`, which the sidecar feeds with
// `backlog.changed`. A fixture feeds it the same event the announce stream
// carries, so the surface shows what a live app shows after the sidecar spoke.

import Foundation
import MARVINLogic

extension SurfaceFixtures {
    /// Bind the store to the fixture project and hand it a `backlog.changed`
    /// carrying `active` parked items. Each call is a newer revision.
    @MainActor static func feedBacklog(active: Int) {
        // The registry owns the store's lifecycle: start it first, or the view
        // appearing would start it later and reset what is fed here.
        SessionRegistry.shared.start(projectId: "prj_atlas")
        let store = BacklogLiveStore.shared
        let next = max(store.state.revision, 0) + 1
        store.apply(.changed(projectId: "prj_atlas", revision: next, isSnapshot: false,
                             counts: BacklogStatusCounts(provisional: 3, open: active - 3, doing: 0, done: 40, dismissed: 12)))
    }
}

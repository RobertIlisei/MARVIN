// TabNotificationController — feeds the session registry to
// `TabNotificationPlanner` and posts what it decides (UX review N-01).
//
// The planner holds the rules; this holds the three things it must not: the
// observation of the registry, the timer that closes the coalescing window, and
// the two facts about the app (which tab is selected, whether MARVIN is in
// front). It only reads the registry — it never writes it.

import AppKit
import Foundation
import MARVINLogic

@MainActor
final class TabNotificationController {
    static let shared = TabNotificationController()

    private var planner = TabNotificationPlanner()
    private var flushTask: Task<Void, Never>?
    private var started = false

    private init() {}

    /// Idempotent. The first look is a baseline: nothing is announced for how
    /// the tabs already stand.
    func start() {
        guard !started else { return }
        started = true
        planner.observe(snapshot(), now: Date())
        track()
    }

    /// Re-arming observation: `onChange` fires once per arming, just before the
    /// change lands, so the work is hopped to the next main-actor turn and the
    /// registry is read again (which also re-arms).
    private func track() {
        withObservationTracking {
            _ = snapshot()
        } onChange: { [weak self] in
            Task { @MainActor in self?.changed() }
        }
    }

    private func changed() {
        planner.observe(snapshot(), now: Date())
        scheduleFlush()
        track()
    }

    private func scheduleFlush() {
        guard flushTask == nil, let delay = planner.nextFlushDelay(now: Date()) else { return }
        flushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay + 0.05))
            guard let self, !Task.isCancelled else { return }
            self.flushTask = nil
            self.flush()
        }
    }

    private func flush() {
        let out = planner.flush(
            now: Date(),
            current: snapshot(),
            selectedId: ChatPreviewModel.shared.loadedSessionId,
            appIsFrontmost: NSApp.isActive
        )
        for n in out { NotificationManager.shared.post(n) }
        scheduleFlush()
    }

    private func snapshot() -> [TabObservation] {
        let registry = SessionRegistry.shared
        return registry.fleetSessionIds.compactMap { id in
            guard let e = registry.entry(id) else { return nil }
            return TabObservation(
                id: id,
                title: TabNotificationTitle.make(entryTitle: e.title, isDraft: e.isDraft, id: id),
                state: registry.rowState(id),
                outcome: e.lastOutcome
            )
        }
    }
}

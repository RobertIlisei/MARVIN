// HealthMonitor — polls the Node sidecar and exposes its state.
//
// The sidecar's /api/health endpoint returns a JSON blob that
// includes `ok` (bool), `auth.mode`, `claudeBinary`, `binaryError`,
// `model`, and `dataDir`. We surface the fields the user cares
// about during connection; details are passed through verbatim so
// the SwiftUI view can render them.
//
// Polling cadence: 2s when offline (so reconnects feel quick),
// 15s when online (just keep-alive). Cancellation propagates via
// the Task tree so closing the window kills the loop cleanly.

import Foundation
import Observation

/// Connection state machine. The view switches on this; nothing
/// else.
enum SidecarState: Equatable {
    case connecting
    case online(SidecarHealth)
    case offline(reason: String)

    var isOnline: Bool {
        if case .online = self { return true }
        return false
    }

    /// Convenience inverse of isOnline that's stricter — `.connecting`
    /// is treated as neither offline nor online. Phase 1d.35 uses this
    /// so the auto-start gate doesn't fire while the first health
    /// probe is still in flight on cold launch.
    var isOffline: Bool {
        if case .offline = self { return true }
        return false
    }

    /// Tiny label shown next to the toolbar indicator. Phase 1d uses
    /// these — kept terse so they fit the unified title bar without
    /// truncation across realistic window widths.
    var shortLabel: String {
        switch self {
        case .connecting: "connecting"
        case .online: "online"
        case .offline: "offline"
        }
    }
}

/// Subset of /api/health we care about in Phase 0. The sidecar may
/// return more fields; we ignore them.
struct SidecarHealth: Equatable, Codable {
    let ok: Bool
    let auth: Auth?
    let claudeBinary: String?
    let binaryError: String?
    let model: String?
    let dataDir: String?

    struct Auth: Equatable, Codable {
        let mode: String?
        let credentialHint: String?
        let error: String?
    }
}

@Observable
@MainActor
final class HealthMonitor {
    private(set) var state: SidecarState = .connecting

    private let url = ServerConfig.baseURL.appendingPathComponent("api/health")

    private var pollTask: Task<Void, Never>?

    /// Consecutive failed polls since the last success. Drives offline
    /// HYSTERESIS: `ContentView` switches its WHOLE view tree on `state`, so a
    /// single slow `/api/health` (the single-threaded sidecar busy on a turn,
    /// or a per-turn AST graph rebuild blocking the Node event loop) flipping us
    /// to `.offline` tears down + rebuilds the entire IDE — pane layout,
    /// file-tree expansion, terminal, editor all reset. We only demote an
    /// established `.online`/`.connecting` after {@link offlineThreshold}
    /// consecutive misses; the loop polls fast while misses are pending so a
    /// genuine outage still surfaces within a few seconds.
    private var consecutiveFailures = 0
    /// Misses required before tearing the IDE down to the offline view.
    private let offlineThreshold = 3

    func start() async {
        // Start polling. If already started, no-op (start() is also
        // called on relaunch via the SwiftUI .task modifier — idempotent).
        if pollTask != nil { return }
        pollTask = Task { [weak self] in
            await self?.runLoop()
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Force an immediate poll. Bound to ⌘R in MARVINApp.swift.
    func refreshNow() async {
        await pollOnce()
    }

    private func runLoop() async {
        while !Task.isCancelled {
            await pollOnce()
            // Adaptive cadence: shorter while disconnected, longer
            // once we're up and just keeping watch. Using
            // Task.sleep so cancellation interrupts immediately.
            // Fast cadence while disconnected OR while we have unconfirmed
            // misses (so a real outage is still detected within a few seconds
            // despite the offline-hysteresis); slow once steadily healthy.
            let interval: Duration =
                (consecutiveFailures > 0 || state.isOffline) ? .seconds(2) : .seconds(15)
            try? await Task.sleep(for: interval)
        }
    }

    /// Record a failed poll. Only flips an established `.online`/`.connecting`
    /// to `.offline` once `offlineThreshold` misses pile up in a row — until
    /// then we HOLD the current state so a transient blip can't reset the IDE.
    /// An already-offline state keeps refreshing its reason.
    private func recordMiss(_ reason: String) {
        consecutiveFailures += 1
        if consecutiveFailures >= offlineThreshold || state.isOffline {
            state = .offline(reason: reason)
        }
        // else: under threshold + currently connecting/online → hold, no reset.
    }

    private func pollOnce() async {
        var request = URLRequest(url: url)
        // A healthy-but-busy sidecar (mid-turn, or a per-turn AST graph rebuild)
        // can take a couple of seconds to answer; give it headroom so a slow
        // response isn't counted as a miss. Hysteresis covers the rest.
        request.timeoutInterval = 5
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                recordMiss("Sidecar returned a non-HTTP response.")
                return
            }
            guard http.statusCode == 200 else {
                recordMiss("Sidecar returned HTTP \(http.statusCode).")
                return
            }
            let health = try JSONDecoder().decode(SidecarHealth.self, from: data)
            consecutiveFailures = 0
            state = .online(health)
        } catch let urlError as URLError {
            // Specific URLError codes get specific messages — the
            // user gets a real instruction instead of a generic
            // "connection failed".
            let reason: String =
                switch urlError.code {
                case .cannotConnectToHost:
                    "Sidecar isn't running. Start it with `bin/marvin start` in the MARVIN repo, or open the menu bar and pick Reconnect."
                case .timedOut:
                    "Sidecar didn't respond within 3 s. Check `bin/marvin status` to see what state it's in."
                case .networkConnectionLost:
                    "Connection to the sidecar dropped. Auto-retrying."
                default:
                    "Connection failed: \(urlError.localizedDescription)."
                }
            recordMiss(reason)
        } catch {
            recordMiss("Couldn't parse /api/health response: \(error.localizedDescription).")
        }
    }
}

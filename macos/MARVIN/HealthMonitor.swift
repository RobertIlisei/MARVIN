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
            let interval: Duration =
                switch state {
                case .online: .seconds(15)
                default: .seconds(2)
                }
            try? await Task.sleep(for: interval)
        }
    }

    private func pollOnce() async {
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                state = .offline(reason: "Sidecar returned a non-HTTP response.")
                return
            }
            guard http.statusCode == 200 else {
                state = .offline(reason: "Sidecar returned HTTP \(http.statusCode).")
                return
            }
            let health = try JSONDecoder().decode(SidecarHealth.self, from: data)
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
            state = .offline(reason: reason)
        } catch {
            state = .offline(reason: "Couldn't parse /api/health response: \(error.localizedDescription).")
        }
    }
}

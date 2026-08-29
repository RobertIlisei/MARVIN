// CostService — ADR-0021 M3.
// Polls GET /api/cost?projectId= every 30s, replacing the web side's
// `cost-changed` bridge message. Visibility-aware (pauses when the
// app is in the background). Keeps the last-known CostSummary on
// transient errors; clears only after 3 consecutive failures.
// On project switch, clears the stale cost immediately so the UI
// never shows the wrong project's spend.

import Foundation
import AppKit

extension Notification.Name {
    static let marvinTurnCompleted = Notification.Name("marvin.turnCompleted")
    /// Posted by the AppStatusBar context segment when the user clicks
    /// "Reset context for next message". The chat preview model
    /// observes this and arms `resetSdkOnNextSend`. ADR-0022 §3 follow-up.
    static let marvinRequestSdkReset = Notification.Name("marvin.requestSdkReset")
    /// Posted by File → New Session (⌘⇧N). The chat preview view
    /// observes this and starts a fresh session (`model.clear()`).
    static let marvinRequestNewSession = Notification.Name("marvin.requestNewSession")
    /// Posted by View → Backlog (⌘⇧B). Opens the backlog panel.
    ///
    /// The tray chip that used to be the only way in is gated on
    /// `backlogOpenCount > 0`, so a project with an empty backlog had NO route
    /// to the panel at all — and therefore none to the groomer's Review button
    /// either. A menu item is reachable regardless of what's parked.
    static let marvinRequestBacklogPanel = Notification.Name("marvin.requestBacklogPanel")
}

@MainActor
final class CostService {
    static let shared = CostService()

    private var pollingTask: Task<Void, Never>?
    private var currentProjectId: String? = nil
    private var consecutiveFailures: Int = 0

    private init() {}

    // MARK: - External triggers

    /// Called by ProjectsService when the active project changes.
    /// Clears the stale cost summary immediately, then starts polling
    /// the new project.
    func onProjectChanged(to projectId: String) {
        MarvinBridge.shared.costSummary = nil
        currentProjectId = projectId
        consecutiveFailures = 0
        restartPolling()
    }

    // MARK: - Polling

    private func restartPolling() {
        pollingTask?.cancel()
        pollingTask = Task {
            await poll()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                await poll()
            }
        }
    }

    private func poll() async {
        guard NSApp.isActive else { return }
        guard let pid = currentProjectId,
              let encoded = pid.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(ServerConfig.baseURLString)/api/cost?projectId=\(encoded)") else { return }

        do {
            var req = URLRequest(url: url)
            req.setValue("1", forHTTPHeaderField: "x-marvin-client")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }

            struct DailyWire: Codable {
                let day: String; let costUsd: Double; let turns: Int
            }
            struct AggregateWire: Codable {
                let costUsd: Double
                let turns: Int
                let inputTokens: Int
                let outputTokens: Int
            }
            struct Wire: Codable {
                let today: AggregateWire?
                let week: AggregateWire?
                let lifetime: AggregateWire?
                let daily: [DailyWire]?
                let openRouter: CostSummary.OpenRouterBalance?
                let claudeRateLimits: [CostSummary.ClaudeWindow]?
            }
            let w = try JSONDecoder().decode(Wire.self, from: data)
            guard let todayAgg = w.today else {
                MarvinBridge.shared.costSummary = nil
                consecutiveFailures = 0
                return
            }
            MarvinBridge.shared.costSummary = CostSummary(
                today: todayAgg.costUsd,
                week: w.week?.costUsd ?? 0,
                lifetime: w.lifetime?.costUsd ?? 0,
                turns: w.lifetime?.turns ?? 0,
                inputTokens: w.lifetime?.inputTokens ?? 0,
                outputTokens: w.lifetime?.outputTokens ?? 0,
                daily: (w.daily ?? []).map {
                    CostSummary.DailyEntry(day: $0.day, costUsd: $0.costUsd, turns: $0.turns)
                },
                openRouter: w.openRouter,
                claudeWindows: w.claudeRateLimits ?? []
            )
            consecutiveFailures = 0
        } catch {
            consecutiveFailures += 1
            if consecutiveFailures >= 3 {
                MarvinBridge.shared.costSummary = nil
                NSLog("[CostService] 3 consecutive failures, cleared summary: \(error)")
            }
            // Else keep last-known value — transient outage / sidecar restart.
        }
    }
}

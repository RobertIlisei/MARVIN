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

    /// Fetch once, right now, regardless of whether MARVIN is frontmost.
    ///
    /// The 30 s poll is `NSApp.isActive`-gated, which is right for a
    /// background timer and wrong for a panel the user just opened: someone
    /// driving MARVIN from a terminal is never frontmost, so the plan-usage
    /// bars showed whatever was true the last time the app had focus. Seen
    /// 2026-08-30 — `/api/cost` served `five_hour 0.35 / seven_day 0.55`
    /// while the popover still displayed the pre-refresh `49 %` and
    /// "no % yet". Opening a usage panel is a request for current numbers.
    func refreshNow() {
        Task { await poll(force: true) }
    }

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

    /// `/api/cost` → `CostSummary`; nil when the sidecar has no summary yet.
    /// Static so the snapshot harness decodes its fixtures exactly as the app does.
    nonisolated static func decode(_ data: Data) throws -> CostSummary? {
        struct DailyWire: Codable {
            let day: String; let costUsd: Double; let turns: Int
        }
        struct PeriodWire: Codable {
            let costUsd: Double
            let turns: Int
            let inputTokens: Int
            let outputTokens: Int
            let cacheCreationTokens: Int?
            let cacheReadTokens: Int?
            let estimatedTurns: Int?
            let unpricedTurns: Int?
            let byAuthMode: [String: CostSummary.Aggregate]?

            var period: CostSummary.Period {
                CostSummary.Period(
                    total: CostSummary.Aggregate(
                        costUsd: costUsd, turns: turns, inputTokens: inputTokens, outputTokens: outputTokens,
                        cacheCreationTokens: cacheCreationTokens, cacheReadTokens: cacheReadTokens,
                        estimatedTurns: estimatedTurns, unpricedTurns: unpricedTurns),
                    byAuthMode: byAuthMode ?? [:])
            }
        }
        struct ByModelWire: Codable {
            let today: [CostSummary.ModelRow]?
            let week: [CostSummary.ModelRow]?
        }
        struct Wire: Codable {
            let today: PeriodWire?
            let week: PeriodWire?
            let lifetime: PeriodWire?
            let daily: [DailyWire]?
            let byModel: ByModelWire?
            let legacy: CostSummary.Legacy?
            let openRouter: CostSummary.OpenRouterBalance?
            let openRouterKey: CostSummary.OpenRouterKeyUsage?
            let account: CostSummary.Account?
            let claudeRateLimits: [CostSummary.ClaudeWindow]?
        }
        let w = try JSONDecoder().decode(Wire.self, from: data)
        guard let todayAgg = w.today else { return nil }
        var summary = CostSummary(
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
        summary.todayPeriod = todayAgg.period
        summary.weekPeriod = w.week?.period ?? .zero
        summary.lifetimePeriod = w.lifetime?.period ?? .zero
        summary.modelsToday = w.byModel?.today ?? []
        summary.modelsWeek = w.byModel?.week ?? []
        summary.legacy = w.legacy
        summary.openRouterKey = w.openRouterKey
        summary.account = w.account
        return summary
    }

    private func poll(force: Bool = false) async {
        guard force || NSApp.isActive else { return }
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

            MarvinBridge.shared.costSummary = try CostService.decode(data)
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

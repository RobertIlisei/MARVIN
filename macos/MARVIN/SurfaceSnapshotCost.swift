// SurfaceSnapshotCost — the cost popover in each auth mode (2026-10-31).
//
// Each case is an `/api/cost` body decoded by `CostService.decode`, exactly as
// the app decodes it, and rendered at a fixed clock so the plan-window expiry
// and "last reported" read the same on every run. All data is invented.

import Foundation
import MARVINLogic
import SwiftUI

@MainActor enum SurfaceCostFixtures {
    /// 2026-10-31T12:00:00Z.
    static let now = Date(timeIntervalSince1970: 1_793_448_000)
    private static let t = 1_793_448_000.0

    struct Case {
        let id: String
        let title: String
        let json: String
        var summary: CostSummary? { try? CostService.decode(Data(json.utf8)) }
    }

    private static func period(_ cost: Double, _ turns: Int, modes: String) -> String {
        #"{"costUsd":\#(cost),"turns":\#(turns),"inputTokens":\#(turns * 41),"outputTokens":\#(turns * 2900),"cacheCreationTokens":\#(turns * 18400),"cacheReadTokens":\#(turns * 610000),"cacheWrite5mTokens":0,"cacheWrite1hTokens":\#(turns * 18400),"estimatedTurns":0,"unpricedTurns":0,"byAuthMode":{\#(modes)}}"#
    }

    private static func agg(_ cost: Double, _ turns: Int, unpriced: Int = 0, estimated: Int = 0) -> String {
        #"{"costUsd":\#(cost),"turns":\#(turns),"inputTokens":\#(turns * 41),"outputTokens":\#(turns * 2900),"cacheCreationTokens":\#(turns * 18400),"cacheReadTokens":\#(turns * 610000),"estimatedTurns":\#(estimated),"unpricedTurns":\#(unpriced)}"#
    }

    private static let daily = #"[{"day":"2026-10-29","costUsd":3.1,"turns":9},{"day":"2026-10-30","costUsd":5.4,"turns":14},{"day":"2026-10-31","costUsd":2.2,"turns":6}]"#

    private static func iso(hoursAgo h: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-h * 3600))
    }

    private static func window(_ type: String, _ label: String, util: Double?, resetsIn hours: Double?, reportedHoursAgo r: Double, inLatest: Bool?, status: String = "allowed") -> String {
        let u = util.map { "\"utilization\":\($0)," } ?? ""
        let reset = hours.map { "\"resetsAt\":\(t + $0 * 3600)," } ?? ""
        let latest = inLatest.map { "\"inLatestReport\":\($0)" } ?? "\"inLatestReport\":null"
        return #"{"type":"\#(type)","status":"\#(status)",\#(u)\#(reset)"label":"\#(label)","at":"\#(iso(hoursAgo: r))",\#(latest)}"#
    }

    private static let legacy = #""legacy":{"costUsd":1190.93,"turns":88,"from":"2026-10-20T08:00:00.000Z","to":"2026-10-30T22:41:00.000Z"}"#

    private static func body(today: String, week: String, lifetime: String, models: String, extra: String) -> String {
        #"{"today":\#(today),"week":\#(week),"lifetime":\#(lifetime),"daily":\#(daily),"byModel":\#(models),\#(extra)}"#
    }

    private static let subModels = #"{"today":[{"authMode":"subscription","model":"claude-opus-5-5","costUsd":2.05,"turns":6,"inputTokens":246,"outputTokens":17400,"cacheReadTokens":3660000,"cacheCreationTokens":110400,"estimated":false},{"authMode":"subscription","model":"claude-haiku-4-5-20251001","costUsd":0.15,"turns":6,"inputTokens":16086,"outputTokens":90,"cacheReadTokens":0,"cacheCreationTokens":0,"estimated":false}],"week":[{"authMode":"subscription","model":"claude-opus-5-5","costUsd":10.1,"turns":29,"inputTokens":1189,"outputTokens":84100,"cacheReadTokens":17690000,"cacheCreationTokens":533600,"estimated":false},{"authMode":"subscription","model":"claude-fable-5-1","costUsd":0.42,"turns":3,"inputTokens":120,"outputTokens":5200,"cacheReadTokens":410000,"cacheCreationTokens":22000,"estimated":false},{"authMode":"unknown","model":"unknown model","costUsd":0.18,"turns":1,"inputTokens":40,"outputTokens":800,"cacheReadTokens":80000,"cacheCreationTokens":0,"estimated":false}]}"#

    static let cases: [Case] = [
        Case(id: "ultra-with-5h", title: "Cost popover: Ultra, not yet verified — 5-hour and weekly windows",
             json: body(
                today: period(2.2, 6, modes: #""subscription":\#(agg(2.2, 6))"#),
                week: period(10.7, 33, modes: #""subscription":\#(agg(10.52, 32)),"unknown":\#(agg(0.18, 1))"#),
                lifetime: period(10.7, 33, modes: #""subscription":\#(agg(10.52, 32, unpriced: 2)),"unknown":\#(agg(0.18, 1))"#),
                models: subModels,
                extra: legacy + #","account":{"subscriptionType":"ultra","apiProvider":"firstParty","at":"2026-10-31T11:50:00.000Z"},"claudeRateLimits":[\#(window("five_hour", "current session", util: 0.35, resetsIn: 2.5, reportedHoursAgo: 0.1, inLatest: true)),\#(window("seven_day", "current week (all models)", util: 0.55, resetsIn: 60, reportedHoursAgo: 0.1, inLatest: true, status: "allowed_warning")),\#(window("seven_day_fable", "current week (Fable)", util: 0.12, resetsIn: 60, reportedHoursAgo: 0.1, inLatest: true))]"#)),
        // After verification the server stops sending five_hour: its last
        // snapshot's refill time passes with no report since, so it is gone —
        // and no code anywhere knows that Ultra has no 5-hour window.
        Case(id: "ultra-verified", title: "Cost popover: Ultra, verified — weekly only (5-hour window expired, not re-reported)",
             json: body(
                today: period(2.2, 6, modes: #""subscription":\#(agg(2.2, 6))"#),
                week: period(10.52, 32, modes: #""subscription":\#(agg(10.52, 32))"#),
                lifetime: period(10.52, 32, modes: #""subscription":\#(agg(10.52, 32))"#),
                models: subModels,
                extra: #""legacy":null,"account":{"subscriptionType":"ultra","apiProvider":"firstParty","at":"2026-10-31T11:50:00.000Z"},"claudeRateLimits":[\#(window("five_hour", "current session", util: 0.35, resetsIn: -4, reportedHoursAgo: 9, inLatest: false)),\#(window("seven_day", "current week (all models)", util: 0.41, resetsIn: 60, reportedHoursAgo: 0.05, inLatest: true)),\#(window("seven_day_overage_included", "current week (incl. overage)", util: 0.1, resetsIn: 60, reportedHoursAgo: 0.05, inLatest: true))]"#)),
        Case(id: "api-key", title: "Cost popover: Anthropic API key (billed)",
             json: body(
                today: period(1.31, 4, modes: #""anthropic-api":\#(agg(1.31, 4))"#),
                week: period(6.92, 19, modes: #""anthropic-api":\#(agg(6.92, 19, estimated: 1))"#),
                lifetime: period(6.92, 19, modes: #""anthropic-api":\#(agg(6.92, 19, estimated: 1))"#),
                models: #"{"today":[{"authMode":"anthropic-api","model":"claude-sonnet-5-5","costUsd":1.31,"turns":4,"inputTokens":164,"outputTokens":11600,"cacheReadTokens":2440000,"cacheCreationTokens":73600,"estimated":false}],"week":[{"authMode":"anthropic-api","model":"claude-sonnet-5-5","costUsd":6.4,"turns":18,"inputTokens":738,"outputTokens":52200,"cacheReadTokens":10980000,"cacheCreationTokens":331200,"estimated":false},{"authMode":"anthropic-api","model":"claude-next-preview","costUsd":0.52,"turns":1,"inputTokens":41,"outputTokens":2900,"cacheReadTokens":610000,"cacheCreationTokens":18400,"estimated":true}]}"#,
                extra: #""legacy":null,"account":{"apiProvider":"firstParty","at":"2026-10-31T11:50:00.000Z"},"claudeRateLimits":[]"#)),
        Case(id: "gateway", title: "Cost popover: enterprise gateway (SDK apiProvider = gateway)",
             json: body(
                today: period(0.84, 3, modes: #""gateway":\#(agg(0.84, 3, estimated: 3))"#),
                week: period(4.1, 14, modes: #""gateway":\#(agg(4.1, 14, estimated: 14))"#),
                lifetime: period(4.1, 14, modes: #""gateway":\#(agg(4.1, 14, estimated: 14))"#),
                models: #"{"today":[{"authMode":"gateway","model":"claude-sonnet-5-5","costUsd":0.84,"turns":3,"inputTokens":123,"outputTokens":8700,"cacheReadTokens":1830000,"cacheCreationTokens":55200,"estimated":true}],"week":[{"authMode":"gateway","model":"claude-sonnet-5-5","costUsd":4.1,"turns":14,"inputTokens":574,"outputTokens":40600,"cacheReadTokens":8540000,"cacheCreationTokens":257600,"estimated":true}]}"#,
                extra: #""legacy":null,"account":{"apiProvider":"gateway","at":"2026-10-31T11:50:00.000Z"},"claudeRateLimits":[]"#)),
        Case(id: "openrouter", title: "Cost popover: OpenRouter (estimate + OpenRouter's own billed figures)",
             json: body(
                today: period(0.21, 5, modes: #""openrouter":\#(agg(0.21, 5, unpriced: 1, estimated: 4))"#),
                week: period(1.04, 22, modes: #""openrouter":\#(agg(1.04, 22, unpriced: 2, estimated: 20))"#),
                lifetime: period(1.04, 22, modes: #""openrouter":\#(agg(1.04, 22, unpriced: 2, estimated: 20))"#),
                models: #"{"today":[{"authMode":"openrouter","model":"z-ai/glm-5","costUsd":0.21,"turns":4,"inputTokens":2440164,"outputTokens":11600,"cacheReadTokens":0,"cacheCreationTokens":0,"estimated":true},{"authMode":"openrouter","model":"vendor/unpriced-model","costUsd":0,"turns":1,"inputTokens":410000,"outputTokens":2100,"cacheReadTokens":0,"cacheCreationTokens":0,"estimated":true}],"week":[{"authMode":"openrouter","model":"z-ai/glm-5","costUsd":1.04,"turns":20,"inputTokens":12200000,"outputTokens":58000,"cacheReadTokens":0,"cacheCreationTokens":0,"estimated":true}]}"#,
                extra: #""legacy":null,"openRouter":{"totalCredits":25,"totalUsage":7.62},"openRouterKey":{"usage":7.62,"usageDaily":0.19,"usageWeekly":1.11,"usageMonthly":4.3,"fetchedAt":"2026-10-31T11:58:00.000Z"},"claudeRateLimits":[]"#)),
        Case(id: "stale-windows", title: "Cost popover: stale windows (one expired and hidden, one absent from the latest report)",
             json: body(
                today: period(0.9, 3, modes: #""subscription":\#(agg(0.9, 3))"#),
                week: period(0.9, 3, modes: #""subscription":\#(agg(0.9, 3))"#),
                lifetime: period(0.9, 3, modes: #""subscription":\#(agg(0.9, 3))"#),
                models: #"{"today":[],"week":[]}"#,
                extra: #""legacy":null,"claudeRateLimits":[\#(window("five_hour", "current session", util: 0.8, resetsIn: -20, reportedHoursAgo: 26, inLatest: nil)),\#(window("seven_day_opus", "current week (Opus)", util: 0.33, resetsIn: 40, reportedHoursAgo: 30, inLatest: false)),\#(window("seven_day", "current week (all models)", util: 0.22, resetsIn: 40, reportedHoursAgo: 0.3, inLatest: true))]"#)),
    ]
}

// SurfaceSnapshotBacklogPlans — the Project Backlog window and the Plans
// surfaces, at the load they actually carry: 300 backlog items across every
// severity (provisional, blocked, in progress, resolved included), and a plan
// of twelve steps with sub-steps and a superseded step beside a finished plan
// and thirty past ones.
//
// Same rules as the rest of the harness (see SurfaceSnapshot.swift): every
// name, title and number is invented and neutral (Golden Rule 6); dates are
// relative to the moment of the run so "3d" reads as 3d whenever it is taken.
// The backlog is served by the stand-in sidecar; the plans are in-process.

import AppKit
import MARVINLogic
import SwiftUI

enum BacklogPlansFixtures {
    enum BacklogMode { case full, empty }

    /// What `/api/backlog` answers. Set by a surface's `prepare`, read by the
    /// stand-in sidecar's route. Plain static: the harness is single-run.
    nonisolated(unsafe) static var backlogMode: BacklogMode = .full

    // MARK: - Backlog

    private static let verbs = ["Add", "Remove", "Document", "Pin", "Replace", "Extract", "Rename", "Fix", "Cover", "Audit",
                                "Simplify", "Verify", "Stream", "Batch", "Cache", "Retry"]
    private static let objects = [
        "the retry delay jitter", "the transport timeout", "the usage ledger rounding", "the config loader defaults",
        "the sync service backoff", "the cache eviction order", "the request id header", "the error class hierarchy",
        "the pagination cursor", "the rate-limit headers", "the idempotency key", "the session expiry check",
        "the CSV export encoding", "the webhook signature check", "the audit log retention", "the health endpoint",
        "the schema migration order", "the fixture generator", "the changelog format", "the onboarding checklist",
        "the cost report totals", "the proxy settings", "the token refresh path", "the upload size limit",
    ]
    private static let kinds: [String?] = ["bug", "feature", "investigate", "test", "docs", "chore", nil, nil]
    private static let waits = ["accountant sign-off", "the API owner's answer", "a design decision from the owner",
                                "the vendor's published limits", "the lawyer's review"]

    private static func iso(daysAgo: Int, minute: Int = 0) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-Double(daysAgo) * 86_400 - Double(minute) * 60))
    }

    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    /// Three hundred items from a seeded generator, so a run is repeatable.
    static func backlogJSON() -> String {
        if backlogMode == .empty { return #"{"workDir":"@ROOT@","items":[]}"# }
        var seed: UInt64 = 0x9E37_79B9
        func next(_ n: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(n))
        }
        var rows: [String] = []
        // The showpieces first, so they are in every render.
        rows.append(item(
            "per-attempt-cost-ledger", "Record the billed cost of each attempt, not only the request total",
            body: "The ledger stores one figure per request, so a request that succeeded on its third attempt looks as cheap as one that succeeded on its first. The upstream exposes a per-attempt usage endpoint, but its response shape differs between the two API versions we talk to. Probe both shapes against a recorded response before relying on either, and keep the request total as the sum so the existing reports do not change.\n\n> note 2026-11-12 — the older API version returns the figure in cents, the newer in micro-dollars\n> note 2026-11-19 — asked the API owner which version a given attempt went through\n\nSee https://example.com/docs/usage-endpoint for the response shapes.\n\n<!-- marvin:links -->\n**Related:** [ADR-0044](docs/decisions/0044-project-backlog.md) · [[usage-ledger]]",
            status: "open", severity: "high", daysAgo: 27, kind: "feature"))
        rows.append(item(
            "confirm-rate-limits", "Confirm the upstream rate limits before tuning backoff",
            body: "The cap we picked is a guess until the API owner answers.", status: "open", severity: "high",
            daysAgo: 21, kind: "investigate", blocked: true, blockedOn: "the API owner confirming the published limits"))
        rows.append(item(
            "fix-body-replay", "Replay a buffered body across attempts", body: "Buffer small bodies, refuse to retry a stream that cannot be replayed.",
            status: "doing", severity: "high", daysAgo: 9, kind: "bug", claimedBy: "8cb24ed6-1f3a", claimedBranch: "marvin/tab/fix-body-replay"))
        for i in 0..<294 {
            let title = "\(verbs[next(verbs.count)]) \(objects[next(objects.count)])"
            let r = next(100)
            let severity = r < 10 ? "high" : (r < 60 ? "med" : "low")
            var status = "open"
            var blocked = false
            var on: String?
            switch next(100) {
            case 0..<4: status = "provisional"
            case 4..<6: status = "doing"
            case 6..<17: status = "done"
            case 17..<20: status = "dismissed"
            case 20..<27: blocked = true; on = waits[next(waits.count)]
            default: break
            }
            let age = status == "provisional" ? next(3) : 1 + next(220)
            rows.append(item(
                "item-\(i)", "\(title) (\(i))", body: "Parked while working on something else. \(title.lowercased()) — worth a look once the current work lands.",
                status: status, severity: severity, daysAgo: age, kind: kinds[next(kinds.count)],
                blocked: blocked, blockedOn: on, claimedBy: status == "doing" ? "d41a77e2-93b0" : nil, claimedBranch: nil))
        }
        // A few unmistakable captures waiting for review.
        for (n, t) in ["Flaky timeout in the transport test", "Dead config key in the loader", "Document the retry policy defaults"].enumerated() {
            rows.append(item("capture-\(n)", t, body: "Noticed while working on the retry client; unrelated to the current task.",
                             status: "provisional", severity: n == 0 ? "med" : "low", daysAgo: 0, kind: ["investigate", "chore", "docs"][n]))
        }
        return #"{"workDir":"@ROOT@","items":[\#(rows.joined(separator: ","))]}"#
    }

    private static func item(_ id: String, _ title: String, body: String, status: String, severity: String, daysAgo: Int,
                             kind: String?, blocked: Bool = false, blockedOn: String? = nil,
                             claimedBy: String? = nil, claimedBranch: String? = nil) -> String {
        var f = #"{"id":"\#(esc(id))","title":"\#(esc(title))","body":"\#(esc(body))","status":"\#(status)","severity":"\#(severity)","created":"\#(iso(daysAgo: daysAgo))""#
        if let kind { f += #","kind":"\#(kind)""# }
        if blocked { f += #","blocked":true"# }
        if let blockedOn { f += #","blockedOn":"\#(esc(blockedOn))""# }
        if let claimedBy { f += #","claimedBy":"\#(claimedBy)""# }
        if let claimedBranch { f += #","claimedBranch":"\#(claimedBranch)""# }
        return f + "}"
    }

    // MARK: - Plans

    private static func todo(_ text: String, _ status: String, active: String? = nil) -> TodoItem {
        TodoItem(content: text, status: status, activeForm: active)
    }

    /// Twelve steps: some done, one running with sub-steps (one of them
    /// superseded), one long enough to need its lead, the rest pending.
    static var activePlan: Plan {
        var steps: [PlanStep] = []
        let titles = [
            "Read the retry policy and the transport tests",
            "Add a failing test for the jittered delay",
            "Implement full jitter with a capped exponential base",
            "Replay a buffered body across attempts",
            "**Refuse to retry a stream that cannot be replayed.** The first attempt consumes a streamed body, so the second attempt sends an empty request. Buffer small bodies up to the configured limit, and for anything larger fail the retry with a typed error that names the reason instead of sending nothing.",
            "Record the attempt number beside each billed figure",
            "Wire the per-attempt usage endpoint behind a probe",
            "Update the cost report to sum attempts",
            "Document the retry policy defaults",
            "Run the full suite and the type check",
            "Review the diff against the project's review rules",
            "Commit, push and open the merge request",
        ]
        for (i, t) in titles.enumerated() {
            let status = i < 4 ? "completed" : (i == 4 ? "in_progress" : "pending")
            var step = PlanStep(content: t, status: status, activeForm: i == 4 ? "Refusing to retry a stream that cannot be replayed" : nil)
            if i == 4 {
                step.subtasks = [
                    todo("Decide the buffer limit and where it is configured", "completed"),
                    todo("Buffer bodies under the limit before the first attempt", "completed"),
                    todo("Return a typed error for a stream that cannot be replayed", "in_progress", active: "Returning a typed error for a stream that cannot be replayed"),
                    todo("Probe the older API version for a conflicting error shape", TodoItem.superseded),
                    todo("Cover both paths with a test", "pending"),
                ]
            }
            if i == 2 {
                step.subtasks = [todo("Choose the jitter strategy", "completed"), todo("Pin the range in the test", "completed")]
            }
            steps.append(step)
        }
        return Plan(id: "retry-backoff", title: "Retry with backoff for the HTTP client",
                    text: "", path: nil, steps: steps)
    }

    static var finishedPlan: Plan {
        let steps = ["Read the transport tests", "Extract the retry policy", "Cover it with tests", "Update the docs"]
            .map { PlanStep(content: $0, status: "completed") }
        return Plan(id: "extract-retry-policy", title: "Extract the retry policy from the client", text: "", path: nil, steps: steps)
    }

    /// Thirty past plans, a mix of finished and abandoned, over two months.
    static var pastPlans: [(plan: Plan, minutesAgo: Double)] {
        let topics = ["Typed error classes", "Cache eviction order", "Webhook signature check", "Pagination cursor", "CSV export encoding",
                      "Proxy settings", "Token refresh path", "Health endpoint", "Schema migration order", "Audit log retention"]
        return (0..<30).map { i in
            let total = 3 + (i % 5)
            let done = i % 3 == 0 ? max(1, total - 2) : total
            let steps = (1...total).map { n in
                PlanStep(content: "Step \(n) of \(topics[i % topics.count])", status: n <= done ? "completed" : "pending")
            }
            let plan = Plan(id: "past-\(i)", title: "\(topics[i % topics.count]) (\(i / topics.count + 1))", text: "", path: nil, steps: steps)
            return (plan, Double(60 * 3 + i * 60 * 36))
        }
    }

    static var allPlans: [Plan] { [activePlan, finishedPlan] + pastPlans.map(\.plan) }

    static var planDates: [String: Date] {
        var d: [String: Date] = ["retry-backoff": Date().addingTimeInterval(-12 * 60),
                                 "extract-retry-policy": Date().addingTimeInterval(-26 * 3600)]
        for p in pastPlans { d[p.plan.id] = Date().addingTimeInterval(-p.minutesAgo * 60) }
        return d
    }

    // MARK: - Surfaces

    @MainActor
    static func surfaces() -> [SurfaceSnapshot.Surface] {
        func window(_ id: String, _ title: String, widths: [CGFloat], mode: BacklogMode = .full,
                    startAtReview: Bool = false, select: String? = nil,
                    statuses: String = "", group: String = "severity",
                    interact: (@MainActor (NSView) -> Void)? = nil) -> SurfaceSnapshot.Surface {
            SurfaceSnapshot.Surface(id, title, .populated, widths: widths, height: 700,
                                    prepare: {
                                        backlogMode = mode
                                        // The window reads these through @AppStorage: set (and reset) them per scenario.
                                        UserDefaults.standard.set(statuses, forKey: "marvin.backlog.statuses")
                                        UserDefaults.standard.set(group, forKey: "marvin.backlog.group")
                                    }, interact: interact) {
                AnyView(BacklogPanel(workDir: SurfaceFixtures.project, startAtReview: startAtReview, initialSelection: select,
                                     onPromote: { _ in }, onClose: {}, onChanged: {}))
            }
        }
        let detailItem = BacklogItem(
            id: "per-attempt-cost-ledger", title: "Record the billed cost of each attempt, not only the request total",
            body: "The ledger stores one figure per request, so a request that succeeded on its third attempt looks as cheap as one that succeeded on its first. Probe both shapes against a recorded response before relying on either.\n\n> note 2026-11-12 — the older API version returns the figure in cents\n> note 2026-11-19 — asked the API owner which version a given attempt went through\n\nSee https://example.com/docs/usage-endpoint.\n\n<!-- marvin:links -->\n**Related:** [ADR-0044](docs/decisions/0044-project-backlog.md) · [[usage-ledger]]",
            status: "open", severity: "high", created: iso(daysAgo: 27), kind: "feature")

        let backlog: [SurfaceSnapshot.Surface] = [
            window("backlog-window", "Backlog window — 300 items, grouped by severity", widths: [720, 1180]),
            window("backlog-window-selected", "Backlog window — an item selected, its notes and links", widths: [720, 1180],
                   select: "per-attempt-cost-ledger"),
            window("backlog-window-review", "Backlog window — opened at the auto-captured review", widths: [720, 1180], startAtReview: true),
            window("backlog-window-filtered", "Backlog window — filtered: In progress + Blocked, with the chips", widths: [720, 1180],
                   statuses: "inProgress,blocked"),
            window("backlog-window-status-groups", "Backlog window — grouped by status", widths: [1180], group: "status"),
            window("backlog-window-empty", "Backlog window — nothing parked", widths: [720], mode: .empty),
            window("backlog-window-no-results", "Backlog window — a search with no results", widths: [720],
                   interact: { host in typeIntoFirstField(host, "zzzq") }),
            SurfaceSnapshot.Surface("backlog-detail", "Backlog item detail", .fixture, widths: [460, 640], height: 620) {
                AnyView(BacklogDetailView(workDir: SurfaceFixtures.project, item: detailItem,
                                          onPromote: { _ in }, onChanged: {}, onDismissSheet: {}))
            },
        ]

        let plans: [SurfaceSnapshot.Surface] = [
            SurfaceSnapshot.Surface("plans-panel", "Plans panel — active 12-step plan, a finished plan, 30 past plans", .fixture,
                                    widths: [680, 1000], height: 760) {
                AnyView(PlansPanel(plans: allPlans, activePlanId: "retry-backoff", onSelect: { _ in }, onOpenFile: {},
                                   onContinue: {}, onRemove: { _ in }, onClose: {}, updatedAt: planDates))
            },
            SurfaceSnapshot.Surface("plans-panel-search", "Plans panel — search", .fixture, widths: [680], height: 560,
                                    interact: { host in typeIntoFirstField(host, "cache") }) {
                AnyView(PlansPanel(plans: allPlans, activePlanId: "retry-backoff", onSelect: { _ in }, onOpenFile: {},
                                   onContinue: {}, onRemove: { _ in }, onClose: {}, updatedAt: planDates))
            },
            SurfaceSnapshot.Surface("plans-panel-empty", "Plans panel — no plans", .fixture, widths: [680], height: 420) {
                AnyView(PlansPanel(plans: [], activePlanId: nil, onSelect: { _ in }, onOpenFile: {},
                                   onContinue: {}, onRemove: { _ in }, onClose: {}))
            },
            SurfaceSnapshot.Surface("plan-strip-12", "Plan checklist strip — 12 steps, sub-steps, one superseded", .fixture, widths: [520, 900]) {
                AnyView(TodoListStrip(steps: activePlan.steps, planTitle: activePlan.title,
                                      onOpenPlanFile: {}, onOpenPlansPanel: {}, onClose: {}))
            },
            SurfaceSnapshot.Surface("plan-card", "Plan card in the chat — long steps and sub-steps", .fixture, widths: [520, 900]) {
                AnyView(PlanCardView(text: """
                # Plan — Retry with backoff for the HTTP client

                1. Read the retry policy and the transport tests
                2. **Refuse to retry a stream that cannot be replayed.** The first attempt consumes a streamed body, so the second attempt sends an empty request. Buffer small bodies up to the configured limit, and for anything larger fail the retry with a typed error that names the reason.
                   - Decide the buffer limit and where it is configured
                   - Buffer bodies under the limit before the first attempt
                   - Return a typed error for a stream that cannot be replayed
                   - Cover both paths with a test
                3. Record the attempt number beside each billed figure
                   - Probe the older API version
                4. Run the full suite and the type check
                """).padding(16))
            },
        ]
        return backlog + plans
    }

    /// Type into the first editable text field of the mounted view, through
    /// the field editor, so the view's own binding sees it.
    @MainActor
    private static func typeIntoFirstField(_ host: NSView, _ text: String) {
        func find(_ v: NSView) -> NSTextField? {
            if let f = v as? NSTextField, f.isEditable { return f }
            for s in v.subviews { if let f = find(s) { return f } }
            return nil
        }
        guard let field = find(host), let window = host.window else {
            FileHandle.standardError.write(Data("surface snapshot: no editable text field to type into\n".utf8))
            return
        }
        window.makeFirstResponder(field)
        (field.currentEditor() as? NSTextView)?
            .insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
    }
}

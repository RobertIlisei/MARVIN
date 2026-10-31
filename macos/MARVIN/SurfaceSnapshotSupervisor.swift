// SurfaceSnapshotSupervisor — snapshot fixtures for every supervisor state in
// the design brief's §7 (ADR-0127 milestone 6), plus transcript marking.
//
// Each state is the real `SessionsPane` mounted with a `SupervisorModel` this
// file fills in-process (`offline = true`, so it never fetches and never reads
// the user's real token). The tab rows behind it come from the stand-in
// sidecar, as for `pane-sessions`. All data is invented and neutral
// (Golden Rule 6): the demo project "Atlas".

import AppKit
import MARVINLogic
import SwiftUI

@MainActor enum SurfaceSupervisorFixtures {
    static let ids = SurfaceRoutesMore.openIds
    private static func iso(_ minutesAgo: Double) -> String { SurfaceRoutesMore.iso(minutesAgo) }

    // MARK: - Status

    static func status(mode: String = "shadow", run: String = "idle", health: String = "ok",
                       autonomy: [String: String] = [:], pause: SupervisorStatus.Pause? = nil,
                       wake: SupervisorStatus.Wake? = nil, queued: Int = 0,
                       lastWake: SupervisorStatus.LastWake? = nil, open: Int = 0,
                       spent: Double = 3.2, cap: Double = 10, level: String = "ok") -> SupervisorStatus {
        let cats = ["questions", "nudges", "posture", "confirms"]
        var auto = Dictionary(uniqueKeysWithValues: cats.map { ($0, "shadow") })
        for (k, v) in autonomy { auto[k] = v }
        return SupervisorStatus(
            projectId: "prj_atlas", revision: 12, mode: mode, autonomy: auto, run: run, pause: pause,
            currentWake: wake, queuedEvents: queued,
            lastWake: lastWake ?? .init(wakeId: "w-41", at: iso(2), outcome: "ok"),
            health: health, watchedTabs: 4, openEscalations: open,
            budget: .init(capUsd: cap, spentUsd: spent, spentOwnUsd: spent * 0.4, spentTabsUsd: spent * 0.6,
                          resetsAt: midnight, level: level),
            charter: .init(text: "Ship the retry work this week. Keep releases local until review; never touch billing.", updatedAt: iso(300)),
            model: .init(resolved: "claude-sonnet-5-5", label: "Sonnet 5.5"),
            stats: [
                "questions": .init(proposals: 24, agreed: 23, agreedBlind: 21, agreementRate: 0.958, humanOnlyProposedAsAct: 0),
                "nudges": .init(proposals: 9, agreed: 8, agreementRate: 0.889),
                "posture": .init(proposals: 3, agreed: 3, agreementRate: 1.0, humanOnlyProposedAsAct: 1),
                "confirms": .init(proposals: 0, agreed: 0),
            ],
            suggestedBar: .init(minProposals: 20, minAgreement: 0.9),
            confirmsEligible: true)
    }

    private static var midnight: String {
        let cal = Calendar.current
        let d = cal.nextDate(after: Date(), matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) ?? Date()
        let f = ISO8601DateFormatter()
        return f.string(from: d)
    }

    // MARK: - Inbox items

    static func ground(_ kind: String, _ ref: String, _ label: String, strong: Bool, resolved: Bool = true) -> SupervisorGround {
        SupervisorGround(kind: kind, ref: ref, tree: "main", label: label, provenance: strong ? "strong" : "weak",
                         resolved: resolved, excerpt: nil,
                         openTarget: kind == "plan-step" ? .init(path: SurfaceFixtures.project + "/.marvin/plans/retry.md", line: 12) : nil)
    }

    /// An outward act: Allow is behind "Review act…" until the card is expanded.
    static var pushItem: SupervisorInboxItem {
        let cmd = ["git", "push", "origin", "feature/retry"].joined(separator: " ")
        return SupervisorInboxItem(
            id: "inbox-push", createdAt: iso(1), wakeId: "w-41", sessionId: ids[2], tabTitle: "Publish the release branch",
            ledgerId: "L-52", kind: "integration",
            escalatedBecause: .init(code: "human-only", label: "Only you can push", rule: "§4.1 push"),
            rawAct: .init(toolName: "Bash", input: .object(["command": .string(cmd), "description": .string("Publish the release branch")]),
                          digest: "sha256:4f2a9c0e7b61d3a8", summary: cmd, outward: true, destructive: false),
            linkedConfirm: .init(sessionId: ids[2], turnId: "t-c1", toolUseId: "use-c1", raisingRule: "supervisor-touched"),
            recommendation: .init(actionId: "deny", text: "The plan's step [4] keeps the release local until review, and the charter says the same."),
            grounds: [ground("plan-step", "plan:[4]", "Keep the release local until review", strong: true),
                      ground("charter", "charter", "Keep releases local until review", strong: false)],
            actions: [.init(id: "deny", label: "Deny", role: "refuse", recommended: true),
                      .init(id: "allow", label: "Allow push", role: "consent", requiresExpanded: true)],
            modeAtCreation: "shadow", burstRank: 0)
    }

    static var questionItem: SupervisorInboxItem {
        SupervisorInboxItem(
            id: "inbox-question", createdAt: iso(4), sessionId: ids[3], tabTitle: "Fix the flaky cache test",
            kind: "question",
            escalatedBecause: .init(code: "weak-grounds-only", label: "Supervisor unsure — weak grounds"),
            question: .init(questions: [.init(header: "Cache", question: "Which store should the test cache use?", multiSelect: false,
                                              options: [.init(label: "In-memory", description: "Fast, and isolated per test run"),
                                                        .init(label: "SQLite", description: "Matches production behaviour"),
                                                        .init(label: "Redis", description: "Needs a running server")])]),
            linkedConfirm: .init(sessionId: ids[3], turnId: "t-d1", toolUseId: "use-q1", raisingRule: "ask-user-question"),
            recommendation: .init(actionId: "answer", text: "The test only needs isolation; the plan does not name a store."),
            grounds: [ground("memory", "memory:test-isolation", "Tests must not share state", strong: false)],
            actions: [.init(id: "answer", label: "Answer: In-memory", role: "consent", recommended: true),
                      .init(id: "answer-edit", label: "Answer…", role: "edit")],
            modeAtCreation: "shadow")
    }

    static var mergeItem: SupervisorInboxItem {
        SupervisorInboxItem(
            id: "inbox-merge", createdAt: iso(6), sessionId: ids[0], tabTitle: "Add retry with backoff to the HTTP client",
            kind: "integration",
            escalatedBecause: .init(code: "human-only", label: "Only you can merge into main"),
            rawAct: .init(toolName: "worktrees.merge", input: .object(["slug": .string("retry-backoff"), "into": .string("main")]),
                          digest: "sha256:9a01bb72", summary: "Merge marvin/tab/retry-backoff into main", outward: false),
            preview: .init(verdict: "clean", added: 120, removed: 8),
            recommendation: .init(actionId: "perform", text: "All eight plan steps are done and the suite passed on the last turn."),
            grounds: [ground("plan-step", "plan:[8]", "Merge once the suite passes", strong: true),
                      ground("dod", "dod", "Retries are covered by tests", strong: true)],
            actions: [.init(id: "perform", label: "Merge", role: "consent", recommended: true),
                      .init(id: "deny", label: "Not now", role: "refuse")])
    }

    static var newTabItem: SupervisorInboxItem {
        SupervisorInboxItem(
            id: "inbox-newtab", createdAt: iso(3), sessionId: nil, kind: "new-tab",
            escalatedBecause: .init(code: "human-only", label: "Only you can open a tab"),
            actions: [.init(id: "open", label: "Open tab", role: "consent", recommended: true),
                      .init(id: "edit", label: "Edit…", role: "edit"),
                      .init(id: "dismiss", label: "Dismiss", role: "dismiss")],
            newTab: .init(firstMessage: "Add a changelog entry for the retry work. Keep it to one paragraph and link the plan; do not touch the release branch.",
                          tree: .init(baseRef: "main", baseSha: "85a0492e1c", mode: "worktree"),
                          posture: .init(model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", effort: "medium", strategy: "gated", mode: "plan"),
                          wider: [], requestedBy: .init(kind: "user-message", ref: "m-7", at: iso(4))))
    }

    static func guardrail(code: String, label: String, detail: String, verb: String) -> SupervisorInboxItem {
        SupervisorInboxItem(
            id: "inbox-guard-\(code)", createdAt: iso(0.5), sessionId: nil, kind: "guardrail",
            escalatedBecause: .init(code: code, label: label),
            actions: [.init(id: verb, label: verb == "raise-cap" ? "Raise cap…" : "Resume", role: "consent", recommended: true),
                      .init(id: "dismiss", label: "Dismiss", role: "dismiss")],
            guardrail: .init(kind: code, detail: detail, verb: verb))
    }

    /// Twelve escalations: four on one tab, three on another, a guardrail.
    static var burst: [SupervisorInboxItem] {
        var items: [SupervisorInboxItem] = [pushItem, questionItem, mergeItem]
        for i in 1...3 {
            items.append(SupervisorInboxItem(
                id: "inbox-burst-c\(i)", createdAt: iso(Double(10 + i)), sessionId: ids[2], tabTitle: "Publish the release branch",
                kind: "confirm", escalatedBecause: .init(code: "delegation-observe", label: "Observe only — never acts"),
                rawAct: .init(toolName: "Edit", summary: "Edit CHANGELOG.md (+\(i * 3) −0)"),
                actions: [.init(id: "allow", label: "Allow", role: "consent", recommended: true),
                          .init(id: "deny", label: "Deny", role: "refuse")], burstRank: i))
        }
        for i in 1...2 {
            items.append(SupervisorInboxItem(
                id: "inbox-burst-a\(i)", createdAt: iso(Double(20 + i)), sessionId: ids[0], tabTitle: "Add retry with backoff to the HTTP client",
                kind: "scope", escalatedBecause: .init(code: "nudge-cap", label: "Third nudge on step [3]"),
                rawAct: .init(toolName: "send", summary: "Send: \"Step [3] is still open — run the retry tests\""),
                actions: [.init(id: "perform", label: "Send nudge", role: "consent", recommended: true),
                          .init(id: "deny", label: "Don't send", role: "refuse")], burstRank: i))
        }
        for i in 1...3 {
            items.append(SupervisorInboxItem(
                id: "inbox-burst-d\(i)", createdAt: iso(Double(30 + i)), sessionId: ids[3], tabTitle: "Fix the flaky cache test",
                kind: "boundary-path", escalatedBecause: .init(code: "human-only", label: "Only you can edit .env files"),
                rawAct: .init(toolName: "Edit", summary: "Edit .env.local (+2 −0)", paths: [".env.local"]),
                actions: [.init(id: "deny", label: "Deny", role: "refuse", recommended: true),
                          .init(id: "allow", label: "Allow edit", role: "consent", requiresExpanded: true)], burstRank: i))
        }
        items.append(guardrail(code: "nudge-cap", label: "Nudge cap reached on 2 tabs", detail: "The supervisor stopped nudging until you look.", verb: "open-tab"))
        return items
    }

    // MARK: - Ledger

    static var ledger: [SupervisorLedgerEntry] {
        [
            .init(seq: 41, at: iso(1), wakeId: "w-41", sessionId: ids[2], tabTitle: "Publish the release branch", verb: "confirm",
                  decision: "escalate", mode: "shadow", argDigest: "sha256:4f2a9c0e", argSummary: "Bash · push to origin",
                  reason: .init(code: "human-only", text: "Only you can push")),
            .init(seq: 40, at: iso(5), wakeId: "w-40", sessionId: ids[3], tabTitle: "Fix the flaky cache test", verb: "answer",
                  decision: "propose", mode: "shadow", argSummary: "In-memory",
                  reason: .init(code: "grounded", text: "plan step [2] names test isolation"),
                  pairing: .init(actualAnswer: ["In-memory"], answeredBy: "user", agreement: "agree", proposalSeenBeforeAnswer: false)),
            .init(seq: 39, at: iso(9), wakeId: "w-39", sessionId: ids[0], tabTitle: "Add retry with backoff", verb: "send",
                  decision: "act", mode: "autonomous", argSummary: "Step [3] is open — run the retry tests",
                  reason: .init(code: "grounded", text: "nudge inside the plan, step [3]"), costUsd: 0.04),
            .init(seq: 38, at: iso(14), wakeId: "w-38", sessionId: ids[1], tabTitle: "Draft the quickstart section", verb: "set_posture",
                  decision: "refuse", mode: "autonomous", reason: .init(code: "widening", text: "widening is the user's act: mode plan → agent")),
            .init(seq: 37, at: iso(22), actor: "user", sessionId: ids[3], tabTitle: "Fix the flaky cache test", verb: "delegate",
                  reason: .init(code: "user", text: "delegation set to answer questions")),
            .init(seq: 36, at: iso(60), actor: "runtime", verb: "rotation", reason: .init(code: "rotation", text: "session rotated")),
        ]
    }

    // MARK: - Models per state

    static func model(_ status: SupervisorStatus?, items: [SupervisorInboxItem] = [], feed: Bool = true,
                      token: String? = nil, configure: (SupervisorModel) -> Void = { _ in }) -> SupervisorModel {
        let m = SupervisorModel()
        m.offline = true
        m.fixtureFeedConnected = feed
        m.status = status
        m.inbox = items
        m.tokenError = token
        m.ledger = ledger
        m.ledgerTodayCount = 38
        m.ledgerHasMore = true
        configure(m)
        return m
    }

    @MainActor
    static var states: [(id: String, title: String, model: () -> SupervisorModel)] {
        [
            ("sup-off", "Supervisor §7 Off — the one line under History", { model(status(mode: "off")) }),
            ("sup-shadow-idle", "Supervisor §7 Enabled · shadow · idle, empty inbox, with a blind 'would answer' line (§6.4)", { model(status()) }),
            ("sup-waking", "Supervisor §7 Waking — Kill chip shows", { model(status(run: "waking", wake: .init(wakeId: "w-42", startedAt: iso(0.2), itemCount: 3))) }),
            ("sup-autonomous", "Supervisor §7 Autonomous · 2 of 4", { model(status(mode: "autonomous", autonomy: ["questions": "autonomous", "nudges": "autonomous"])) }),
            ("sup-paused-user", "Supervisor §7 Paused by user", { model(status(run: "paused", pause: .init(reason: "user", at: iso(4)), queued: 3), items: [mergeItem]) }),
            ("sup-killed", "Supervisor §7 Killed — paused, wake aborted", { model(status(run: "paused", pause: .init(reason: "kill", at: iso(1), detail: "aborted a wake with 2 items"))) }),
            ("sup-over-budget", "Supervisor §7 Over budget — paused, Raise cap…", {
                model(status(run: "paused", pause: .init(reason: "budget", at: iso(3)), spent: 10, cap: 10, level: "reached"),
                      items: [guardrail(code: "budget", label: "Daily cap reached", detail: "$10.00 of $10 spent today — resets at midnight.", verb: "raise-cap")])
            }),
            ("sup-near-budget", "Supervisor §7 Near budget (≥ 80 %) — orange meter", { model(status(spent: 8.4, level: "near")) }),
            ("sup-paused-breaker", "Supervisor §7 Paused by breaker", {
                model(status(run: "paused", pause: .init(reason: "breaker", at: iso(2), detail: "3 failed wakes in 10 minutes")),
                      items: [guardrail(code: "breaker", label: "Paused after 3 failed wakes", detail: "The breaker trips after 3 failed wakes in 10 minutes.", verb: "resume")])
            }),
            ("sup-paused-refusals", "Supervisor §7 Paused by refusals", {
                model(status(run: "paused", pause: .init(reason: "refusals", at: iso(2), detail: "3 refused calls in one wake")),
                      items: [guardrail(code: "refusals", label: "Paused after 3 refused calls", detail: "Three calls in one wake were refused for provenance.", verb: "resume")])
            }),
            ("sup-paused-repeated-failures", "Supervisor §7 Paused by repeated failures", {
                model(status(run: "paused", pause: .init(reason: "repeated-failures", at: iso(2), detail: "the same tab failed 3 turns in a row")))
            }),
            ("sup-burst", "Supervisor §7 Burst — 12 waiting, oldest card per tab, +N more, guardrail first", {
                model(status(open: 12), items: burst)
            }),
            ("sup-stale", "Supervisor §7 Stale — not waking, Restart", {
                model(status(health: "stale", queued: 5, lastWake: .init(wakeId: "w-30", at: iso(14), outcome: "ok")), items: [mergeItem])
            }),
            ("sup-failed", "Supervisor §7 Failed — persistent error notice", {
                model(status(health: "failed", lastWake: .init(wakeId: "w-43", at: iso(1), outcome: "failed",
                                                              error: .init(message: "Wake failed: the model returned an overloaded error", detail: "529 Overloaded · retry in 30 s"))))
            }),
            ("sup-disconnected", "Supervisor §7 Feed disconnected — items disabled, numbers hidden", {
                model(status(open: 1), items: [pushItem], feed: false)
            }),
            ("sup-token-unavailable", "Supervisor §7 Token unavailable", {
                model(nil, items: [mergeItem], token: "/Users/demo/.marvin/supervisor/token")
            }),
            ("sup-outward-collapsed", "Supervisor §6.2 outward act, collapsed — Review act…, no Allow chip", {
                model(status(open: 1), items: [pushItem])
            }),
            ("sup-outward-expanded", "Supervisor §6.2 outward act, expanded — full act, then Allow push", {
                model(status(open: 1), items: [pushItem]) { $0.expandedCards = ["inbox-push"]; $0.groundsShown = ["inbox-push"] }
            }),
            ("sup-question-merge", "Supervisor §6.2 question escalation and a one-click local merge", {
                model(status(open: 2), items: [questionItem, mergeItem])
            }),
            ("sup-new-tab", "Supervisor §6.3 new-tab proposal", { model(status(open: 1), items: [newTabItem]) }),
            ("sup-settings", "Supervisor §6.1 expanded block — autonomy, charter, cap, model", {
                model(status()) { $0.stripExpanded = true }
            }),
            ("sup-log", "Supervisor §6.6 log, opened", {
                model(status()) { $0.logExpanded = true }
            }),
        ]
    }

    // MARK: - The Supervisor tab's cards (ADR-0128 §3, plan [7.2])

    static var sendItem: SupervisorInboxItem {
        let text = "Run the full retry test suite before you commit step [3]."
        return SupervisorInboxItem(
            id: "inbox-send", createdAt: iso(1), wakeId: "w-50", sessionId: ids[0], tabTitle: "Add retry with backoff to the HTTP client",
            kind: "scope",
            escalatedBecause: .init(code: "delegation-observe", label: "The tab is delegated at \"observe\", below this act — the supervisor recommends, the user decides"),
            rawAct: .init(toolName: "send", input: .object(["marvinSessionId": .string(ids[0]), "message": .string(text), "kind": .string("instruction")]),
                          digest: "sha256:5d1e", summary: "Send to tab Add retry with backoff: \(text)", outward: false),
            recommendation: .init(actionId: "perform", text: "You asked for it in the message above."),
            grounds: [ground("message", "message:m-9", "Tell the retry tab to run the tests first", strong: true)],
            actions: [.init(id: "perform", label: "Send to the tab", role: "consent", recommended: true),
                      .init(id: "edit", label: "Edit…", role: "edit"),
                      .init(id: "dismiss", label: "Dismiss", role: "dismiss")])
    }

    private static func settled(_ i: SupervisorInboxItem, state: String, by: String) -> SupervisorInboxItem {
        SupervisorInboxItem(id: i.id, createdAt: i.createdAt, sessionId: i.sessionId, tabTitle: i.tabTitle, kind: i.kind,
                            escalatedBecause: i.escalatedBecause, rawAct: i.rawAct, state: state, resolvedBy: by)
    }

    /// One exchange: the user's request, the supervisor's reply listing `item`.
    static func chatModel(ask: String, reply: String, item: SupervisorInboxItem?, retry: SupervisorStatus.MessageRetry? = nil,
                          configure: (SupervisorModel) -> Void = { _ in }) -> SupervisorModel {
        var st = status()
        if let retry {
            st = SupervisorStatus(projectId: st.projectId, revision: st.revision, mode: st.mode, autonomy: st.autonomy, run: st.run,
                                  budget: st.budget, model: st.model, messageRetry: retry)
        }
        return model(st, items: item.map { [$0] } ?? []) { m in
            m.chat = [SupervisorChatMessage(id: "m-9", at: iso(2), from: "user", text: ask)]
                + (item == nil && retry != nil ? [] : [SupervisorChatMessage(id: "r-9", at: iso(1.5), from: "supervisor", text: reply, wakeId: "w-50",
                                                                             origin: .init(messageIds: ["m-9"]), items: item.map { [$0.id] })])
            if let item { m.chatItems = [item.id: item] }
            configure(m)
        }
    }

    /// ADR-0129 — a screenshot-like picture on disk, for the chip and the bubble.
    static var sampleImagePath: String {
        let path = NSTemporaryDirectory() + "marvin-snapshot-terminal.png"
        if FileManager.default.fileExists(atPath: path) { return path }
        let img = NSImage(size: NSSize(width: 640, height: 360), flipped: false) { r in
            NSColor(calibratedWhite: 0.12, alpha: 1).setFill(); r.fill()
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 22, weight: .regular), .foregroundColor: NSColor.systemRed]
            ("✗ retry.test.ts  expected 3 attempts, got 1" as NSString).draw(at: NSPoint(x: 24, y: 300), withAttributes: attrs)
            ("  at backoff (src/http/retry.ts:42)" as NSString).draw(at: NSPoint(x: 24, y: 260), withAttributes: attrs.merging([.foregroundColor: NSColor.lightGray]) { $1 })
            return true
        }
        if let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
        }
        return path
    }

    static let markdownReply = """
    The retry tab's test fails because **`backoff` never retries** on a timeout:

    1. `retry.ts:42` returns on the first `ETIMEDOUT`.
    2. The test expects three attempts.

    ```ts
    if (err.code === "ETIMEDOUT") return err
    ```

    I can ask the tab to fix it — see [the failing run](https://ci.example/run/812).
    """

    static func imageChatModel(reply: String?) -> SupervisorModel {
        model(status()) { m in
            m.chat = earlier + [SupervisorChatMessage(id: "m-9", at: iso(2), from: "user", text: "Why does the retry tab's test fail like this?",
                                                      attachments: [.init(id: "a-1", mediaType: "image/png", bytes: 41_000, path: sampleImagePath)])]
                + (reply.map { [SupervisorChatMessage(id: "r-9", at: iso(1.5), from: "supervisor", text: $0, wakeId: "w-50", origin: .init(messageIds: ["m-9"]))] } ?? [])
        }
    }

    /// An earlier exchange, answered — the conversation a later state continues.
    private static var earlier: [SupervisorChatMessage] {
        [SupervisorChatMessage(id: "m-8", at: iso(40), from: "user", text: "How far along is the retry tab?"),
         SupervisorChatMessage(id: "r-8", at: iso(39.5), from: "supervisor",
                               text: "Six of eight plan steps are done. It is running the retry tests now; the last two steps are the docs and the merge.",
                               wakeId: "w-49", origin: .init(messageIds: ["m-8"]))]
    }

    private static let capItem = guardrail(code: "budget", label: "Daily cap reached",
                                           detail: "$20.00 of $20 spent today — resets at midnight.", verb: "raise-cap")

    private static var capStatus: SupervisorStatus {
        status(run: "paused", pause: .init(reason: "budget", at: iso(2)), open: 1, spent: 20, cap: 20, level: "reached")
    }

    private static var followFeed: [SupervisorFollow] {
        [SupervisorFollow(id: "f-1", sessionId: ids[0], tabTitle: "Add retry with backoff to the HTTP client", until: "merge-ready"),
         SupervisorFollow(id: "f-2", sessionId: ids[3], tabTitle: "Fix the flaky cache test", until: "scope-met")]
    }

    @MainActor
    static var chatStates: [(id: String, title: String, model: () -> SupervisorModel)] {
        [
            ("sup-chat-empty", "Supervisor tab §12.5 — the empty conversation", {
                model(status())
            }),
            ("sup-chat-sending", "Supervisor tab §12.6 — a message sending: the bubble at once, the composer disabled", {
                model(status()) { m in
                    m.chat = earlier
                    m.chatPending = "Tell the retry tab to run the tests before it commits."
                    m.chatSending = true
                }
            }),
            ("sup-chat-working", "Supervisor tab §12.4 — a wake working on the message: Supervisor is reading…", {
                model(status(run: "waking", wake: .init(wakeId: "w-50", startedAt: iso(0.2), itemCount: 1))) { m in
                    m.chat = earlier + [SupervisorChatMessage(id: "m-9", at: iso(0.3), from: "user", text: "Which tab is closest to done?")]
                }
            }),
            ("sup-chat-card-one-click", "Supervisor tab §12.2 — a reversible card (local merge, preview visible): one click", {
                chatModel(ask: "Merge the retry tab into main when you can.", reply: "Merging is yours to click. Here it is, with the merge preview:", item: mergeItem)
            }),
            ("sup-chat-card-outward-collapsed", "Supervisor tab §12.2 — an outward card, collapsed: Review act…, no consent chip", {
                chatModel(ask: "Push the release branch.", reply: "Pushing leaves this Mac, so it's your click — review the act first:", item: pushItem)
            }),
            ("sup-chat-card-outward-expanded", "Supervisor tab §12.2 — the outward card expanded: full act, then Allow push", {
                chatModel(ask: "Push the release branch.", reply: "Pushing leaves this Mac, so it's your click — review the act first:", item: pushItem) {
                    $0.expandedCards = ["inbox-push"]
                }
            }),
            ("sup-chat-card-observe-send", "Supervisor tab [7.2] — an observe send card: names the level, says the message is the supervisor's", {
                chatModel(ask: "Tell the retry tab to run the tests before it commits.", reply: "That tab is at observe, so I can only recommend. Here is the message as a card:", item: sendItem)
            }),
            ("sup-chat-card-settled", "Supervisor tab §12.2 — a settled card: Done — the server's summary", {
                chatModel(ask: "Merge the retry tab into main when you can.", reply: "Merging is yours to click. Here it is, with the merge preview:",
                          item: settled(mergeItem, state: "resolved", by: "user"))
            }),
            ("sup-chat-card-settled-elsewhere", "Supervisor tab §12.2 — a card the tab answered first: one line, no chips", {
                chatModel(ask: "Push the release branch.", reply: "Pushing leaves this Mac, so it's your click — review the act first:",
                          item: settled(pushItem, state: "resolved", by: "tab"))
            }),
            ("sup-chat-follow-open", "Supervisor tab [7.3] — open follows: one chip each above the composer, with Stop following", {
                model(status()) { m in
                    m.chat = [SupervisorChatMessage(id: "m-9", at: iso(30), from: "user", text: "Open a tab to add retry with backoff, and merge it when it's done."),
                              SupervisorChatMessage(id: "r-9", at: iso(29.5), from: "supervisor", text: "It's open and I'm following it. I'll report back when it's done.",
                                                    wakeId: "w-50", origin: .init(messageIds: ["m-9"]))]
                    m.follows = followFeed
                }
            }),
            ("sup-chat-report-refs", "Supervisor tab [7.3] — a follow's report with refs (tab, card) and the merge card it raised", {
                model(status(open: 1)) { m in
                    m.chat = [SupervisorChatMessage(id: "m-9", at: iso(30), from: "user", text: "Open a tab to add retry with backoff, and merge it when it's done."),
                              SupervisorChatMessage(id: "r-9", at: iso(29.5), from: "supervisor", text: "It's open and I'm following it. I'll report back when it's done.",
                                                    wakeId: "w-50", origin: .init(messageIds: ["m-9"])),
                              SupervisorChatMessage(id: "r-10", at: iso(1), from: "supervisor",
                                                    text: "The retry tab met its scope: every plan step is done and the tests pass. The merge you asked for is ready for your click.",
                                                    kind: "report", wakeId: "w-61", origin: .init(followId: "f-1"), items: [mergeItem.id],
                                                    refs: [.init(kind: "tab", id: ids[0], label: "Add retry with backoff to the HTTP client"),
                                                           .init(kind: "item", id: mergeItem.id, label: mergeItem.rawAct?.summary ?? "Merge")])]
                    m.chatItems = [mergeItem.id: mergeItem]
                    // The follow ends when its merge card settles; until then it is still open.
                    m.follows = [followFeed[0]]
                }
            }),
            ("sup-chat-budget-inline", "Supervisor tab ADR-0128 §7 — the budget guardrail inline at the foot of the conversation, with Raise cap…", {
                model(capStatus, items: [capItem]) { m in m.chat = earlier }
            }),
            ("sup-chat-cap-mid-conversation", "Supervisor tab §12.6 — the cap reached mid-conversation: the new message waits, the notice names the cap", {
                model(capStatus, items: [capItem]) { m in
                    m.chat = earlier + [SupervisorChatMessage(id: "m-9", at: iso(1), from: "user", text: "Tell the cache tab to use the in-memory store.")]
                }
            }),
            ("sup-chat-couldnt-answer", "Supervisor tab ADR-0128 §6 — a message the supervisor could not answer: Retry", {
                chatModel(ask: "How far along is the retry tab?", reply: "", item: nil,
                          retry: .init(state: "failed", messageIds: ["m-9"], attempts: 4))
            }),
        ]
    }

    // MARK: - Transcript (§6.8) and the external-answer note (plan M6 required fix)

    static var transcript: [ChatMessage] {
        let askInput = try? JSONDecoder().decode(ChatJSON.self, from: Data(#"{"questions":[{"question":"Which store should the test cache use?","header":"Cache","multiSelect":false,"options":[{"label":"In-memory","description":"Fast, isolated"},{"label":"SQLite","description":"Matches production"}]}]}"#.utf8))
        let resultJSON = ChatToolResult(output: "User has answered your questions: In-memory", isError: false)
        var asked = ChatMessage(id: "a-1", role: .assistant,
                                blocks: [.text(id: "t1", text: "Two stores would work; asking which one the test should use."),
                                         .toolCall(id: "use-q1", name: "AskUserQuestion", input: askInput, result: resultJSON)],
                                isStreaming: false, createdAt: Date())
        asked.supervisorAnswers["use-q1"] = SupervisorAnswerMark(
            decision: "allow", isQuestion: true,
            grounds: [ground("plan-step", "plan:[2]", "Tests must be isolated", strong: true)])
        return [
            .userText("Fix the flaky cache test — keep each run isolated."),
            asked,
            .supervisorTouchedDivider(),
            .supervisorText("MARVIN supervisor message (not from the user).\n<supervisor-message>\nStep [3] is still open: run the cache tests three times before closing it.\n</supervisor-message>",
                            mark: SupervisorMessageMark(kind: "nudge", grounds: [ground("plan-step", "plan:[3]", "Run the suite three times", strong: true)], editedByUser: false)),
            ChatMessage(id: "a-2", role: .assistant, blocks: [.text(id: "t2", text: "Running the cache tests three times now.")],
                        isStreaming: false, createdAt: Date()),
        ]
    }
}

/// The note that replaces a sheet or card answered elsewhere, both variants.
@MainActor struct ExternalAnswerNoteFixture: View {
    var body: some View {
        VStack(spacing: 0) {
            ExternalAnswerNoteRow(note: .init(text: "Answered by the supervisor", bySupervisor: true), onDismiss: {})
            MarvinDivider()
            ExternalAnswerNoteRow(note: .init(text: "Answered elsewhere by you", bySupervisor: false), onDismiss: {})
        }
        .background(MarvinTheme.background)
    }
}

// SurfaceSnapshotFixtures — neutral sample data for the offscreen surface
// snapshot harness (SurfaceSnapshot.swift).
//
// Everything here is invented. No real project, repository, person or path is
// named (Golden Rule 6): the harness is for judging how MARVIN's own UI looks,
// not for reproducing any one project's transcript. Dev-only; nothing in the
// app reads these.

import Foundation
import MARVINLogic
import SwiftUI

enum SurfaceFixtures {
    static let project = "/tmp/demo/Atlas"
    private static let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Chat transcript

    private static func message(_ id: String, _ role: ChatRole, _ blocks: [ChatBlock]) -> ChatMessage {
        ChatMessage(id: id, role: role, blocks: blocks, isStreaming: false, createdAt: epoch)
    }

    /// Decode a ChatJSON literal; `.null` on a typo so a bad fixture renders
    /// as an empty tool input instead of crashing the run.
    static func json(_ raw: String) -> ChatJSON {
        (try? JSONDecoder().decode(ChatJSON.self, from: Data(raw.utf8))) ?? .null
    }

    static let handoffText = """
    **Scope met:** the retry helper was added to the client and covered by a test. Anything else, or should I stop?

    <!-- marvin:scope-met -->
    """

    /// The scope-met handoff on its own: a hand-written closing line followed by
    /// the hidden marker `<!-- marvin:scope-met -->`, which the transcript
    /// renders as visible text (a known bug — see COVERAGE.md).
    static var handoffMessage: ChatMessage {
        message("a2", .assistant, [.text(id: "a2t", text: handoffText)])
    }

    static var transcript: [ChatMessage] {
        [
            message("u1", .user, [.text(id: "u1t", text: "Add a retry with backoff to the HTTP client, and cover it with a test.")]),
            message("a1", .assistant, [
                .thinking(id: "a1k", text: "The client has one request path. A retry wrapper there covers every caller; the test can use a fake transport that fails twice.", redacted: false),
                .text(id: "a1t", text: """
                I'll wrap the request path in `retrying(...)` and keep the policy in one place.

                1. Add `RetryPolicy` with a capped exponential delay.
                2. Route `Client.send` through it.
                3. Test with a transport that fails twice, then succeeds.

                See `src/client.ts:42` for the current request path.
                """),
                .toolCall(id: "tc1", name: "Bash",
                          input: json(#"{"command":"npm test -- --run client","description":"Run the client tests"}"#),
                          result: ChatToolResult(output: "✓ client.test.ts (6 tests) 41ms\n\nTest Files  1 passed (1)\n     Tests  6 passed (6)", isError: false)),
                .toolCall(id: "tc2", name: "Edit",
                          input: json(#"{"file_path":"\#(project)/src/client.ts","old_string":"return fetch(url, init)","new_string":"return retrying(() => fetch(url, init), policy)"}"#),
                          result: ChatToolResult(output: "The file \(project)/src/client.ts has been updated.", isError: false)),
                .toolCall(id: "tc3", name: "Bash",
                          input: json(#"{"command":"npm run typecheck","description":"Typecheck the workspace"}"#),
                          result: ChatToolResult(output: "src/client.ts(58,12): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.", isError: true)),
            ]),
            message("a2", .assistant, [
                .text(id: "a2t", text: handoffText),
            ]),
            message("s1", .system, [.text(id: "s1t", text: "Compacted earlier turns · ~120K tokens freed")]),
        ]
    }

    // MARK: - Confirms and the question sheet

    private static func request(_ raw: String) -> ConfirmRequest? {
        try? JSONDecoder().decode(ConfirmRequest.self, from: Data(raw.utf8))
    }

    static var bashConfirm: ConfirmRequest? {
        request(#"{"turnId":"turn-1","toolUseId":"use-1","toolName":"Bash","input":{"command":"git push origin feature/retry","description":"Push the branch"},"reason":"Pushes commits to a remote"}"#)
    }

    static var planConfirm: ConfirmRequest? {
        request(##"{"turnId":"turn-1","toolUseId":"use-2","toolName":"ExitPlanMode","input":{"plan":"# Plan — Retry with backoff\n1. Add RetryPolicy\n2. Route Client.send through it\n3. Test with a flaky transport"}}"##)
    }

    static var askQuestion: ConfirmRequest? {
        request(#"""
        {"turnId":"turn-1","toolUseId":"use-3","toolName":"AskUserQuestion","input":{"questions":[
          {"question":"Which storage should the response cache use?","header":"Storage","multiSelect":false,"options":[
            {"label":"In-memory","description":"Fastest, lost on restart."},
            {"label":"SQLite file","description":"Survives restarts, one extra dependency."},
            {"label":"Skip the cache","description":"Keep the client stateless for now."}]},
          {"question":"Which checks should run before merging?","header":"Checks","multiSelect":true,"options":[
            {"label":"Unit tests","description":"The fast suite."},
            {"label":"Typecheck","description":"The whole workspace."},
            {"label":"Lint","description":"Style and import order."}]}
        ]}}
        """#)
    }

    // MARK: - Backlog

    static var backlogItem: BacklogItem? {
        let raw = #"""
        {"id":"retry-jitter","title":"Add jitter to the retry delay","body":"The capped exponential delay synchronises clients that fail together. Add full jitter and a test that pins the range.","status":"open","severity":"med","created":"2023-11-14","kind":"feature","blocked":false}
        """#
        return try? JSONDecoder().decode(BacklogItem.self, from: Data(raw.utf8))
    }

    // MARK: - Chat input

    static let draft = "Please also log each retry attempt at debug level."
}

/// Holds the bindings `ChatInputBar` wants, so a fixture can mount the real
/// view without a session behind it.
@MainActor struct ChatInputFixture: View {
    @State private var text: String
    @State private var attachments: [ChatAttachment] = []
    let isSending: Bool

    init(text: String, isSending: Bool) {
        _text = State(initialValue: text)
        self.isSending = isSending
    }

    var body: some View {
        ChatInputBar(
            text: $text,
            onSubmit: {},
            onStop: {},
            onStopAll: {},
            isSending: isSending,
            activityLabel: isSending ? "Using Bash" : nil,
            queuedCount: isSending ? 1 : 0,
            attachments: $attachments
        )
    }
}


// MARK: - Bridge state for the populated surfaces

extension SurfaceFixtures {
    static let openFiles = [
        "Sources/App/ContentView.swift",
        "Sources/App/Services/SyncService.swift",
        "Sources/App/Models/UsageLedger.swift",
    ]

    /// Put the shared bridge in the state of a session in use: three projects
    /// with one active, a branch that is ahead and behind, files open, a
    /// context that is filling, a cost and a graph-to-reads ratio. These are
    /// plain stored properties the live services write; the harness writes them
    /// directly instead of waiting for polls that need an active app.
    @MainActor static func populateBridge(_ b: MarvinBridge) {
        // Files are opened while no project is active so the bridge does not
        // persist this fixture's tabs into the user's real preferences.
        b.applyProjectsLoad(projects: [], activeId: nil)
        for f in openFiles { b.setSelectedFile("\(project)/\(f)") }
        b.applyProjectsLoad(projects: [
            BridgeProject(id: "prj_atlas", name: "Atlas", workDir: project),
            BridgeProject(id: "prj_harbor", name: "Harbor", workDir: "/tmp/demo/Harbor"),
            BridgeProject(id: "prj_notes", name: "Field Notes", workDir: "/tmp/demo/Notes"),
        ], activeId: "prj_atlas")
        b.setCursor(row: 42, col: 9, selectionLength: 0)
        b.setCursorTotalLines(68)

        b.branch = "feature/usage-ledger"
        b.branchDirtyCount = 12
        b.branchUpstream = "origin/feature/usage-ledger"
        b.branchAhead = 3
        b.branchBehind = 1
        b.dirtyStatus = [
            "Sources/App/Services/SyncService.swift": "MM", "Sources/App/Models/Project.swift": "A",
            "docs/architecture.md": "M", "Tests/AtlasTests/LegacyTests.swift": "D",
            "Sources/App/Services/ApiClient.swift": "R", "Sources/App/Models/UsageLedger.swift": "M",
            "web/src/legacy.ts": "D", "web/src/router.ts": "M", "Sources/App/ContentView.swift": "M",
            "scripts/seed.sh": "??", ".env.local": "??", "notes/todo.md": "??",
        ].reduce(into: [:]) { $0["\(project)/\($1.key)"] = $1.value }

        b.errorCount = 2
        b.warningCount = 7
        b.residentContextTokens = 118_000
        b.billableThisTurn = 9_400
        b.reportedContextWindow = 200_000
        b.sessionGraphCalls = 31
        b.sessionFileReadCalls = 74
        b.sessionGraphSummaryCalls = 2

        b.costSummary = CostSummary(
            today: 1.84, week: 9.62, lifetime: 47.3, turns: 402, inputTokens: 5_402_100, outputTokens: 690_300,
            daily: [
                .init(day: "2026-10-30", costUsd: 1.84, turns: 12), .init(day: "2026-10-29", costUsd: 1.55, turns: 14),
                .init(day: "2026-10-28", costUsd: 1.78, turns: 13), .init(day: "2026-10-27", costUsd: 1.15, turns: 9),
            ],
            openRouter: nil,
            claudeWindows: [
                .init(type: "five_hour", status: "allowed", utilization: 0.35, resetsAt: 1_793_329_200, isUsingOverage: false),
                .init(type: "seven_day", status: "allowed_warning", utilization: 0.55, resetsAt: 1_793_491_200, isUsingOverage: false),
            ])
        b.executorModel = "claude-opus-5"
        b.advisorModel = "claude-sonnet-5"
        b.appendNotification("Backlog item claimed by a tab")

        for event in [
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"scout"}}]}}"#,
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"implementer"}}]}}"#,
            #"{"type":"system","subtype":"task_started","task_type":"local_agent","task_id":"t1","subagent_type":"implementer","is_backgrounded":true}"#,
            #"{"type":"system","subtype":"task_started","task_type":"local_agent","task_id":"t2","subagent_type":"scout","is_backgrounded":false}"#,
            #"{"type":"system","subtype":"task_notification","task_id":"t2","status":"completed"}"#,
        ] { _ = b.subagents.apply(cliEventData: Data(event.utf8)) }
    }
}

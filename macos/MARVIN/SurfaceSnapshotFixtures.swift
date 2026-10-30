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
    static let project = "/tmp/example-project"
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
                          input: json(#"{"file_path":"/tmp/example-project/src/client.ts","old_string":"return fetch(url, init)","new_string":"return retrying(() => fetch(url, init), policy)"}"#),
                          result: ChatToolResult(output: "The file /tmp/example-project/src/client.ts has been updated.", isError: false)),
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
struct ChatInputFixture: View {
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

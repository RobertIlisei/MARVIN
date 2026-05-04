// ChatService — native SSE client for the Phase 2 chat surface.
//
// Phase 2a foundation. Talks to the Node sidecar's /api/chat endpoint
// (POST → SSE stream), parses the SSE wire format into `ChatTurnEvent`
// values, and surfaces them as an `AsyncStream` the UI layer consumes.
//
// ## Why URLSession's bytes(from:) instead of Server-Sent-Events libs
//
// macOS 12+ ships `URLSession.bytes(for:)` which gives us an
// `AsyncSequence<UInt8>` with backpressure semantics that map cleanly
// onto the SSE wire format. Pulling in a third-party SSE library
// would be ceremony; the wire format is small (3 line types we care
// about) and we control both ends, so the parser is short and
// auditable.
//
// ## SSE wire format (RFC, simplified for what /api/chat emits)
//
//   event: <name>\n
//   data: <json>\n
//   \n          ← blank line terminates the event
//
// Comments (lines starting with `:`) and `id:` / `retry:` lines are
// allowed by the spec but the sidecar doesn't emit them. We tolerate
// them anyway — robust to future server-side additions.
//
// ## Cancellation
//
// `streamTurn` returns an `AsyncThrowingStream` whose `Task` can be
// cancelled by the consumer. The HTTP request is bound to the same
// task, so cancelling tears down the stream cleanly — though note
// that this only stops *receiving* events. To stop the underlying
// agent run, the consumer must call POST /api/chat/cancel separately
// (Phase 2f).

import Foundation

/// Errors surfaced by the chat service. UI layer pattern-matches on
/// these to render appropriate failure states.
enum ChatServiceError: Error {
    /// Non-2xx HTTP response from /api/chat.
    case httpStatus(Int, body: String?)
    /// SSE event received with malformed JSON in its data line.
    case malformedEvent(name: String, raw: String)
    /// URLSession-level network failure.
    case transport(underlying: Error)
}

/// Singleton service. The sidecar URL is hardcoded to localhost:3030
/// to match the rest of the SwiftUI app — Phase 2 inherits Phase 1's
/// "the sidecar is the trust boundary, accessed via loopback" choice
/// from ADR-0016.
@MainActor
final class ChatService {
    static let shared = ChatService()

    private let baseURL = URL(string: "http://localhost:3030")!
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        // SSE turns are long-lived — a 60s default is too short for
        // a chat turn that runs a Bash + Edit + Read sequence.
        // Disable the per-resource timeout entirely and rely on
        // /api/chat/cancel + connection reset for termination.
        config.timeoutIntervalForRequest = 0
        config.timeoutIntervalForResource = 0
        // Pin to the loopback route. The Phase 1 NSAllowsLocalNetworking
        // ATS exception in Info.plist is what makes this allowed at
        // all; a non-loopback baseURL would need additional plumbing.
        self.session = URLSession(configuration: config)
    }

    /// POST /api/confirm — respond to a `confirm.request` event with
    /// allow / deny. Phase 2e. The sidecar's resolver is keyed by
    /// (turnId, toolUseId); failing to call this hangs the agent
    /// until the turn aborts via /api/chat/cancel or the SDK times
    /// out. `denyMessage` is shown back to the model when denying —
    /// callers can pass nil to use the sidecar's default ("user
    /// denied the tool use").
    enum ConfirmDecision: String {
        case allow
        case deny
    }

    func respondToConfirm(
        turnId: String,
        toolUseId: String,
        decision: ConfirmDecision,
        denyMessage: String? = nil
    ) async throws {
        let url = baseURL.appendingPathComponent("api/confirm")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")

        var body: [String: Any] = [
            "turnId": turnId,
            "toolUseId": toolUseId,
            "decision": decision.rawValue,
        ]
        if decision == .deny, let denyMessage, !denyMessage.isEmpty {
            body["message"] = denyMessage
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw ChatServiceError.httpStatus(http.statusCode, body: body)
        }
    }

    /// POST /api/chat with `request`, then read the SSE response and
    /// yield each parsed event. The stream terminates when the
    /// server closes the connection (turn.completed / turn.error)
    /// or when the consumer cancels the awaiting Task.
    ///
    /// `clientID` is the value of the `x-marvin-client` header the
    /// CSRF guard at apps/web/src/lib/csrf.ts expects. We hardcode
    /// it to "marvin-swift/0.1" — the guard checks any non-empty
    /// header against an allowlist of known client UA prefixes.
    func streamTurn(
        request: ChatRequest
    ) -> AsyncThrowingStream<ChatTurnEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await runTurn(
                        request: request,
                        continuation: continuation
                    )
                    continuation.finish()
                } catch {
                    if !(error is CancellationError) {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func runTurn(
        request: ChatRequest,
        continuation: AsyncThrowingStream<ChatTurnEvent, Error>.Continuation
    ) async throws {
        let url = baseURL.appendingPathComponent("api/chat")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // CSRF guard at apps/web/src/lib/csrf.ts checks for exactly
        // "x-marvin-client: 1" — any other value (including blank)
        // is 403'd. The header's purpose is to force a CORS
        // preflight, not authenticate the client; a drive-by tab at
        // another origin can't add the header without first getting
        // an Access-Control-Allow-Origin we never emit. The Swift
        // process is local code we trust; the same value the web
        // marvinFetch() wrapper attaches is the correct one here.
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONEncoder().encode(request)

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            // Drain a small body for the error surface — most /api/chat
            // failures emit a JSON `{ error: ... }`. Cap to ~1KB so a
            // pathological server that returned megabytes doesn't OOM
            // the client.
            var body = ""
            var read = 0
            for try await line in bytes.lines {
                body += line + "\n"
                read += line.utf8.count + 1
                if read > 1024 { break }
            }
            throw ChatServiceError.httpStatus(http.statusCode, body: body)
        }

        // SSE parser — manual byte-level. We accumulate bytes into
        // a `Data` buffer, scan for \n, emit each line as a String,
        // and feed the SSE field parser.
        //
        // Why not `bytes.lines`? URLSession's `AsyncBytes.lines`
        // iterator silently stops yielding partway through a long
        // SSE response on macOS Sonoma — empirical: a smoke turn
        // that emits 7-10 events yields exactly 3 lines via
        // `.lines` before the iterator suspends and never resumes,
        // even though the response is still flowing on the wire
        // (verified with curl). The cli.event payloads can be
        // 10KB+ on one line (full Claude CLI tools list + MCP
        // servers + slash commands) — likely an interaction with
        // AsyncBytes' internal line buffer. Manual buffering
        // sidesteps whatever async-bridge state machine causes the
        // drop and is independently auditable.
        var lineBuffer = Data()
        var currentName: String? = nil
        var currentData = ""

        func emitLine(_ line: String) throws {
            if line.isEmpty {
                if let name = currentName {
                    let event = ChatStreamEvent(
                        name: name,
                        data: Data(currentData.utf8)
                    )
                    let parsed = try Self.decode(event: event)
                    continuation.yield(parsed)
                }
                currentName = nil
                currentData = ""
                return
            }
            if line.hasPrefix(":") { return }  // SSE comment
            if let value = parseField(prefix: "event: ", line: line) {
                currentName = value
            } else if let value = parseField(prefix: "data: ", line: line) {
                // Multi-line `data:` allowed by the spec —
                // concatenate with newline. /api/chat doesn't
                // currently emit multi-line, but be tolerant.
                if currentData.isEmpty {
                    currentData = value
                } else {
                    currentData += "\n" + value
                }
            }
            // `id:` / `retry:` lines silently ignored.
        }

        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == 0x0A {  // '\n'
                let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                lineBuffer.removeAll(keepingCapacity: true)
                try emitLine(line)
            } else if byte != 0x0D {  // skip '\r'
                lineBuffer.append(byte)
            }
        }

        // Stream ended without a final \n — flush any buffered line.
        // /api/chat always closes after a blank-line terminator so
        // this normally has nothing to do.
        if !lineBuffer.isEmpty {
            let line = String(data: lineBuffer, encoding: .utf8) ?? ""
            try? emitLine(line)
        }
        if let name = currentName, !currentData.isEmpty {
            let event = ChatStreamEvent(name: name, data: Data(currentData.utf8))
            if let parsed = try? Self.decode(event: event) {
                continuation.yield(parsed)
            }
        }
    }

    private func parseField(prefix: String, line: String) -> String? {
        guard line.hasPrefix(prefix) else { return nil }
        return String(line.dropFirst(prefix.count))
    }

    /// Decode a typed `ChatTurnEvent` from one SSE envelope. Unknown
    /// event names route through `.unknown` so the consumer can log
    /// + ignore without crashing.
    static func decode(event: ChatStreamEvent) throws -> ChatTurnEvent {
        let decoder = JSONDecoder()
        switch event.name {
        case "turn.started":
            return .turnStarted(try decoder.decode(TurnStarted.self, from: event.data))
        case "cli.event":
            return .cliEvent(event.data)
        case "confirm.request":
            return .confirmRequest(try decoder.decode(ConfirmRequest.self, from: event.data))
        case "turn.completed":
            return .turnCompleted(try decoder.decode(TurnCompleted.self, from: event.data))
        case "turn.error":
            return .turnError(try decoder.decode(TurnError.self, from: event.data))
        default:
            return .unknown(name: event.name, data: event.data)
        }
    }
}

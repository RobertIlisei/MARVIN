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

/// A new turn was registered server-side (`GET /api/chat/announce`, ADR-0043).
/// Mirrors the `TurnAnnouncement` shape in `turn-registry.ts`. The client uses
/// it only to decide whether to re-attach to a server-initiated turn — the turn
/// itself renders through the existing resume path, not from this payload.
struct TurnAnnouncement: Decodable, Sendable {
    let marvinSessionId: String
    let projectId: String
    let turnId: String
    let startedAt: Double
}

/// Singleton service. Sidecar URL comes from ServerConfig (MARVIN_PORT env var,
/// default 3030) — Phase 2 inherits Phase 1's "the sidecar is the trust
/// boundary, accessed via loopback" choice from ADR-0016.
@MainActor
final class ChatService {
    static let shared = ChatService()

    private let baseURL = ServerConfig.baseURL
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

    /// POST /api/chat/cancel — abort an in-flight turn on the
    /// sidecar. Separate from the SSE body close so closing the
    /// stream subscriber locally doesn't kill the agent by
    /// accident; this is the explicit "user hit ⌘." path.
    /// Phase 2f. The sidecar keys on marvinSessionId; cancelling
    /// returns whether a turn was actually live to cancel.
    @discardableResult
    func cancelTurn(marvinSessionId: String) async throws -> Bool {
        let url = baseURL.appendingPathComponent("api/chat/cancel")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["marvinSessionId": marvinSessionId]
        )
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ChatServiceError.httpStatus(
                http.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }
        // The body shape is { cancelled: bool } — false means there
        // was no live turn for that id (already finished). Surface
        // it so callers can decide whether to log "already done"
        // vs treat as success.
        struct CancelResponse: Codable { let cancelled: Bool }
        if let parsed = try? JSONDecoder().decode(CancelResponse.self, from: data) {
            return parsed.cancelled
        }
        return true
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
        denyMessage: String? = nil,
        updatedInput: [String: Any]? = nil
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
        // ADR-0040 — AskUserQuestion returns the chosen answer as the tool
        // result via `updatedInput` (the AskUserQuestionOutput). The route
        // forwards it straight to the SDK's PermissionResult.
        if decision == .allow, let updatedInput {
            body["updatedInput"] = updatedInput
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

    /// GET /api/sessions?projectId=…
    ///
    /// Returns every transcript on disk for the project, newest
    /// first, with a short preview of the first user message so the
    /// native Sessions picker can label them usefully. Phase 3 add-
    /// on (post-2h) — was supposed to land in 2h, but the
    /// localStorage-only path missed transcripts that exist on disk
    /// without a corresponding browser-state entry (e.g. fresh
    /// install of MARVIN-Swift on a machine that has prior web
    /// sessions). This route + the Sessions menu in ChatPreviewView
    /// closes that gap.
    func fetchSessions(projectId: String) async throws -> SessionsListResponse {
        let url = baseURL.appendingPathComponent("api/sessions")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "projectId", value: projectId)]
        guard let composed = comps.url else {
            throw ChatServiceError.transport(underlying: URLError(.badURL))
        }
        var req = URLRequest(url: composed)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ChatServiceError.httpStatus(
                http.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }
        return try JSONDecoder().decode(SessionsListResponse.self, from: data)
    }

    /// GET /api/sessions/[sessionId]?projectId=…  — load a stored
    /// transcript from the sidecar's on-disk JSONL log. Phase 2h. The
    /// sidecar is the source of truth for past turns; this lets the
    /// native chat surface hydrate its message list on project switch
    /// or app launch without re-running anything.
    ///
    /// Returns nil for 404 (no session file for that id+project).
    /// Throws on transport / decode failures so the caller can show
    /// an inline error instead of a silently-empty list.
    func fetchSession(
        projectId: String,
        sessionId: String,
        tail: Int? = nil
    ) async throws -> SessionRecord? {
        let url = baseURL
            .appendingPathComponent("api/sessions")
            .appendingPathComponent(sessionId)
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items: [URLQueryItem] = [URLQueryItem(name: "projectId", value: projectId)]
        if let tail { items.append(URLQueryItem(name: "tail", value: String(tail))) }
        comps.queryItems = items
        guard let composed = comps.url else {
            throw ChatServiceError.transport(underlying: URLError(.badURL))
        }
        var req = URLRequest(url: composed)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        if http.statusCode == 404 {
            return nil
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ChatServiceError.httpStatus(
                http.statusCode,
                body: String(data: data, encoding: .utf8)
            )
        }
        // Decode off the main actor. SessionRecord can be 100+ MB for
        // long-running sessions (314 turns × tool I/O = ~120 MB seen in
        // the field). Decoding that on @MainActor freezes the UI for
        // multiple seconds during launch / project switch — Task.detached
        // moves it to the userInitiated cooperative pool. `tail`-capped
        // hydrates are fast either way; this matters for the manual
        // history-pick path that intentionally pulls the full transcript.
        return try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionRecord.self, from: data)
        }.value
    }

    /// GET /api/chat/resume?marvinSessionId=…  — attach to a live
    /// in-memory turn bus and stream further events. Same SSE wire
    /// shape as POST /api/chat. Phase 2h.
    ///
    /// Returns an empty (already-finished) stream when the server
    /// replies 204 — that means there's no live turn to attach to,
    /// and the caller should treat the hydrated transcript as the
    /// final state. Any other non-2xx throws as `httpStatus`.
    ///
    /// The stream terminates the same way `streamTurn` does — on
    /// turn.completed / turn.error, on consumer cancel, or on server
    /// close. The underlying agent run is NOT cancelled when the
    /// consumer cancels; the resume route is read-only over a shared
    /// event bus.
    func attachLive(
        marvinSessionId: String
    ) -> AsyncThrowingStream<ChatTurnEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await runResume(
                        marvinSessionId: marvinSessionId,
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

    private func runResume(
        marvinSessionId: String,
        continuation: AsyncThrowingStream<ChatTurnEvent, Error>.Continuation
    ) async throws {
        let url = baseURL.appendingPathComponent("api/chat/resume")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "marvinSessionId", value: marvinSessionId),
        ]
        guard let composed = comps.url else {
            throw ChatServiceError.transport(underlying: URLError(.badURL))
        }
        var req = URLRequest(url: composed)
        req.httpMethod = "GET"
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        if http.statusCode == 204 {
            // No live turn — caller should rely on the transcript
            // it already hydrated. Drain the (empty) body so URLSession
            // doesn't leave the connection lingering, then return.
            for try await _ in bytes { /* drain */ }
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = ""
            var read = 0
            for try await line in bytes.lines {
                body += line + "\n"
                read += line.utf8.count + 1
                if read > 1024 { break }
            }
            throw ChatServiceError.httpStatus(http.statusCode, body: body)
        }

        // Same byte-level SSE parser as runTurn. Factor-shared via
        // a private helper would be cleaner, but the parser is small
        // (~30 lines) and inlining keeps each entry-point easy to
        // audit independently.
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
                    // resume.attached is a non-terminal native-only
                    // event — surface as .unknown so the consumer can
                    // log it but the stream stays open until a real
                    // terminal event lands. The `decode` helper
                    // already maps unknown names that way.
                }
                currentName = nil
                currentData = ""
                return
            }
            if line.hasPrefix(":") { return }
            if let value = parseField(prefix: "event: ", line: line) {
                currentName = value
            } else if let value = parseField(prefix: "data: ", line: line) {
                if currentData.isEmpty {
                    currentData = value
                } else {
                    currentData += "\n" + value
                }
            }
        }

        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == 0x0A {
                let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                lineBuffer.removeAll(keepingCapacity: true)
                try emitLine(line)
            } else if byte != 0x0D {
                lineBuffer.append(byte)
            }
        }
        if !lineBuffer.isEmpty {
            let line = String(data: lineBuffer, encoding: .utf8) ?? ""
            try? emitLine(line)
        }
    }

    /// Hold the per-project announce stream open (`GET /api/chat/announce`)
    /// and yield each `turn.registered` announcement. ADR-0043: lets an idle
    /// client learn a turn it did NOT start has begun (a background-job
    /// completion or a timed wakeup) so it can re-attach via `attachLive`.
    ///
    /// Read-only and long-lived — it never terminates on its own; the consumer
    /// cancels (project closed) or the server closes. The caller is expected to
    /// reconnect on a clean finish (the heartbeat-reaped server side, or a
    /// dropped loopback connection).
    func announceStream(
        projectId: String
    ) -> AsyncThrowingStream<TurnAnnouncement, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await runAnnounce(
                        projectId: projectId,
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

    private func runAnnounce(
        projectId: String,
        continuation: AsyncThrowingStream<TurnAnnouncement, Error>.Continuation
    ) async throws {
        let url = baseURL.appendingPathComponent("api/chat/announce")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "projectId", value: projectId)]
        guard let composed = comps.url else {
            throw ChatServiceError.transport(underlying: URLError(.badURL))
        }
        var req = URLRequest(url: composed)
        req.httpMethod = "GET"
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.transport(
                underlying: URLError(.badServerResponse)
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = ""
            var read = 0
            for try await line in bytes.lines {
                body += line + "\n"
                read += line.utf8.count + 1
                if read > 1024 { break }
            }
            throw ChatServiceError.httpStatus(http.statusCode, body: body)
        }

        // Minimal SSE parse — we only care about `turn.registered` frames,
        // whose `data:` is a TurnAnnouncement JSON. `announce.attached` and
        // `: ping` heartbeats are ignored (they keep the stream warm).
        var lineBuffer = Data()
        var currentName: String? = nil
        var currentData = ""
        let decoder = JSONDecoder()

        func emitLine(_ line: String) {
            if line.isEmpty {
                if currentName == "turn.registered",
                   let ann = try? decoder.decode(
                       TurnAnnouncement.self,
                       from: Data(currentData.utf8)
                   ) {
                    continuation.yield(ann)
                }
                currentName = nil
                currentData = ""
                return
            }
            if line.hasPrefix(":") { return }
            if let value = parseField(prefix: "event: ", line: line) {
                currentName = value
            } else if let value = parseField(prefix: "data: ", line: line) {
                currentData = currentData.isEmpty ? value : currentData + "\n" + value
            }
        }

        for try await byte in bytes {
            try Task.checkCancellation()
            if byte == 0x0A {
                let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                lineBuffer.removeAll(keepingCapacity: true)
                emitLine(line)
            } else if byte != 0x0D {
                lineBuffer.append(byte)
            }
        }
    }

    /// POST /api/chat with `request`, then read the SSE response and
    /// yield each parsed event. The stream terminates when the
    /// server closes the connection (turn.completed / turn.error)
    /// or when the consumer cancels the awaiting Task.
    ///
    /// `clientID` is the value of the `x-marvin-client` header the
    /// CSRF guard at sidecar/src/lib/csrf.ts expects. We hardcode
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
        // CSRF guard at sidecar/src/lib/csrf.ts checks for exactly
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

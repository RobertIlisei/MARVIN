// ChatTypes — Codable models for the SSE wire format between the
// Swift native chat island and the Node sidecar at apps/web.
//
// Phase 2a foundation. The wire contract is documented in
// docs/decisions/0017-phase-2-chat-native.md §1 — this file is the
// Swift-side mirror of the shapes apps/web/src/app/api/chat/route.ts
// emits.
//
// Design notes:
//
// • The SSE stream is heterogeneous — different `event` types carry
//   different payload shapes. We model that as an enum of cases, each
//   with its own associated payload struct, and decode by branching
//   on the event name string. There's no enum case for unknown
//   events — we surface them as `.unknown(name:)` so the consumer can
//   log + ignore without crashing on a future server-side event we
//   haven't taught the client about yet.
//
// • cli.event is itself a discriminated union (Claude CLI stream-json
//   shape). We parse the outer SSE envelope here; the inner shape
//   (assistant / user / system / result messages) is decoded lazily
//   by the consumer because the message-list view will be the place
//   that knows what to do with each variant. This keeps ChatTypes
//   tight and stops it from absorbing every Claude CLI shape change.
//
// • Forward compatibility: every Codable struct here uses
//   `decodeIfPresent` for non-required fields. The sidecar can add
//   new fields to a payload without breaking the Swift client.

import Foundation

// MARK: - Outer SSE envelope

/// One event off the SSE stream. The `name` is the SSE `event:` line;
/// `data` is the raw JSON value from the corresponding `data:` line —
/// kept as `Data` because each event name has its own decoder.
struct ChatStreamEvent {
    let name: String
    let data: Data
}

/// Decoded SSE event with its typed payload. `cliEvent` is left
/// undecoded at this layer — the consumer reaches into its raw Data
/// when it's ready to render a specific message type.
enum ChatTurnEvent {
    case turnStarted(TurnStarted)
    case cliEvent(Data)
    case confirmRequest(ConfirmRequest)
    case turnCompleted(TurnCompleted)
    case turnError(TurnError)
    case unknown(name: String, data: Data)
}

// MARK: - Payload structs (one per known event name)

/// Emitted at the start of a turn AND echoed to late-joining
/// subscribers when they connect via /api/chat/resume.
/// Phase 2 only needs `marvinSessionId` + `turnId`; the rest is
/// decoded lazily and may be empty depending on the runtime mode.
struct TurnStarted: Codable {
    let turnId: String
    let marvinSessionId: String
    let projectId: String?
    let cwd: String?
    let model: String?
    let advisorModel: String?
    let permissionStrategy: String?
    let personality: String?
}

/// A tool call awaiting user decision. The web side renders this as
/// the Allow / Allow Always / Deny card; native will render it as
/// a sheet in Phase 2e.
struct ConfirmRequest: Codable {
    /// Unique id for this specific confirm — POST it back to
    /// /api/confirm/respond with the user's decision.
    let confirmId: String
    /// Tool name (Bash, Edit, Write, etc.).
    let tool: String
    /// Free-text human description ("run `npm test`", "edit foo.ts").
    let description: String?
    /// Tool-specific input — Bash command, file path + new contents,
    /// etc. Kept as raw JSON so each tool's renderer can decode its
    /// own slice without bloating this struct.
    let input: ChatJSON?
}

/// Terminal event for a successful turn.
struct TurnCompleted: Codable {
    let sessionId: String?
    let marvinSessionId: String?
    let turnId: String?
    let durationMs: Int?
    let costUsd: Double?
    let tokenUsage: TokenUsage?
}

struct TokenUsage: Codable {
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheCreationTokens: Int?
    let cacheReadTokens: Int?
}

/// Terminal event for a failed turn. `error` is the human-readable
/// reason — log it, surface in the UI as a red banner with retry.
struct TurnError: Codable {
    let error: String
}

// MARK: - Request bodies

/// /api/chat POST body. Fields marked optional are server-defaultable
/// — the sidecar fills them from project context / user prefs when
/// the client doesn't send them. Phase 2b will start by sending only
/// `message` + `cwd` + `marvinSessionId`; later sub-phases add the
/// rest as the corresponding native settings surfaces light up.
struct ChatRequest: Codable {
    let message: String
    let cwd: String?
    let projectId: String?
    let sessionId: String?
    let marvinSessionId: String?
    let personality: String?
    let model: String?
    let advisorModel: String?
    let runtimeMode: String?
    let permissionStrategy: String?

    init(
        message: String,
        cwd: String? = nil,
        projectId: String? = nil,
        sessionId: String? = nil,
        marvinSessionId: String? = nil,
        personality: String? = nil,
        model: String? = nil,
        advisorModel: String? = nil,
        runtimeMode: String? = nil,
        permissionStrategy: String? = nil
    ) {
        self.message = message
        self.cwd = cwd
        self.projectId = projectId
        self.sessionId = sessionId
        self.marvinSessionId = marvinSessionId
        self.personality = personality
        self.model = model
        self.advisorModel = advisorModel
        self.runtimeMode = runtimeMode
        self.permissionStrategy = permissionStrategy
    }
}

// MARK: - Loose JSON value

/// A passthrough JSON value used for opaque sub-structures (tool
/// inputs, the inner cli.event shape). Decodes anything; re-encodes
/// to its original shape. Equatable so SwiftUI diffs cells correctly
/// when the same tool input recurs.
enum ChatJSON: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ChatJSON])
    case object([String: ChatJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let v = try? container.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? container.decode(Double.self) {
            self = .number(v)
        } else if let v = try? container.decode(String.self) {
            self = .string(v)
        } else if let v = try? container.decode([ChatJSON].self) {
            self = .array(v)
        } else if let v = try? container.decode([String: ChatJSON].self) {
            self = .object(v)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unrecognised JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }
}

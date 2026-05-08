// ChatTypes — Codable models for the SSE wire format between the
// Swift native chat island and the Node sidecar at sidecar.
//
// Phase 2a foundation. The wire contract is documented in
// docs/decisions/0017-phase-2-chat-native.md §1 — this file is the
// Swift-side mirror of the shapes sidecar/src/app/api/chat/route.ts
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
    let thinkingMode: String?
    /// ADR-0022 §3 follow-up: true when the sidecar started this turn
    /// without resuming a prior SDK session (either a brand-new
    /// transcript or an explicit `resetSdkSession: true`). The
    /// AppStatusBar uses this to clear the resident-context counter
    /// optimistically so the user sees the reset took effect.
    let sdkSessionFresh: Bool?
}

/// A tool call awaiting user decision. Sidecar emits this when
/// permissionStrategy is "gated" and the tool isn't on the auto-allow
/// list. The web side renders an inline Allow/Deny card; native
/// renders a modal sheet (Phase 2e). Decision goes back via
/// POST /api/confirm with { turnId, toolUseId, decision }.
///
/// Wire shape mirrors the runtime's ConfirmRequestPayload — see
/// packages/runtime/src/sdk-runner.ts. Adding a field server-side
/// without bumping this struct is safe because every field is
/// optional except the two ids.
struct ConfirmRequest: Codable {
    /// Turn id — required for the response. The same one in
    /// turn.started.
    let turnId: String
    /// Tool-call id assigned by the SDK. The response API keys
    /// (turnId, toolUseId) → registered resolver.
    let toolUseId: String
    /// Tool name (Bash, Edit, Write, …). Drives the per-tool
    /// renderer in the confirm sheet.
    let toolName: String
    /// Tool-specific input — Bash command, file path + new contents,
    /// etc. Kept as raw JSON so the existing per-tool input view
    /// can render it without translation.
    let input: ChatJSON?
    /// Free-text reason from the policy ("dangerous", "edits a file
    /// outside cwd", etc.). Helps the user judge why the confirm
    /// was raised.
    let reason: String?
    /// Optional human-facing surfaces the SDK emits per tool —
    /// title is short ("Run `npm test`"), description is longer.
    let title: String?
    let description: String?
    let displayName: String?
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
    /// Thinking mode (Fast / Thinking / Max). Optional — sidecar
    /// defaults to "thinking" (= SDK effort high) when absent, which
    /// matches MARVIN's prior behaviour, so old clients keep working.
    let thinkingMode: String?
    /// ADR-0022 §3 follow-up: when true, the sidecar starts the next
    /// SDK turn with a fresh server-side session — drops the
    /// cumulative cache that drives latency without losing the
    /// visible chat. Set by clicking the "Reset context" chip on the
    /// AppStatusBar context segment.
    let resetSdkSession: Bool?

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
        permissionStrategy: String? = nil,
        thinkingMode: String? = nil,
        resetSdkSession: Bool? = nil
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
        self.thinkingMode = thinkingMode
        self.resetSdkSession = resetSdkSession
    }
}

// MARK: - Session summary list

/// One entry from GET /api/sessions?projectId=… — drives the
/// "Sessions" menu in ChatPreviewView's header so users can pick
/// a past transcript without having to remember its uuid. Mirrors
/// `SessionSummary` in sidecar/src/app/api/sessions/route.ts.
struct SessionSummary: Codable, Equatable, Identifiable {
    let sessionId: String
    /// ISO 8601 timestamp of the most-recent write to the JSONL file.
    let updatedAt: String
    let bytes: Int
    /// First user message in the transcript, capped server-side at
    /// 120 chars. Nil for sessions whose first event isn't a user
    /// turn (defensive — shouldn't happen for chats started via
    /// /api/chat, but recoveries / external writes might land here).
    let firstUserMessage: String?
    let turnCount: Int

    var id: String { sessionId }
}

/// Wrapper around the `{ projectId, sessions }` response shape.
struct SessionsListResponse: Codable, Equatable {
    let projectId: String
    let sessions: [SessionSummary]
}

// MARK: - Stored session transcript

/// Wire shape returned by GET /api/sessions/[sessionId]?projectId=…
/// — the on-disk JSONL transcript loaded back into memory. Phase 2h.
///
/// Mirrors `SessionRecord` from packages/runtime/src/session.ts. The
/// turns array is heterogeneous (one per JSONL line), discriminated
/// by `type`. We decode the discriminator + the per-type fields with
/// a custom Decoder; unknown types decode as `.unknown` so a future
/// runtime addition doesn't break the client.
struct SessionRecord: Codable {
    let sessionId: String
    let projectId: String
    let turns: [SessionTurn]
}

/// One stored turn from the on-disk JSONL transcript. The set
/// matches the `SessionTurn` union in
/// packages/runtime/src/session.ts. We only care about a subset of
/// fields per turn for replay — the rest decode but aren't surfaced
/// (e.g. token usage on `turn.completed` could drive a footer but
/// hydrate doesn't currently need it).
enum SessionTurn: Codable {
    case turnUser(at: String, message: String)
    case turnStarted(at: String, marvinSessionId: String, turnId: String)
    /// Inner CLI event — preserved as ChatJSON so it can be re-encoded
    /// to Data and fed straight through `ChatStreamReducer.apply`,
    /// the same path the live SSE stream uses. Keeping the replay
    /// pipeline single-source-of-truth means any reducer fix lands
    /// for both surfaces at once.
    case cliEvent(at: String, event: ChatJSON)
    case confirmRequest(at: String, payload: ConfirmRequest)
    case confirmDecision(at: String, turnId: String, toolUseId: String, decision: String)
    case turnCompleted(at: String, durationMs: Int?, costUsd: Double?, sessionId: String?)
    case turnError(at: String, error: String)
    case unknown(type: String, at: String?)

    private enum CodingKeys: String, CodingKey {
        case type, at, message, marvinSessionId, turnId, event, payload,
             toolUseId, decision, durationMs, costUsd, sessionId, error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        let at = try c.decodeIfPresent(String.self, forKey: .at)
        switch type {
        case "turn.user":
            let msg = try c.decode(String.self, forKey: .message)
            self = .turnUser(at: at ?? "", message: msg)
        case "turn.started":
            let sid = try c.decode(String.self, forKey: .marvinSessionId)
            let tid = try c.decode(String.self, forKey: .turnId)
            self = .turnStarted(at: at ?? "", marvinSessionId: sid, turnId: tid)
        case "cli.event":
            let ev = try c.decode(ChatJSON.self, forKey: .event)
            self = .cliEvent(at: at ?? "", event: ev)
        case "confirm.request":
            let p = try c.decode(ConfirmRequest.self, forKey: .payload)
            self = .confirmRequest(at: at ?? "", payload: p)
        case "confirm.decision":
            let tid = try c.decode(String.self, forKey: .turnId)
            let tuid = try c.decode(String.self, forKey: .toolUseId)
            let d = try c.decode(String.self, forKey: .decision)
            self = .confirmDecision(at: at ?? "", turnId: tid, toolUseId: tuid, decision: d)
        case "turn.completed":
            let ms = try c.decodeIfPresent(Int.self, forKey: .durationMs)
            let cost = try c.decodeIfPresent(Double.self, forKey: .costUsd)
            let sid = try c.decodeIfPresent(String.self, forKey: .sessionId)
            self = .turnCompleted(at: at ?? "", durationMs: ms, costUsd: cost, sessionId: sid)
        case "turn.error":
            let err = try c.decode(String.self, forKey: .error)
            self = .turnError(at: at ?? "", error: err)
        default:
            self = .unknown(type: type, at: at)
        }
    }

    /// Encode is implemented for completeness — Phase 2h only needs
    /// decode (replay is one-way). The encoder is the inverse of the
    /// decoder above and lets future writers serialize a transcript
    /// without a separate type.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .turnUser(at, message):
            try c.encode("turn.user", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(message, forKey: .message)
        case let .turnStarted(at, sid, tid):
            try c.encode("turn.started", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(sid, forKey: .marvinSessionId)
            try c.encode(tid, forKey: .turnId)
        case let .cliEvent(at, event):
            try c.encode("cli.event", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(event, forKey: .event)
        case let .confirmRequest(at, payload):
            try c.encode("confirm.request", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(payload, forKey: .payload)
        case let .confirmDecision(at, turnId, toolUseId, decision):
            try c.encode("confirm.decision", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(turnId, forKey: .turnId)
            try c.encode(toolUseId, forKey: .toolUseId)
            try c.encode(decision, forKey: .decision)
        case let .turnCompleted(at, ms, cost, sid):
            try c.encode("turn.completed", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encodeIfPresent(ms, forKey: .durationMs)
            try c.encodeIfPresent(cost, forKey: .costUsd)
            try c.encodeIfPresent(sid, forKey: .sessionId)
        case let .turnError(at, err):
            try c.encode("turn.error", forKey: .type)
            try c.encode(at, forKey: .at)
            try c.encode(err, forKey: .error)
        case let .unknown(type, at):
            try c.encode(type, forKey: .type)
            try c.encodeIfPresent(at, forKey: .at)
        }
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

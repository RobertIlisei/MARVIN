// SessionFeed — the wire shapes of the project-wide session feed (ADR-0107).
//
// `GET /api/chat/announce` carries five events for every session of a
// project — turn.registered, turn.ended, confirm.pending, confirm.resolved,
// session.tree — and `GET /api/sessions/watch` returns the cold-start rows.
// Decoding lives here, in MARVINLogic, so the frame → event mapping is
// pinned by tests instead of by hoping; the app's `ChatService` only pumps
// bytes into `SessionFeedEvent.decode`.
//
// Mirrors `ProjectEvent` and `SessionWatchRow` in the sidecar's
// `turn-registry.ts` / `session-watch.ts`. Every field the client does not
// strictly need is optional, so a sidecar one version ahead or behind never
// makes the whole feed undecodable.

import Foundation

public enum SessionMode: String, Codable, Sendable, Equatable {
    case worktree
    case shared
}

public enum TurnOutcome: String, Codable, Sendable, Equatable {
    case completed
    case error
    case cancelled
}

/// The tree a session runs in, as the sidecar reports it.
public struct SessionTreeWire: Codable, Equatable, Sendable {
    public let mode: SessionMode
    public let slug: String?
    public let path: String?
    public let branch: String?
    public let base: String?
    public let lane: [String]?

    public init(mode: SessionMode, slug: String? = nil, path: String? = nil, branch: String? = nil,
                base: String? = nil, lane: [String]? = nil) {
        self.mode = mode
        self.slug = slug
        self.path = path
        self.branch = branch
        self.base = base
        self.lane = lane
    }
}

public struct PendingConfirmInfo: Codable, Equatable, Sendable {
    public let turnId: String
    public let toolUseId: String
    public let toolName: String
    public let since: String?

    public init(turnId: String, toolUseId: String, toolName: String, since: String? = nil) {
        self.turnId = turnId
        self.toolUseId = toolUseId
        self.toolName = toolName
        self.since = since
    }
}

public struct SessionDiffSummary: Codable, Equatable, Sendable {
    public let added: Int
    public let removed: Int
    public let files: Int
    public let untracked: Int?

    public init(added: Int, removed: Int, files: Int, untracked: Int? = nil) {
        self.added = added
        self.removed = removed
        self.files = files
        self.untracked = untracked
    }
}

public struct SessionPlanProgress: Codable, Equatable, Sendable {
    public let done: Int
    public let total: Int
    public init(done: Int, total: Int) { self.done = done; self.total = total }
}

/// What a session's live turn is doing now (ADR-0107 addendum). The same
/// three states the brain renders; `tool` carries the tool's name.
public enum SessionActivityState: String, Codable, Sendable, Equatable {
    case thinking
    case writing
    case tool
}

/// One live event from the project feed.
public enum SessionFeedEvent: Equatable, Sendable {
    case registered(sessionId: String, turnId: String, kind: String?, startedAt: Double)
    case ended(sessionId: String, turnId: String, outcome: TurnOutcome, costUsd: Double?)
    case confirmPending(sessionId: String, turnId: String, toolUseId: String, toolName: String)
    case confirmResolved(sessionId: String, turnId: String, toolUseId: String)
    case tree(sessionId: String, tree: SessionTreeWire)
    case activity(sessionId: String, turnId: String, state: SessionActivityState, tool: String?)

    private struct Registered: Decodable {
        let marvinSessionId: String; let turnId: String; let kind: String?; let startedAt: Double
    }
    private struct Ended: Decodable {
        let marvinSessionId: String; let turnId: String; let outcome: String
        let cancelled: Bool?; let costUsd: Double?
    }
    private struct Pending: Decodable {
        let marvinSessionId: String; let turnId: String; let toolUseId: String; let toolName: String
    }
    private struct Resolved: Decodable {
        let marvinSessionId: String; let turnId: String; let toolUseId: String
    }
    private struct Tree: Decodable {
        let marvinSessionId: String; let tree: SessionTreeWire
    }
    private struct Activity: Decodable {
        let marvinSessionId: String; let turnId: String; let state: SessionActivityState; let tool: String?
    }

    /// Decode one SSE frame. nil = not a feed event (`announce.attached`,
    /// heartbeats, an unknown name) or malformed data. Never throws: a bad
    /// frame must not tear down a stream that every other tab depends on.
    public static func decode(name: String, data: Data) -> SessionFeedEvent? {
        let d = JSONDecoder()
        switch name {
        case "turn.registered":
            guard let r = try? d.decode(Registered.self, from: data) else { return nil }
            return .registered(sessionId: r.marvinSessionId, turnId: r.turnId, kind: r.kind, startedAt: r.startedAt)
        case "turn.ended":
            guard let e = try? d.decode(Ended.self, from: data) else { return nil }
            let outcome: TurnOutcome = e.cancelled == true ? .cancelled : (e.outcome == "completed" ? .completed : .error)
            return .ended(sessionId: e.marvinSessionId, turnId: e.turnId, outcome: outcome, costUsd: e.costUsd)
        case "confirm.pending":
            guard let p = try? d.decode(Pending.self, from: data) else { return nil }
            return .confirmPending(sessionId: p.marvinSessionId, turnId: p.turnId, toolUseId: p.toolUseId, toolName: p.toolName)
        case "confirm.resolved":
            guard let r = try? d.decode(Resolved.self, from: data) else { return nil }
            return .confirmResolved(sessionId: r.marvinSessionId, turnId: r.turnId, toolUseId: r.toolUseId)
        case "session.tree":
            guard let t = try? d.decode(Tree.self, from: data) else { return nil }
            return .tree(sessionId: t.marvinSessionId, tree: t.tree)
        case "session.activity":
            guard let a = try? d.decode(Activity.self, from: data) else { return nil }
            return .activity(sessionId: a.marvinSessionId, turnId: a.turnId, state: a.state, tool: a.tool)
        default:
            return nil
        }
    }

    public var sessionId: String {
        switch self {
        case .registered(let s, _, _, _), .ended(let s, _, _, _), .confirmPending(let s, _, _, _),
             .confirmResolved(let s, _, _), .tree(let s, _), .activity(let s, _, _, _):
            return s
        }
    }
}

/// One row of `GET /api/sessions/watch`.
public struct SessionWatchRowWire: Decodable, Equatable, Sendable {
    public struct Turn: Decodable, Equatable, Sendable {
        public let turnId: String
        public let kind: String?
        public let startedAt: String?
        public let mutated: Bool?
    }
    public struct Tree: Decodable, Equatable, Sendable {
        public let mode: SessionMode
        public let slug: String?
        public let path: String?
        public let branch: String?
        public let base: String?
        public let lane: [String]?
        public let cwd: String?
        public let currentBranch: String?
        public let present: Bool?
        public var wire: SessionTreeWire {
            SessionTreeWire(mode: mode, slug: slug, path: path, branch: branch, base: base, lane: lane)
        }
    }
    public struct LastTurn: Decodable, Equatable, Sendable {
        public let turnId: String
        public let startedAt: String?
        public let endedAt: String?
        public let outcome: String?
        public let error: String?
    }
    public struct Cost: Decodable, Equatable, Sendable {
        public let turns: Int
        public let costUsd: Double
    }
    public struct Activity: Decodable, Equatable, Sendable {
        public let state: SessionActivityState
        public let tool: String?
        public let turnId: String?
    }

    public let marvinSessionId: String
    public let state: String
    public let turn: Turn?
    public let activity: Activity?
    public let pending: [PendingConfirmInfo]?
    public let tree: Tree?
    public let diff: SessionDiffSummary?
    public let plan: SessionPlanProgress?
    public let lastTurn: LastTurn?
    public let cost: Cost?
    public let title: String?
    public let updatedAt: String?

    public static func decodeSnapshot(_ data: Data) -> [SessionWatchRowWire]? {
        struct Envelope: Decodable { let rows: [SessionWatchRowWire] }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.rows
    }
}

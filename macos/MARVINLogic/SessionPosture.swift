// SessionPosture — the per-session half of what used to be one global set of
// prefs (ADR-0108).
//
// Autonomy mode, the two models, the two effort rungs, the voice and the
// permission gate were single app-wide values on `MarvinBridge`, written
// through `NativePrefs` into one `UserDefaults` key each. With ADR-0107's
// tab-per-worktree that became wrong in a way the user could see: flipping a
// tab to Plan flipped every other tab to Plan, because there was only ever
// one value to flip.
//
// The sidecar already models this correctly — `SessionPosture` in
// `session-meta.ts` records exactly these fields per session on every turn,
// so a server-initiated resume rebuilds the turn with the posture it ran
// under. This is the client-side mirror of that record.
//
// Pure value types with no UI and no @MainActor coupling, so the resolution
// and eviction rules are pinned by tests rather than hoped at.

import Foundation

/// What one chat session's turns run with. Mirrors `SessionPosture` in the
/// sidecar's `session-meta.ts`, minus `playwrightEnabled` — the Playwright
/// MCP server is a machine-level opt-in (ADR-0045), not a per-tab choice.
public struct SessionPosture: Codable, Equatable, Sendable {
    public var personality: String
    public var executorModel: String?
    public var advisorModel: String?
    public var permissionStrategy: String
    /// "ask" | "agent" | "plan" (ADR-0036).
    public var mode: String
    /// Executor effort on the SDK ladder: low | medium | high | xhigh | max.
    public var thinkingMode: String
    /// nil = follow the executor's effort (ADR-0033).
    public var advisorThinkingMode: String?

    public init(
        personality: String,
        executorModel: String?,
        advisorModel: String?,
        permissionStrategy: String,
        mode: String,
        thinkingMode: String,
        advisorThinkingMode: String?
    ) {
        self.personality = personality
        self.executorModel = executorModel
        self.advisorModel = advisorModel
        self.permissionStrategy = permissionStrategy
        self.mode = mode
        self.thinkingMode = thinkingMode
        self.advisorThinkingMode = advisorThinkingMode
    }

    /// The shipped defaults — what a first launch with nothing persisted uses.
    public static let fallback = SessionPosture(
        personality: "ultron",
        executorModel: nil,
        advisorModel: nil,
        permissionStrategy: "auto",
        mode: "agent",
        thinkingMode: "high",
        advisorThinkingMode: nil
    )
}

/// The posture as `GET /api/sessions/watch` and `/api/sessions/meta` report
/// it. Separate from `SessionPosture` because the wire calls the executor
/// `model`, and because every field is optional: a sidecar a version ahead
/// or behind must never make the whole row undecodable.
public struct SessionPostureWire: Decodable, Equatable, Sendable {
    public let model: String?
    public let advisorModel: String?
    public let personality: String?
    public let permissionStrategy: String?
    public let thinkingMode: String?
    public let advisorThinkingMode: String?
    public let mode: String?

    public init(model: String? = nil, advisorModel: String? = nil, personality: String? = nil,
                permissionStrategy: String? = nil, thinkingMode: String? = nil,
                advisorThinkingMode: String? = nil, mode: String? = nil) {
        self.model = model
        self.advisorModel = advisorModel
        self.personality = personality
        self.permissionStrategy = permissionStrategy
        self.thinkingMode = thinkingMode
        self.advisorThinkingMode = advisorThinkingMode
        self.mode = mode
    }

    /// Fill the gaps from `base` — the local defaults — so a partial record
    /// from an older sidecar yields a complete posture rather than a
    /// half-empty one. An empty string means "no model chosen", which is how
    /// the runtime writes a defaulted executor.
    public func resolved(against base: SessionPosture) -> SessionPosture {
        func trimmed(_ v: String?) -> String? {
            guard let v, !v.isEmpty else { return nil }
            return v
        }
        return SessionPosture(
            personality: trimmed(personality) ?? base.personality,
            executorModel: trimmed(model) ?? base.executorModel,
            advisorModel: trimmed(advisorModel),
            permissionStrategy: trimmed(permissionStrategy) ?? base.permissionStrategy,
            mode: trimmed(mode) ?? base.mode,
            thinkingMode: trimmed(thinkingMode) ?? base.thinkingMode,
            advisorThinkingMode: trimmed(advisorThinkingMode)
        )
    }
}

/// Postures keyed by session id, most-recently-touched first, capped.
///
/// A bare dictionary would grow forever — every tab a user ever opens leaves
/// an entry, and sessions are never re-used. The order IS the eviction
/// policy: `set` moves the session to the front and drops the tail past
/// `capacity`, so the sessions a user actually returns to are the ones that
/// survive. Ordered rather than a dictionary + separate MRU list because one
/// structure cannot disagree with itself.
public struct SessionPostureStore: Codable, Equatable, Sendable {
    public static let capacity = 200

    struct Entry: Codable, Equatable, Sendable {
        var id: String
        var posture: SessionPosture
    }

    private var entries: [Entry] = []

    public init() {}

    public var count: Int { entries.count }

    /// The session ids held, most-recently-touched first. Test seam.
    public var sessionIds: [String] { entries.map(\.id) }

    public func posture(for sessionId: String) -> SessionPosture? {
        entries.first { $0.id == sessionId }?.posture
    }

    /// Record a session's posture and mark it most-recent.
    public mutating func set(_ posture: SessionPosture, for sessionId: String) {
        guard !sessionId.isEmpty else { return }
        entries.removeAll { $0.id == sessionId }
        entries.insert(Entry(id: sessionId, posture: posture), at: 0)
        if entries.count > Self.capacity { entries.removeLast(entries.count - Self.capacity) }
    }

    /// Seed a session that has no record yet. Never overwrites a posture the
    /// user has already set on this machine — the local record is the one
    /// they last touched, the server's is only a fallback for a tab this
    /// install has never driven.
    @discardableResult
    public mutating func seedIfAbsent(_ posture: SessionPosture, for sessionId: String) -> Bool {
        guard !sessionId.isEmpty, self.posture(for: sessionId) == nil else { return false }
        set(posture, for: sessionId)
        return true
    }

    public mutating func remove(_ sessionId: String) {
        entries.removeAll { $0.id == sessionId }
    }

    // MARK: - Persistence

    public var jsonString: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }

    public static func decode(_ json: String?) -> SessionPostureStore {
        guard let json, let data = json.data(using: .utf8),
              let store = try? JSONDecoder().decode(SessionPostureStore.self, from: data)
        else { return SessionPostureStore() }
        return store
    }
}

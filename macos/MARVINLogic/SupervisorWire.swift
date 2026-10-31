// SupervisorWire — the wire shapes the app reads from the supervisor's routes
// and the project feed (ADR-0127 milestone 6; design brief §10).
//
// Mirrors the sidecar's projections, not the brief's proposals where the two
// differ: `supervisor-status.ts` (GET /api/supervisor), `supervisor-inbox.ts`
// (GET /api/supervisor/inbox), `supervisor-view.ts` (GET /api/supervisor/ledger
// and the display `Ground`), `session-watch.ts` (the watch row's `supervisor`
// and each pending confirm's proposal). Every field the app does not strictly
// need is optional, so a sidecar a version ahead or behind never makes a whole
// response undecodable — the same rule `SessionFeed` follows.
//
// No policy lives here. Act labels, act summaries, escalation reasons,
// `health`, `budget.level` and the shadow/autonomous split are all computed by
// the server (brief §11, "Server-supplied text").

import Foundation

// MARK: - Loose JSON (raw act input)

/// An arbitrary JSON value — the raw act's tool input, shown verbatim under
/// "Show full act". Kept here (not the app's `ChatJSON`) so the logic target
/// stays dependency-free.
public indirect enum SupervisorJSON: Decodable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([SupervisorJSON])
    case object([String: SupervisorJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([SupervisorJSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: SupervisorJSON].self)) }
    }

    /// Pretty, key-sorted JSON text — deterministic, so a snapshot and a
    /// digest comparison read the same thing every time.
    public var prettyText: String {
        render(indent: 0)
    }

    private func render(indent: Int) -> String {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n):
            return n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .string(let s): return Self.quote(s)
        case .array(let a):
            if a.isEmpty { return "[]" }
            return "[\n" + a.map { inner + $0.render(indent: indent + 1) }.joined(separator: ",\n") + "\n\(pad)]"
        case .object(let o):
            if o.isEmpty { return "{}" }
            return "{\n" + o.keys.sorted().map { k in
                inner + Self.quote(k) + ": " + o[k]!.render(indent: indent + 1)
            }.joined(separator: ",\n") + "\n\(pad)}"
        }
    }

    private static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default: out.unicodeScalars.append(ch)
            }
        }
        return out + "\""
    }
}

// MARK: - Shared

/// The supervisor's limit on one tab (brief §6.5).
public enum SupervisorDelegation: String, Codable, Sendable, Equatable, CaseIterable {
    case off
    case observe
    case answerQuestions = "answer-questions"
    case answerConfirms = "answer-confirms"
}

/// A ground, in either form the server sends: the display projection
/// (inbox, ledger — `label`, `resolved`, `excerpt`, `openTarget`) or the raw
/// stored form (watch row, transcript — `kind`, `ref`, `provenance` with
/// `unresolved`). One type, so a view never has to know which it got.
public struct SupervisorGround: Decodable, Equatable, Sendable, Identifiable {
    public struct OpenTarget: Decodable, Equatable, Sendable {
        public let path: String
        public let line: Int?
        public init(path: String, line: Int? = nil) { self.path = path; self.line = line }
    }
    public let kind: String
    public let ref: String
    public let tree: String?
    public let label: String?
    public let provenance: String
    public let resolved: Bool?
    public let excerpt: String?
    public let openTarget: OpenTarget?

    public var id: String { "\(kind):\(ref)" }
    public var isStrong: Bool { provenance == "strong" && isResolved }
    /// The raw form says `unresolved`; the display form says `resolved: false`.
    public var isResolved: Bool { resolved ?? (provenance != "unresolved") }
    public var displayLabel: String {
        if let l = label, !l.isEmpty { return l }
        return ref
    }
    /// What the citation link reads: `plan [3]`, `ADR-0107`, `src/a.ts:42`.
    public var citation: String {
        if ref.hasPrefix("plan:") { return "plan " + ref.dropFirst("plan:".count) }
        if ref.hasPrefix("file:") { return String(ref.dropFirst("file:".count)) }
        if ref.hasPrefix("memory:") { return "memory " + ref.dropFirst("memory:".count) }
        return ref
    }

    public init(kind: String, ref: String, tree: String? = nil, label: String? = nil, provenance: String,
                resolved: Bool? = nil, excerpt: String? = nil, openTarget: OpenTarget? = nil) {
        self.kind = kind; self.ref = ref; self.tree = tree; self.label = label; self.provenance = provenance
        self.resolved = resolved; self.excerpt = excerpt; self.openTarget = openTarget
    }
}

// MARK: - GET /api/supervisor → { state, status }

public struct SupervisorStatus: Decodable, Equatable, Sendable {
    public struct Pause: Decodable, Equatable, Sendable {
        public let reason: String
        public let at: String?
        public let detail: String?
        public init(reason: String, at: String? = nil, detail: String? = nil) { self.reason = reason; self.at = at; self.detail = detail }
    }
    public struct Wake: Decodable, Equatable, Sendable {
        public let wakeId: String
        public let startedAt: String?
        public let itemCount: Int?
        public init(wakeId: String, startedAt: String? = nil, itemCount: Int? = nil) {
            self.wakeId = wakeId; self.startedAt = startedAt; self.itemCount = itemCount
        }
    }
    /// ADR-0128 §6 — user messages a message wake left unanswered: retried with backoff, then `failed`.
    public struct MessageRetry: Decodable, Equatable, Sendable {
        /// `retrying` | `failed`.
        public let state: String
        public let messageIds: [String]
        public let attempts: Int
        public let nextRetryAt: String?
        public init(state: String, messageIds: [String], attempts: Int, nextRetryAt: String? = nil) {
            self.state = state; self.messageIds = messageIds; self.attempts = attempts; self.nextRetryAt = nextRetryAt
        }
    }
    public struct LastWake: Decodable, Equatable, Sendable {
        public struct Failure: Decodable, Equatable, Sendable {
            public let message: String
            public let detail: String?
            public init(message: String, detail: String? = nil) { self.message = message; self.detail = detail }
        }
        public let wakeId: String?
        public let at: String?
        public let outcome: String
        public let error: Failure?
        public init(wakeId: String? = nil, at: String? = nil, outcome: String, error: Failure? = nil) {
            self.wakeId = wakeId; self.at = at; self.outcome = outcome; self.error = error
        }
    }
    public struct Budget: Decodable, Equatable, Sendable {
        public let capUsd: Double
        public let spentUsd: Double
        public let spentOwnUsd: Double?
        public let spentTabsUsd: Double?
        public let resetsAt: String?
        /// Server-derived: `ok` | `near` | `reached`.
        public let level: String
        public init(capUsd: Double, spentUsd: Double, spentOwnUsd: Double? = nil, spentTabsUsd: Double? = nil,
                    resetsAt: String? = nil, level: String) {
            self.capUsd = capUsd; self.spentUsd = spentUsd; self.spentOwnUsd = spentOwnUsd
            self.spentTabsUsd = spentTabsUsd; self.resetsAt = resetsAt; self.level = level
        }
    }
    public struct Charter: Decodable, Equatable, Sendable {
        public let text: String
        public let updatedAt: String?
        public init(text: String, updatedAt: String? = nil) { self.text = text; self.updatedAt = updatedAt }
    }
    public struct Model: Decodable, Equatable, Sendable {
        public let resolved: String?
        public let label: String?
        /// What the user stored for the role; nil = the default. `resolved` alone cannot tell the two apart.
        public let choice: String?
        public init(resolved: String? = nil, label: String? = nil, choice: String? = nil) {
            self.resolved = resolved; self.label = label; self.choice = choice
        }
    }
    public struct CategoryStats: Decodable, Equatable, Sendable {
        public let proposals: Int
        public let agreed: Int
        public let agreedBlind: Int?
        public let agreementRate: Double?
        public let humanOnlyProposedAsAct: Int?
        public let heuristicMisses: Int?
        public init(proposals: Int, agreed: Int, agreedBlind: Int? = nil, agreementRate: Double? = nil,
                    humanOnlyProposedAsAct: Int? = nil, heuristicMisses: Int? = nil) {
            self.proposals = proposals; self.agreed = agreed; self.agreedBlind = agreedBlind
            self.agreementRate = agreementRate; self.humanOnlyProposedAsAct = humanOnlyProposedAsAct
            self.heuristicMisses = heuristicMisses
        }
    }
    public struct Bar: Decodable, Equatable, Sendable {
        public let minProposals: Int
        public let minAgreement: Double
        public init(minProposals: Int, minAgreement: Double) { self.minProposals = minProposals; self.minAgreement = minAgreement }
    }

    public let projectId: String?
    public let revision: Int
    /// `off` | `shadow` | `autonomous`.
    public let mode: String
    /// Category → `shadow` | `autonomous`. Categories: questions, nudges, posture, confirms.
    public let autonomy: [String: String]
    /// `idle` | `waking` | `paused`.
    public let run: String
    public let pause: Pause?
    public let currentWake: Wake?
    public let queuedEvents: Int
    public let lastWake: LastWake?
    /// Server-derived: `ok` | `stale` | `failed`.
    public let health: String
    public let healthSince: String?
    public let watchedTabs: Int
    public let openEscalations: Int
    public let budget: Budget
    public let charter: Charter?
    public let model: Model?
    public let stats: [String: CategoryStats]?
    public let suggestedBar: Bar?
    public let confirmsEligible: Bool?
    public let messageRetry: MessageRetry?

    public init(projectId: String? = nil, revision: Int, mode: String, autonomy: [String: String] = [:],
                run: String, pause: Pause? = nil, currentWake: Wake? = nil, queuedEvents: Int = 0,
                lastWake: LastWake? = nil, health: String = "ok", healthSince: String? = nil,
                watchedTabs: Int = 0, openEscalations: Int = 0, budget: Budget, charter: Charter? = nil,
                model: Model? = nil, stats: [String: CategoryStats]? = nil, suggestedBar: Bar? = nil,
                confirmsEligible: Bool? = nil, messageRetry: MessageRetry? = nil) {
        self.projectId = projectId; self.revision = revision; self.mode = mode; self.autonomy = autonomy
        self.run = run; self.pause = pause; self.currentWake = currentWake; self.queuedEvents = queuedEvents
        self.lastWake = lastWake; self.health = health; self.healthSince = healthSince
        self.watchedTabs = watchedTabs; self.openEscalations = openEscalations; self.budget = budget
        self.charter = charter; self.model = model; self.stats = stats; self.suggestedBar = suggestedBar
        self.confirmsEligible = confirmsEligible; self.messageRetry = messageRetry
    }

    /// The four categories in the order the expanded block lists them.
    public static let categories = ["questions", "nudges", "posture", "confirms"]

    public var autonomousCategories: [String] {
        Self.categories.filter { autonomy[$0] == "autonomous" }
    }

    public static func decodeEnvelope(_ data: Data) -> SupervisorStatus? {
        struct Envelope: Decodable { let status: SupervisorStatus }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.status
    }
}

// MARK: - GET /api/supervisor/inbox → { items }

public struct SupervisorInboxItem: Decodable, Equatable, Sendable, Identifiable {
    public struct EscalatedBecause: Decodable, Equatable, Sendable {
        public let code: String
        public let label: String
        public let rule: String?
        public init(code: String, label: String, rule: String? = nil) { self.code = code; self.label = label; self.rule = rule }
    }
    public struct Heuristic: Decodable, Equatable, Sendable {
        public let matched: String
        public init(matched: String) { self.matched = matched }
    }
    public struct RawAct: Decodable, Equatable, Sendable {
        public let toolName: String
        public let input: SupervisorJSON?
        public let digest: String?
        /// Server-built from the tool and its input, never supervisor text.
        public let summary: String
        public let outward: Bool
        public let destructive: Bool
        public let paths: [String]?
        public init(toolName: String, input: SupervisorJSON? = nil, digest: String? = nil, summary: String,
                    outward: Bool = false, destructive: Bool = false, paths: [String]? = nil) {
            self.toolName = toolName; self.input = input; self.digest = digest; self.summary = summary
            self.outward = outward; self.destructive = destructive; self.paths = paths
        }
    }
    public struct Preview: Decodable, Equatable, Sendable {
        public let verdict: String
        public let behind: Int?
        public let added: Int
        public let removed: Int
        public let conflictFiles: [String]
        public init(verdict: String, behind: Int? = nil, added: Int = 0, removed: Int = 0, conflictFiles: [String] = []) {
            self.verdict = verdict; self.behind = behind; self.added = added; self.removed = removed
            self.conflictFiles = conflictFiles
        }
    }
    public struct Question: Decodable, Equatable, Sendable {
        public struct Option: Decodable, Equatable, Sendable {
            public let label: String
            public let description: String?
            public init(label: String, description: String? = nil) { self.label = label; self.description = description }
        }
        public let header: String?
        public let question: String
        public let multiSelect: Bool?
        public let options: [Option]
        public init(header: String? = nil, question: String, multiSelect: Bool? = nil, options: [Option]) {
            self.header = header; self.question = question; self.multiSelect = multiSelect; self.options = options
        }
    }
    public struct QuestionSet: Decodable, Equatable, Sendable {
        public let questions: [Question]
        public init(questions: [Question]) { self.questions = questions }
        /// Tolerant: a question the server could not shape is skipped, not fatal.
        public init(from decoder: Decoder) throws {
            struct Lossy: Decodable { let value: Question?
                init(from decoder: Decoder) throws { value = try? Question(from: decoder) } }
            let c = try decoder.container(keyedBy: CodingKeys.self)
            questions = ((try? c.decode([Lossy].self, forKey: .questions)) ?? []).compactMap(\.value)
        }
        private enum CodingKeys: String, CodingKey { case questions }
    }
    public struct LinkedConfirm: Decodable, Equatable, Sendable {
        public let sessionId: String
        public let turnId: String?
        public let toolUseId: String
        public let raisingRule: String?
        public init(sessionId: String, turnId: String? = nil, toolUseId: String, raisingRule: String? = nil) {
            self.sessionId = sessionId; self.turnId = turnId; self.toolUseId = toolUseId; self.raisingRule = raisingRule
        }
    }
    public struct Recommendation: Decodable, Equatable, Sendable {
        public let actionId: String
        /// The supervisor's prose, length-capped by the server. Advice, never the headline.
        public let text: String
        public init(actionId: String, text: String) { self.actionId = actionId; self.text = text }
    }
    public struct Action: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        /// Server-supplied verb: "Deny", "Allow push", "Merge", "Answer: Option B".
        public let label: String
        /// `consent` | `refuse` | `edit` | `dismiss`.
        public let role: String
        public let recommended: Bool
        /// An outward or destructive act: shown only once the card shows the full act.
        public let requiresExpanded: Bool
        public init(id: String, label: String, role: String, recommended: Bool = false, requiresExpanded: Bool = false) {
            self.id = id; self.label = label; self.role = role; self.recommended = recommended
            self.requiresExpanded = requiresExpanded
        }
    }
    public struct NewTab: Decodable, Equatable, Sendable {
        public struct Tree: Decodable, Equatable, Sendable {
            public let baseRef: String?
            public let baseSha: String?
            public let mode: String?
            public init(baseRef: String? = nil, baseSha: String? = nil, mode: String? = "worktree") {
                self.baseRef = baseRef; self.baseSha = baseSha; self.mode = mode
            }
        }
        public struct Posture: Decodable, Equatable, Sendable {
            public let model: String?
            public let modelLabel: String?
            public let effort: String?
            public let strategy: String?
            public let mode: String?
            public init(model: String? = nil, modelLabel: String? = nil, effort: String? = nil,
                        strategy: String? = nil, mode: String? = nil) {
                self.model = model; self.modelLabel = modelLabel; self.effort = effort; self.strategy = strategy; self.mode = mode
            }
        }
        public struct RequestedBy: Decodable, Equatable, Sendable {
            public let kind: String
            public let ref: String?
            public let at: String?
            public init(kind: String, ref: String? = nil, at: String? = nil) { self.kind = kind; self.ref = ref; self.at = at }
        }
        public let firstMessage: String
        public let tree: Tree?
        public let posture: Posture?
        public let wider: [String]?
        public let requestedBy: RequestedBy?
        public init(firstMessage: String, tree: Tree? = nil, posture: Posture? = nil, wider: [String]? = nil,
                    requestedBy: RequestedBy? = nil) {
            self.firstMessage = firstMessage; self.tree = tree; self.posture = posture; self.wider = wider
            self.requestedBy = requestedBy
        }
    }
    public struct PostureChange: Decodable, Equatable, Sendable {
        public let from: [String: SupervisorJSON]?
        public let to: [String: SupervisorJSON]?
        public let widenedDimensions: [String]
        public init(from: [String: SupervisorJSON]? = nil, to: [String: SupervisorJSON]? = nil, widenedDimensions: [String]) {
            self.from = from; self.to = to; self.widenedDimensions = widenedDimensions
        }
    }
    public struct Guardrail: Decodable, Equatable, Sendable {
        public let kind: String
        public let detail: String?
        /// `raise-cap` | `resume` | `open-tab`.
        public let verb: String?
        public init(kind: String, detail: String? = nil, verb: String? = nil) { self.kind = kind; self.detail = detail; self.verb = verb }
    }

    public let id: String
    public let revision: Int
    public let createdAt: String
    public let wakeId: String?
    public let sessionId: String?
    public let tabTitle: String?
    public let ledgerId: String?
    public let kind: String
    public let escalatedBecause: EscalatedBecause
    public let heuristic: Heuristic?
    public let rawAct: RawAct?
    public let preview: Preview?
    public let question: QuestionSet?
    public let linkedConfirm: LinkedConfirm?
    public let recommendation: Recommendation?
    public let grounds: [SupervisorGround]
    public let actions: [Action]
    public let newTab: NewTab?
    public let postureChange: PostureChange?
    public let guardrail: Guardrail?
    /// `shadow` | `autonomous`.
    public let modeAtCreation: String?
    /// `open` | `resolved` | `dismissed` | `superseded`.
    public let state: String
    public let resolvedBy: String?
    public let burstRank: Int?

    public init(id: String, revision: Int = 1, createdAt: String, wakeId: String? = nil, sessionId: String?,
                tabTitle: String? = nil, ledgerId: String? = nil, kind: String, escalatedBecause: EscalatedBecause,
                heuristic: Heuristic? = nil, rawAct: RawAct? = nil, preview: Preview? = nil,
                question: QuestionSet? = nil, linkedConfirm: LinkedConfirm? = nil,
                recommendation: Recommendation? = nil, grounds: [SupervisorGround] = [], actions: [Action] = [],
                newTab: NewTab? = nil, postureChange: PostureChange? = nil, guardrail: Guardrail? = nil,
                modeAtCreation: String? = "shadow", state: String = "open", resolvedBy: String? = nil,
                burstRank: Int? = 0) {
        self.id = id; self.revision = revision; self.createdAt = createdAt; self.wakeId = wakeId
        self.sessionId = sessionId; self.tabTitle = tabTitle; self.ledgerId = ledgerId; self.kind = kind
        self.escalatedBecause = escalatedBecause; self.heuristic = heuristic; self.rawAct = rawAct
        self.preview = preview; self.question = question; self.linkedConfirm = linkedConfirm
        self.recommendation = recommendation; self.grounds = grounds; self.actions = actions
        self.newTab = newTab; self.postureChange = postureChange; self.guardrail = guardrail
        self.modeAtCreation = modeAtCreation; self.state = state; self.resolvedBy = resolvedBy
        self.burstRank = burstRank
    }

    public var isTabless: Bool { sessionId == nil }
    public var isOpen: Bool { state == "open" }
    public var strongGroundCount: Int { grounds.filter(\.isStrong).count }

    public static func decodeList(_ data: Data) -> [SupervisorInboxItem]? {
        struct Envelope: Decodable { let items: [SupervisorInboxItem] }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.items
    }
}

// MARK: - GET /api/supervisor/ledger → { entries, hasMore, nextBefore, todayCount }

public struct SupervisorLedgerEntry: Decodable, Equatable, Sendable, Identifiable {
    public struct Reason: Decodable, Equatable, Sendable {
        public let code: String
        public let text: String
        public init(code: String, text: String) { self.code = code; self.text = text }
    }
    public struct Pairing: Decodable, Equatable, Sendable {
        public let actualAnswer: [String]?
        public let answeredBy: String?
        /// `agree` | `disagree` | `pending`.
        public let agreement: String
        public let proposalSeenBeforeAnswer: Bool?
        public init(actualAnswer: [String]? = nil, answeredBy: String? = nil, agreement: String,
                    proposalSeenBeforeAnswer: Bool? = nil) {
            self.actualAnswer = actualAnswer; self.answeredBy = answeredBy; self.agreement = agreement
            self.proposalSeenBeforeAnswer = proposalSeenBeforeAnswer
        }
    }
    public let seq: Int
    public let lineId: String?
    public let at: String
    public let wakeId: String?
    /// `supervisor` | `user` | `runtime`.
    public let actor: String
    public let sessionId: String?
    public let tabTitle: String?
    public let verb: String
    public let decision: String?
    public let mode: String?
    public let argDigest: String?
    public let argSummary: String?
    public let reason: Reason?
    public let grounds: [SupervisorGround]
    public let pairing: Pairing?
    public let inboxItemId: String?
    public let costUsd: Double?

    public var id: Int { seq }

    private enum CodingKeys: String, CodingKey {
        case seq, lineId = "id", at, wakeId, actor, sessionId, tabTitle, verb, decision, mode, argDigest,
             argSummary, reason, grounds, pairing, inboxItemId, costUsd
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        lineId = try c.decodeIfPresent(String.self, forKey: .lineId)
        at = try c.decode(String.self, forKey: .at)
        wakeId = try c.decodeIfPresent(String.self, forKey: .wakeId)
        actor = try c.decodeIfPresent(String.self, forKey: .actor) ?? "supervisor"
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        tabTitle = try c.decodeIfPresent(String.self, forKey: .tabTitle)
        verb = try c.decode(String.self, forKey: .verb)
        decision = try c.decodeIfPresent(String.self, forKey: .decision)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        argDigest = try c.decodeIfPresent(String.self, forKey: .argDigest)
        argSummary = try c.decodeIfPresent(String.self, forKey: .argSummary)
        reason = try c.decodeIfPresent(Reason.self, forKey: .reason)
        grounds = (try? c.decodeIfPresent([SupervisorGround].self, forKey: .grounds)) ?? []
        pairing = try c.decodeIfPresent(Pairing.self, forKey: .pairing)
        inboxItemId = try c.decodeIfPresent(String.self, forKey: .inboxItemId)
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
    }

    public init(seq: Int, lineId: String? = nil, at: String, wakeId: String? = nil, actor: String = "supervisor",
                sessionId: String? = nil, tabTitle: String? = nil, verb: String, decision: String? = nil,
                mode: String? = nil, argDigest: String? = nil, argSummary: String? = nil, reason: Reason? = nil,
                grounds: [SupervisorGround] = [], pairing: Pairing? = nil, inboxItemId: String? = nil,
                costUsd: Double? = nil) {
        self.seq = seq; self.lineId = lineId; self.at = at; self.wakeId = wakeId; self.actor = actor
        self.sessionId = sessionId; self.tabTitle = tabTitle; self.verb = verb; self.decision = decision
        self.mode = mode; self.argDigest = argDigest; self.argSummary = argSummary; self.reason = reason
        self.grounds = grounds; self.pairing = pairing; self.inboxItemId = inboxItemId; self.costUsd = costUsd
    }
}

public struct SupervisorLedgerPage: Decodable, Equatable, Sendable {
    public let entries: [SupervisorLedgerEntry]
    public let hasMore: Bool
    public let nextBefore: Int?
    public let todayCount: Int
    public init(entries: [SupervisorLedgerEntry], hasMore: Bool = false, nextBefore: Int? = nil, todayCount: Int = 0) {
        self.entries = entries; self.hasMore = hasMore; self.nextBefore = nextBefore; self.todayCount = todayCount
    }
}

// MARK: - The watch row's `supervisor` and each pending confirm's proposal

public struct SessionSupervisorWire: Decodable, Equatable, Sendable {
    public struct TouchedTurn: Decodable, Equatable, Sendable {
        public let turnId: String
        public let at: String?
        /// `message` | `answer` | `confirm`.
        public let by: String
        public init(turnId: String, at: String? = nil, by: String) { self.turnId = turnId; self.at = at; self.by = by }
    }
    public let delegation: SupervisorDelegation
    public let sharedCheckout: Bool?
    public let touchedTurn: TouchedTurn?
    public let waitingOnOwn: String?
    public let stoppedByUser: Bool?
    public let lastActAt: String?
    public let openEscalations: Int?

    public init(delegation: SupervisorDelegation, sharedCheckout: Bool? = nil, touchedTurn: TouchedTurn? = nil,
                waitingOnOwn: String? = nil, stoppedByUser: Bool? = nil, lastActAt: String? = nil,
                openEscalations: Int? = nil) {
        self.delegation = delegation; self.sharedCheckout = sharedCheckout; self.touchedTurn = touchedTurn
        self.waitingOnOwn = waitingOnOwn; self.stoppedByUser = stoppedByUser; self.lastActAt = lastActAt
        self.openEscalations = openEscalations
    }

    /// An unknown delegation level from a newer sidecar reads as `off` rather
    /// than failing the whole watch row.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        delegation = (try? c.decode(SupervisorDelegation.self, forKey: .delegation)) ?? .off
        sharedCheckout = try c.decodeIfPresent(Bool.self, forKey: .sharedCheckout)
        touchedTurn = try c.decodeIfPresent(TouchedTurn.self, forKey: .touchedTurn)
        waitingOnOwn = try c.decodeIfPresent(String.self, forKey: .waitingOnOwn)
        stoppedByUser = try c.decodeIfPresent(Bool.self, forKey: .stoppedByUser)
        lastActAt = try c.decodeIfPresent(String.self, forKey: .lastActAt)
        openEscalations = try c.decodeIfPresent(Int.self, forKey: .openEscalations)
    }
    private enum CodingKeys: String, CodingKey {
        case delegation, sharedCheckout, touchedTurn, waitingOnOwn, stoppedByUser, lastActAt, openEscalations
    }
}

/// A shadow proposal for one pending confirm (brief §6.4). Blind until
/// revealed: before the reveal the server sends no `answer` and no grounds.
public struct SupervisorProposalWire: Decodable, Equatable, Sendable {
    public let ledgerId: String
    public let actionId: String
    public let answer: [String]?
    public let grounds: [SupervisorGround]
    public init(ledgerId: String, actionId: String, answer: [String]? = nil, grounds: [SupervisorGround] = []) {
        self.ledgerId = ledgerId; self.actionId = actionId; self.answer = answer; self.grounds = grounds
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ledgerId = try c.decode(String.self, forKey: .ledgerId)
        actionId = try c.decodeIfPresent(String.self, forKey: .actionId) ?? "answer"
        answer = try c.decodeIfPresent([String].self, forKey: .answer)
        grounds = (try? c.decodeIfPresent([SupervisorGround].self, forKey: .grounds)) ?? []
    }
    private enum CodingKeys: String, CodingKey { case ledgerId, actionId, answer, grounds }
}

// MARK: - The supervisor's own feed events (ids and states only)

/// `supervisor.state`, `supervisor.inbox`, `supervisor.ledger` on the project
/// feed. The feed holds no token, so these say what moved and the client
/// fetches the rest through the token-gated routes.
public enum SupervisorFeedEvent: Equatable, Sendable {
    case state(revision: Int, mode: String)
    case inbox(change: String, id: String, sessionId: String?, state: String, resolvedBy: String?)
    case ledger(seq: Int, sessionId: String?, decision: String?)
    /// ADR-0128 — a line was added to the conversation (`supervisor.message`).
    case message(id: String, from: String)
    /// [7.3] — a follow opened or ended (`supervisor.follow`).
    case follow(id: String, sessionId: String, state: String)

    public static func decode(name: String, data: Data) -> SupervisorFeedEvent? {
        let d = JSONDecoder()
        switch name {
        case "supervisor.state":
            struct S: Decodable { let revision: Int; let mode: String }
            guard let s = try? d.decode(S.self, from: data) else { return nil }
            return .state(revision: s.revision, mode: s.mode)
        case "supervisor.inbox":
            struct I: Decodable { let change: String; let id: String; let sessionId: String?; let state: String; let resolvedBy: String? }
            guard let i = try? d.decode(I.self, from: data) else { return nil }
            return .inbox(change: i.change, id: i.id, sessionId: i.sessionId, state: i.state, resolvedBy: i.resolvedBy)
        case "supervisor.ledger":
            struct L: Decodable { let seq: Int; let sessionId: String?; let decision: String? }
            guard let l = try? d.decode(L.self, from: data) else { return nil }
            return .ledger(seq: l.seq, sessionId: l.sessionId, decision: l.decision)
        case "supervisor.message":
            struct M: Decodable { let id: String; let from: String }
            guard let m = try? d.decode(M.self, from: data) else { return nil }
            return .message(id: m.id, from: m.from)
        case "supervisor.follow":
            struct F: Decodable { let id: String; let sessionId: String; let state: String }
            guard let f = try? d.decode(F.self, from: data) else { return nil }
            return .follow(id: f.id, sessionId: f.sessionId, state: f.state)
        default:
            return nil
        }
    }
}

// SupervisorQueue — the approved queue as values (ADR-0133, plan [5.6]).
//
// A queue is a list of briefs the user approved as a list; the RUNTIME opens
// them as slots free. Nothing here is an act: the card is the consent (the
// user's click, ADR-0128), and the workspace only reads the queue and sets the
// user's own cap. Pure logic and wire types, pinned by assertions (ADR-0114).

import Foundation

// MARK: - The card (`item.queue` on a `queue` inbox item)

/// What a `queue` card shows: the entries (with each brief), the guard command
/// in full, or a hold's two lines. Tolerant by construction: a kind this client
/// does not know decodes with every field nil and draws as a plain escalation.
public struct SupervisorQueueCard: Decodable, Equatable, Sendable {
    public struct Posture: Decodable, Equatable, Sendable {
        public let model: String?
        public let thinkingMode: String?
        public let permissionStrategy: String?
        public let mode: String?
        public init(model: String? = nil, thinkingMode: String? = nil, permissionStrategy: String? = nil, mode: String? = nil) {
            self.model = model; self.thinkingMode = thinkingMode
            self.permissionStrategy = permissionStrategy; self.mode = mode
        }
    }
    public struct ScopeRef: Decodable, Equatable, Sendable {
        public let path: String
        public let heading: String
        public init(path: String, heading: String) { self.path = path; self.heading = heading }
    }
    public struct Entry: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let brief: String
        public let posture: Posture?
        public let wider: [String]?
        public let after: [String]?
        public let scopeRef: ScopeRef?
        public init(id: String, title: String, brief: String, posture: Posture? = nil, wider: [String]? = nil,
                    after: [String]? = nil, scopeRef: ScopeRef? = nil) {
            self.id = id; self.title = title; self.brief = brief; self.posture = posture
            self.wider = wider; self.after = after; self.scopeRef = scopeRef
        }
    }

    /// `entries` | `guard` | `hold`.
    public let kind: String
    public let entries: [Entry]?
    public let warnings: [String]?
    /// A guard card: the whole command, and the one it would replace.
    public let command: String?
    public let previous: String?
    /// A hold card: the entry and the two lines.
    public let entryId: String?
    public let detail: String?

    public init(kind: String, entries: [Entry]? = nil, warnings: [String]? = nil, command: String? = nil,
                previous: String? = nil, entryId: String? = nil, detail: String? = nil) {
        self.kind = kind; self.entries = entries; self.warnings = warnings; self.command = command
        self.previous = previous; self.entryId = entryId; self.detail = detail
    }
}

// MARK: - GET /api/supervisor/queue

public struct SupervisorQueueView: Decodable, Equatable, Sendable {
    public struct CapLowered: Decodable, Equatable, Sendable {
        public let from: Int
        public let to: Int
        public let reason: String
        public let at: String
    }
    public struct Guard: Decodable, Equatable, Sendable {
        public let command: String
        public let approvedAt: String
    }
    public struct GuardRun: Decodable, Equatable, Sendable {
        public let at: String
        public let ok: Bool
        public let exitCode: Int?
        public let timedOut: Bool
    }
    public struct Reason: Decodable, Equatable, Sendable {
        public let reason: String
        public let at: String
        public let code: String?
    }
    public struct Entry: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let briefHead: String
        /// `queued` | `opening` | `opened` | `expired` | `failed`; anything else reads as queued.
        public let status: String
        public let position: Int?
        public let after: [String]
        public let scopeRef: SupervisorQueueCard.ScopeRef?
        public let wider: [String]
        public let approvedAt: String
        public let expiresAt: String
        public let openedAt: String?
        public let openedSessionId: String?
        /// The supervisor's hold — only the user releases it.
        public let hold: Reason?
        /// Why the runtime did not open it at its last look.
        public let blocked: Reason?
    }

    public let cap: Int
    public let effectiveCap: Int
    public let capLowered: CapLowered?
    public let guardRef: Guard?
    public let guardLast: GuardRun?
    public let entries: [Entry]

    private enum CodingKeys: String, CodingKey {
        case cap, effectiveCap, capLowered, guardRef = "guard", guardLast, entries
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cap = try c.decode(Int.self, forKey: .cap)
        effectiveCap = try c.decodeIfPresent(Int.self, forKey: .effectiveCap) ?? cap
        capLowered = try? c.decodeIfPresent(CapLowered.self, forKey: .capLowered)
        guardRef = try? c.decodeIfPresent(Guard.self, forKey: .guardRef)
        guardLast = try? c.decodeIfPresent(GuardRun.self, forKey: .guardLast)
        entries = (try? c.decode([Entry].self, forKey: .entries)) ?? []
    }

    public init(cap: Int, effectiveCap: Int? = nil, capLowered: CapLowered? = nil, guardRef: Guard? = nil,
                guardLast: GuardRun? = nil, entries: [Entry] = []) {
        self.cap = cap; self.effectiveCap = effectiveCap ?? cap; self.capLowered = capLowered
        self.guardRef = guardRef; self.guardLast = guardLast; self.entries = entries
    }

    public static func decode(_ data: Data) -> SupervisorQueueView? {
        try? JSONDecoder().decode(SupervisorQueueView.self, from: data)
    }
}

// MARK: - What the workspace says

public enum SupervisorQueuePresentation {
    public static let maxCap = 20

    public enum Tone: Equatable, Sendable { case neutral, active, held, needsYou, done }

    /// One row's state in words, with the reason a held row is held.
    public struct RowState: Equatable, Sendable {
        public let label: String
        public let tone: Tone
        public let reason: String?
    }

    public static func rowState(_ e: SupervisorQueueView.Entry) -> RowState {
        switch e.status {
        case "opened": return RowState(label: "Opened", tone: .done, reason: nil)
        case "opening": return RowState(label: "Opening", tone: .active, reason: nil)
        case "expired": return RowState(label: "Expired", tone: .done, reason: "Not opened within 7 days of approval.")
        case "failed": return RowState(label: "Needs you", tone: .needsYou, reason: e.blocked?.reason ?? "The opening did not finish.")
        default:
            // The supervisor's hold is the user's to read first: it names who and why.
            if let h = e.hold { return RowState(label: "Held", tone: .held, reason: h.reason) }
            if let b = e.blocked {
                return RowState(label: b.code == "scope" || b.code == "guard" ? "Held" : "Waiting", tone: .held, reason: b.reason)
            }
            return RowState(label: e.position == 1 ? "Next" : "Queued", tone: .neutral, reason: nil)
        }
    }

    /// The pending entries in the order the user approved them; settled ones follow, newest approval first.
    public static func ordered(_ entries: [SupervisorQueueView.Entry]) -> [SupervisorQueueView.Entry] {
        let pending = entries.filter { $0.status == "queued" || $0.status == "opening" }
            .sorted { ($0.position ?? .max) < ($1.position ?? .max) }
        let settled = entries.filter { !($0.status == "queued" || $0.status == "opening") }
            .sorted { $0.approvedAt > $1.approvedAt }
        return pending + settled
    }

    /// "Cap 1" / "Cap 3 · lowered to 1: the test machine is unreachable".
    public static func capLine(_ q: SupervisorQueueView) -> String {
        guard let low = q.capLowered else { return "Cap \(q.cap)" }
        return "Cap \(q.cap) · lowered to \(low.to): \(low.reason)"
    }

    /// The user's number is changed by one step, within 0…20 — never the supervisor's.
    public static func steppedCap(_ cap: Int, by delta: Int) -> Int { min(maxCap, max(0, cap + delta)) }

    /// The guard line: the whole command is shown elsewhere; this says what last happened.
    public static func guardLine(_ q: SupervisorQueueView) -> String {
        guard q.guardRef != nil else { return "No guard command. Tabs open as soon as a slot is free." }
        guard let run = q.guardLast else { return "Runs before each tab opens. Not run yet." }
        if run.ok { return "Last run: passed." }
        if run.timedOut { return "Last run: timed out — the queue is held." }
        if let code = run.exitCode { return "Last run: exit \(code) — the queue is held." }
        return "Last run: did not start — the queue is held."
    }

    public static func summary(_ q: SupervisorQueueView) -> String {
        let pending = q.entries.filter { $0.status == "queued" || $0.status == "opening" }.count
        let held = q.entries.filter { ($0.status == "queued") && ($0.hold != nil || $0.blocked != nil) }.count
        if pending == 0 { return "Nothing queued" }
        return held == 0 ? "\(pending) queued" : "\(pending) queued · \(held) held"
    }

    /// First lines of a brief, for the card and the list; the whole brief stays one tap away.
    public static func head(_ brief: String, lines: Int = 3) -> String {
        brief.split(separator: "\n", omittingEmptySubsequences: false).prefix(lines).joined(separator: "\n")
    }

    public static func postureLine(_ p: SupervisorQueueCard.Posture?) -> String {
        guard let p else { return "posture: the tab's default" }
        return [p.permissionStrategy, p.mode, p.model, p.thinkingMode].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Request bodies — the user's own settings; the approval is the inbox card's click

    public static func capBody(projectId: String, cap: Int) -> [String: Any] {
        ["projectId": projectId, "action": "cap", "cap": min(maxCap, max(0, cap))]
    }
    public static func restoreCapBody(projectId: String) -> [String: Any] { ["projectId": projectId, "action": "restore-cap"] }
    public static func releaseBody(projectId: String, id: String) -> [String: Any] { ["projectId": projectId, "action": "release", "id": id] }
    public static func removeBody(projectId: String, id: String) -> [String: Any] { ["projectId": projectId, "action": "remove", "id": id] }
    /// Raises the card that shows this command in full; it sets nothing until that card is clicked.
    public static func proposeGuardBody(projectId: String, command: String) -> [String: Any] {
        ["projectId": projectId, "action": "propose-guard", "command": command.trimmingCharacters(in: .whitespacesAndNewlines)]
    }
}

// MARK: - The approval card's selection

/// Which entries of a proposal the click approves. All by default; a subset only
/// by the user's own ticks. The card's order is the order, always: the selection
/// has no way to reorder, as the supervisor has none.
public struct SupervisorQueueSelection: Equatable, Sendable {
    public private(set) var ids: Set<String>
    private let order: [String]
    private let after: [String: [String]]

    public init(card: SupervisorQueueCard) {
        let entries = card.entries ?? []
        order = entries.map(\.id)
        after = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0.after ?? []) })
        ids = Set(order)
    }

    public var isAll: Bool { ids.count == order.count }
    public var count: Int { ids.count }
    public func contains(_ id: String) -> Bool { ids.contains(id) }
    public mutating func toggle(_ id: String) {
        guard order.contains(id) else { return }
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
    }

    /// Selected entries whose predecessor on this card is not selected: they would never open, and the server refuses them.
    public var orphans: [String] {
        order.filter { id in ids.contains(id) && (after[id] ?? []).contains { order.contains($0) && !ids.contains($0) } }
    }

    public var canApprove: Bool { !ids.isEmpty && orphans.isEmpty }

    /// The inbox action and its edits: "approve" for the whole list, "approve-subset" with the ids otherwise.
    public var action: (actionId: String, edits: [String: Any]?) {
        isAll ? ("approve", nil) : ("approve-subset", ["ids": order.filter { ids.contains($0) }])
    }

    public var buttonTitle: String { isAll ? "Approve all (\(count))" : "Approve \(count) of \(order.count)" }
}

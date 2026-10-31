// SupervisorPresentation — the supervisor surface's decisions as values
// (ADR-0127 milestone 6; design brief §6–§9).
//
// ADR-0114's principle: a decision is a value in MARVINLogic, so it is pinned
// by an assertion rather than by looking at a render. The views in the app
// target only draw what these return. Nothing here invents an act verb, an
// act summary or an escalation reason — those come from the server — but the
// state machine of the status strip, the burst grouping (the plan leaves
// "+N more" to the app), which act chips a collapsed card may show, how
// arrivals are announced, and the posture-revision bookkeeping are the app's.

import Foundation

// MARK: - Status strip (brief §6.1, §7)

public enum SupervisorStripState: Equatable, Sendable {
    case off
    case shadow
    case autonomous
    case waking
    case pausedByUser
    case killed
    case overBudget
    /// breaker | refusals | repeated-failures
    case pausedByFault(String)
    case stale
    case failed
    case disconnected
    case tokenUnavailable
}

public struct SupervisorStrip: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case neutral, warning, error }
    public enum Primary: Equatable, Sendable {
        case pause
        case resume(enabled: Bool)
        /// Resume and wake now — the stale state's verb.
        case restart
        /// Wake now after a failure.
        case retry
    }
    public struct Meter: Equatable, Sendable {
        public let fraction: Double
        /// Server-derived: ok | near | reached.
        public let level: String
    }
    public struct Failure: Equatable, Sendable {
        public let headline: String
        public let detail: String?
    }

    public let state: SupervisorStripState
    /// Line 1 after "Supervisor ·".
    public let modeLabel: String
    /// SF Symbol for any non-neutral state; nil when neutral or waking.
    public let glyph: String?
    public let showsProgress: Bool
    public let tone: Tone
    /// Line 2, tail-truncated in the view: budget first, so it survives at 260 pt.
    public let detail: String
    public let meter: Meter?
    public let showKill: Bool
    public let primary: Primary
    /// Pause, Resume and Kill call the route directly, so they work while the
    /// feed is down; only an unreadable token disables them.
    public let controlsEnabled: Bool
    /// Inbox items are actionable — never while the state is unknown.
    public let itemsEnabled: Bool
    /// A persistent error notice under the strip (failed wake, token).
    public let failure: Failure?
    public let help: String?
    public let accessibilityValue: String
    public let meterAccessibilityValue: String?

    public static func make(status: SupervisorStatus?, feedConnected: Bool, tokenError: String?,
                            now: Date, timeZone: TimeZone = .current) -> SupervisorStrip {
        if let path = tokenError {
            return SupervisorStrip(
                state: .tokenUnavailable, modeLabel: "Can't control supervisor", glyph: "xmark.octagon.fill",
                showsProgress: false, tone: .error, detail: "token unavailable", meter: nil, showKill: false,
                primary: .retry, controlsEnabled: false, itemsEnabled: false,
                failure: Failure(headline: "MARVIN couldn't read the supervisor token", detail: path),
                help: "The supervisor's routes need the per-boot token at \(path).",
                accessibilityValue: "Can't control the supervisor. MARVIN couldn't read its token.",
                meterAccessibilityValue: nil)
        }
        guard let s = status, s.mode != "off" else {
            return SupervisorStrip(
                state: .off, modeLabel: "off", glyph: nil, showsProgress: false, tone: .neutral, detail: "",
                meter: nil, showKill: false, primary: .pause, controlsEnabled: true, itemsEnabled: true,
                failure: nil, help: nil, accessibilityValue: "Off.", meterAccessibilityValue: nil)
        }
        if !feedConnected {
            return SupervisorStrip(
                state: .disconnected, modeLabel: "Reconnecting", glyph: "wifi.exclamationmark", showsProgress: false,
                tone: .warning, detail: "status unknown — reconnecting", meter: nil, showKill: false, primary: .pause,
                controlsEnabled: true, itemsEnabled: false, failure: nil,
                help: "The live feed is down. Pause and Kill still reach the sidecar.",
                accessibilityValue: "Status unknown, reconnecting.", meterAccessibilityValue: nil)
        }

        let f = Format(now: now, timeZone: timeZone)
        let meter = Meter(fraction: s.budget.capUsd > 0 ? ((min(s.budget.spentUsd / s.budget.capUsd, 1)) * 10_000).rounded() / 10_000 : 1,
                          level: s.budget.level)
        let meterValue = "\(Int((meter.fraction * 100).rounded())) percent of daily cap"
        let money = "\(f.usd(s.budget.spentUsd, cents: true)) / \(f.usd(s.budget.capUsd, cents: false))"
        let woke = s.lastWake?.at.flatMap(SessionLedger.parseISO)
        let waiting = s.openEscalations
        var normalDetail = [money, "watching \(s.watchedTabs)"]
        if waiting == 0 { normalDetail.append("nothing for you") }
        if let woke { normalDetail.append("woke \(f.ago(woke))") }
        let budgetSpoken = "\(f.spokenUsd(s.budget.spentUsd)) of \(f.spokenUsd(s.budget.capUsd)) today"
        let wokeSpoken = woke.map { "Last woke \(f.spokenAgo($0))." } ?? ""
        let watchingSpoken = "Watching \(s.watchedTabs) tab\(s.watchedTabs == 1 ? "" : "s")."
        func spoken(_ label: String) -> String {
            [label + ".", watchingSpoken, budgetSpoken + ".", wokeSpoken].filter { !$0.isEmpty }.joined(separator: " ")
        }
        let countSuffix = waiting > 0 ? " · \(waiting) waiting" : ""
        let resumeEnabled = !(s.budget.level == "reached" && s.budget.capUsd <= s.budget.spentUsd)

        func strip(_ state: SupervisorStripState, _ label: String, glyph: String? = nil, progress: Bool = false,
                   tone: Tone = .neutral, detail: String? = nil, kill: Bool = false, primary: Primary = .pause,
                   failure: Failure? = nil, help: String? = nil, spokenLabel: String? = nil) -> SupervisorStrip {
            SupervisorStrip(state: state, modeLabel: label, glyph: glyph, showsProgress: progress, tone: tone,
                            detail: detail ?? normalDetail.joined(separator: " · "), meter: meter, showKill: kill,
                            primary: primary, controlsEnabled: true, itemsEnabled: true, failure: failure, help: help,
                            accessibilityValue: spoken(spokenLabel ?? label), meterAccessibilityValue: meterValue)
        }

        if s.health == "failed" {
            let err = s.lastWake?.error
            return strip(.failed, "Wake failed", glyph: "xmark.octagon.fill", tone: .error, primary: .retry,
                         failure: Failure(headline: err?.message ?? "The supervisor's last wake failed", detail: err?.detail))
        }
        if s.health == "stale" {
            let queued = "\(s.queuedEvents) event\(s.queuedEvents == 1 ? "" : "s") queued"
            let detail = woke.map { "last woke \(f.ago($0)) · \(queued)" } ?? queued
            return strip(.stale, "Not waking", glyph: "exclamationmark.triangle.fill", tone: .warning, detail: detail,
                         primary: .restart, help: "Events are waiting and the supervisor has not woken for them.")
        }
        if s.run == "paused" {
            let reason = s.pause?.reason ?? "user"
            let at = s.pause?.at.flatMap(SessionLedger.parseISO).map(f.clock)
            switch reason {
            case "user":
                let queued = "\(s.queuedEvents) event\(s.queuedEvents == 1 ? "" : "s") queued"
                let detail = ["paused by you" + (at.map { " \($0)" } ?? ""), queued].joined(separator: " · ")
                return strip(.pausedByUser, "Paused", glyph: "pause.fill", detail: detail, primary: .resume(enabled: resumeEnabled))
            case "kill":
                let detail = "Kill" + (at.map { " at \($0)" } ?? "") + " " + (s.pause?.detail ?? "aborted the wake")
                return strip(.killed, "Paused — wake aborted", glyph: "stop.fill", detail: detail, primary: .resume(enabled: resumeEnabled))
            case "budget":
                let resets = s.budget.resetsAt.flatMap(SessionLedger.parseISO).map { " · resets \(f.clock($0))" } ?? ""
                return strip(.overBudget, "Paused — daily cap", glyph: "exclamationmark.triangle.fill", tone: .warning,
                             detail: "\(f.usd(s.budget.spentUsd, cents: true)) / \(f.usd(s.budget.capUsd, cents: false))\(resets)",
                             primary: .resume(enabled: resumeEnabled), spokenLabel: "Paused, daily cap reached")
            default:
                let label: String
                switch reason {
                case "breaker": label = "Paused — breaker"
                case "refusals": label = "Paused — 3 refused calls"
                case "repeated-failures": label = "Paused — repeated failures"
                default: label = "Paused — \(reason)"
                }
                return strip(.pausedByFault(reason), label, glyph: "exclamationmark.triangle.fill", tone: .warning,
                             detail: s.pause?.detail ?? label, primary: .resume(enabled: resumeEnabled))
            }
        }
        if s.run == "waking" {
            let n = s.currentWake?.itemCount
            let label = "Waking" + (n.map { " · \($0) item\($0 == 1 ? "" : "s")" } ?? "")
            return strip(.waking, label, progress: true, kill: true)
        }
        if s.mode == "autonomous" {
            let on = s.autonomousCategories
            return strip(.autonomous, "Autonomous · \(on.count) of \(SupervisorStatus.categories.count)" + countSuffix,
                         help: on.isEmpty ? nil : "Autonomous: " + on.joined(separator: ", "))
        }
        return strip(.shadow, "Shadow" + countSuffix, help: "Shadow: the supervisor only proposes.")
    }

    /// One worded announcement per state change, never "warning" (brief §9.2).
    public static func announcement(from old: SupervisorStripState, to new: SupervisorStripState) -> String? {
        guard old != new else { return nil }
        switch new {
        case .overBudget: return "Supervisor paused: daily cap reached"
        case .failed: return "Supervisor wake failed"
        case .pausedByUser: return "Supervisor paused"
        case .killed: return "Supervisor wake killed"
        case .pausedByFault(let r):
            return "Supervisor paused: " + (r == "breaker" ? "breaker tripped" : r == "refusals" ? "3 refused calls" : "repeated failures")
        case .stale: return "Supervisor is not waking"
        case .tokenUnavailable: return "Can't control the supervisor"
        case .off: return "Supervisor off"
        case .shadow, .autonomous:
            switch old {
            case .pausedByUser, .killed, .overBudget, .pausedByFault, .stale, .failed: return "Supervisor resumed"
            case .off: return "Supervisor started in shadow"
            default: return nil
            }
        case .waking, .disconnected: return nil
        }
    }

    /// Times, money and elapsed spans, in one place so the strip and its
    /// spoken value cannot disagree.
    struct Format {
        let now: Date
        let timeZone: TimeZone

        func usd(_ v: Double, cents: Bool) -> String {
            if !cents, v.rounded() == v { return "$\(Int(v))" }
            return String(format: "$%.2f", v)
        }
        func spokenUsd(_ v: Double) -> String {
            let whole = Int(v)
            let c = Int(((v - Double(whole)) * 100).rounded())
            let dollars = "\(whole) dollar\(whole == 1 ? "" : "s")"
            return c == 0 ? dollars : "\(dollars) \(c)"
        }
        func clock(_ d: Date) -> String {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = timeZone
            let c = cal.dateComponents([.hour, .minute], from: d)
            return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
        func ago(_ d: Date) -> String {
            let s = Int(max(0, now.timeIntervalSince(d)))
            if s < 60 { return "just now" }
            if s < 3600 { return "\(s / 60)m ago" }
            if s < 86_400 { return "\(s / 3600)h ago" }
            return "\(s / 86_400)d ago"
        }
        func spokenAgo(_ d: Date) -> String {
            let s = Int(max(0, now.timeIntervalSince(d)))
            func unit(_ n: Int, _ w: String) -> String { "\(n) \(w)\(n == 1 ? "" : "s") ago" }
            if s < 60 { return "just now" }
            if s < 3600 { return unit(s / 60, "minute") }
            if s < 86_400 { return unit(s / 3600, "hour") }
            return unit(s / 86_400, "day")
        }
    }
}

// MARK: - Needs you as the inbox (brief §5, §7 Burst)

public struct SupervisorInboxLayout: Equatable, Sendable {
    public struct TabGroup: Equatable, Sendable {
        public let all: [SupervisorInboxItem]
        public let shown: [SupervisorInboxItem]
        public var hiddenCount: Int { all.count - shown.count }
    }

    /// Supervisor rows (no tab): guardrails first, then oldest.
    public let tabless: [SupervisorInboxItem]
    public let byTab: [String: TabGroup]
    /// Tabs with open items, oldest item first.
    public let sessionIds: [String]
    /// Every open item — the section header's count.
    public let total: Int

    public init(items: [SupervisorInboxItem], expandedTabs: Set<String>) {
        let open = items.filter(\.isOpen)
        tabless = open.filter(\.isTabless).sorted { a, b in
            let ga = a.kind == "guardrail", gb = b.kind == "guardrail"
            if ga != gb { return ga }
            return a.createdAt < b.createdAt
        }
        var groups: [String: [SupervisorInboxItem]] = [:]
        for i in open { if let s = i.sessionId { groups[s, default: []].append(i) } }
        var map: [String: TabGroup] = [:]
        for (sid, list) in groups {
            let sorted = list.sorted { ($0.burstRank ?? 0, $0.createdAt) < ($1.burstRank ?? 0, $1.createdAt) }
            map[sid] = TabGroup(all: sorted, shown: expandedTabs.contains(sid) ? sorted : Array(sorted.prefix(1)))
        }
        byTab = map
        sessionIds = map.keys.sorted { (map[$0]?.all.first?.createdAt ?? "") < (map[$1]?.all.first?.createdAt ?? "") }
        total = open.count
    }

    public func items(for sessionId: String) -> [SupervisorInboxItem] { byTab[sessionId]?.all ?? [] }
}

// MARK: - Act chips (brief §6.2 item 5, §8)

public struct SupervisorActChips: Equatable, Sendable {
    /// Chips on their own line, recommended first. Never a default button.
    public let chips: [SupervisorInboxItem.Action]
    /// The ⋯ menu's server actions (Dismiss).
    public let menu: [SupervisorInboxItem.Action]
    /// A collapsed card holds an outward or destructive act: "Review act…"
    /// stands where its chip will be.
    public let showReviewAct: Bool
    /// The one accent chip in the group.
    public let primaryId: String?

    public init(actions: [SupervisorInboxItem.Action], expanded: Bool) {
        let ordered = actions.filter(\.recommended) + actions.filter { !$0.recommended }
        chips = ordered.filter { $0.role != "dismiss" && (expanded || !$0.requiresExpanded) }
        menu = ordered.filter { $0.role == "dismiss" }
        showReviewAct = !expanded && ordered.contains { $0.role != "dismiss" && $0.requiresExpanded }
        primaryId = chips.first(where: \.recommended)?.id
    }

    /// VoiceOver's custom actions: exactly the visible chips, so it never
    /// offers an act the card is hiding (brief §9.2).
    public var accessibilityActionNames: [String] {
        chips.map(\.label) + (showReviewAct ? ["Show full act"] : [])
    }
}

// MARK: - Delegation (brief §6.5) and ledger glyphs (§6.6)

extension SupervisorDelegation {
    /// Never only a colour: each level has its own glyph.
    public var glyph: String {
        switch self {
        case .off: return "circle.dashed"
        case .observe: return "eye"
        case .answerQuestions: return "questionmark.bubble"
        case .answerConfirms: return "checkmark.shield"
        }
    }
    public var title: String {
        switch self {
        case .off: return "Off"
        case .observe: return "Observe"
        case .answerQuestions: return "Answer questions"
        case .answerConfirms: return "Answer confirms"
        }
    }
    public var consequence: String {
        switch self {
        case .off: return "Not watched"
        case .observe: return "Reads and escalates; never acts"
        case .answerQuestions: return "Answers grounded questions, nudges inside the plan, narrows posture"
        case .answerConfirms: return "Also allows or denies ordinary confirms. Never pushes, merges or touches boundary paths"
        }
    }
    /// The accessibility value: "answer questions".
    public var spoken: String { title.lowercased() }
}

public enum SupervisorLedgerGlyph {
    public static func `for`(decision: String?, actor: String) -> String {
        if actor == "user" { return "person.fill" }
        if actor == "runtime" { return "gearshape" }
        switch decision {
        case "act": return "checkmark.circle.fill"
        case "propose": return "circle.dashed"
        case "escalate": return "hand.raised.fill"
        case "refuse": return "xmark.octagon.fill"
        case "drop": return "minus.circle"
        default: return "circle"
        }
    }
}

// MARK: - Announcements (brief §9.2)

/// One coalesced announcement per batch of arrivals, never one per item.
public struct SupervisorAnnouncer: Equatable, Sendable {
    private var known: Set<String>?
    /// Above this many arrivals at once, announce the count, not the names.
    public static let nameLimit = 3

    public init() {}

    public mutating func note(open items: [SupervisorInboxItem]) -> String? {
        let ids = Set(items.map(\.id))
        defer { known = ids }
        guard let known else {
            return items.isEmpty ? nil : Self.waiting(items.count)
        }
        let arrived = items.filter { !known.contains($0.id) }
        guard !arrived.isEmpty else { return nil }
        if arrived.count > Self.nameLimit { return Self.waiting(items.count) }
        let names = arrived.map { $0.tabTitle ?? ($0.isTabless ? "supervisor" : "a tab") }
        return "\(arrived.count) new escalation\(arrived.count == 1 ? "" : "s"): " + names.joined(separator: ", ")
    }

    private static func waiting(_ n: Int) -> String { "\(n) escalation\(n == 1 ? "" : "s") waiting" }
}

// MARK: - An answer from elsewhere closes the in-chat surface (plan M6 required fix)

public enum ExternalAnswer {
    public struct Note: Equatable, Sendable {
        public let text: String
        public let bySupervisor: Bool
        public init(text: String, bySupervisor: Bool) { self.text = text; self.bySupervisor = bySupervisor }
    }

    /// The note that replaces a pending sheet or card when its confirm was
    /// resolved outside this chat: by the API, the supervisor, or the Sessions
    /// pane. nil for our own answer (still in flight) or a confirm not pending here.
    public static func note(toolUseId: String, pending: [String], responding: Set<String>, answeredBy: String?) -> Note? {
        guard pending.contains(toolUseId), !responding.contains(toolUseId) else { return nil }
        switch answeredBy {
        case "supervisor": return Note(text: "Answered by the supervisor", bySupervisor: true)
        case "user": return Note(text: "Answered elsewhere by you", bySupervisor: false)
        default: return Note(text: "Answered elsewhere", bySupervisor: false)
        }
    }

    /// The whole transition, in one step: the note, and the confirm removed
    /// from the pending queue so nothing can answer it again.
    public static func apply(toolUseId: String, pending: inout [String], responding: Set<String>, answeredBy: String?) -> Note? {
        guard let n = note(toolUseId: toolUseId, pending: pending, responding: responding, answeredBy: answeredBy) else { return nil }
        pending.removeAll { $0 == toolUseId }
        return n
    }

    public static func canAnswer(_ toolUseId: String, pending: [String]) -> Bool { pending.contains(toolUseId) }
}

// MARK: - Posture revisions (plan M6, ADR-0108 hydration amendment)

/// The newest `postureRevision` this install has adopted, per session — what
/// the chat route's post echoes, so the server stops holding the API-set
/// fields over the app's. Monotonic; persisted; capped like the posture store.
public struct PostureRevisionLedger: Codable, Equatable, Sendable {
    public static let capacity = 200
    struct Entry: Codable, Equatable, Sendable { var id: String; var revision: Int }
    private var entries: [Entry] = []

    public init() {}

    public func echo(for sessionId: String) -> Int? { entries.first { $0.id == sessionId }?.revision }

    /// True when the server reports an API-set posture newer than the one we hold.
    public func shouldAdopt(sessionId: String, revision: Int?, source: String?) -> Bool {
        guard let revision, source != nil else { return false }
        return revision > (echo(for: sessionId) ?? 0)
    }

    public mutating func mark(_ sessionId: String, revision: Int) {
        guard !sessionId.isEmpty else { return }
        let next = max(revision, echo(for: sessionId) ?? 0)
        entries.removeAll { $0.id == sessionId }
        entries.insert(Entry(id: sessionId, revision: next), at: 0)
        if entries.count > Self.capacity { entries.removeLast(entries.count - Self.capacity) }
    }

    /// The API sets model, effort, strategy and mode; the rest stays local.
    public static func adopt(_ wire: SessionPostureWire, over local: SessionPosture) -> SessionPosture {
        func v(_ s: String?) -> String? { (s?.isEmpty == false) ? s : nil }
        var p = local
        if let m = v(wire.model) { p.executorModel = m }
        if let s = v(wire.permissionStrategy) { p.permissionStrategy = s }
        if let m = v(wire.mode) { p.mode = m }
        if let t = v(wire.thinkingMode) { p.thinkingMode = t }
        return p
    }

    public var jsonString: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }

    public static func decode(_ json: String?) -> PostureRevisionLedger {
        guard let json, let data = json.data(using: .utf8),
              let v = try? JSONDecoder().decode(PostureRevisionLedger.self, from: data) else { return PostureRevisionLedger() }
        return v
    }
}

// MARK: - Autonomy rows (brief §6.1, expanded block)

/// "16 proposals · 94 % agreed · bar 20 / 90 %". The suggested bar is shown and
/// never enforced (ADR-0127 §8): switching a category is the user's call.
public struct SupervisorStatsLine: Equatable, Sendable {
    public let text: String
    public let belowBar: Bool
    public let warning: String?

    public init(stats: SupervisorStatus.CategoryStats?, bar: SupervisorStatus.Bar?) {
        let b = bar ?? SupervisorStatus.Bar(minProposals: 20, minAgreement: 0.9)
        let barText = "bar \(b.minProposals) / \(Int((b.minAgreement * 100).rounded())) %"
        let n = stats?.proposals ?? 0
        var parts = ["\(n) proposal\(n == 1 ? "" : "s")"]
        if let r = stats?.agreementRate { parts.append("\(Int((r * 100).rounded())) % agreed") }
        parts.append(barText)
        text = parts.joined(separator: " · ")
        belowBar = n < b.minProposals || (stats?.agreementRate ?? 0) < b.minAgreement
        let h = stats?.humanOnlyProposedAsAct ?? 0
        warning = h > 0 ? "proposed a human-only act \(h)×" : nil
    }
}

extension SupervisorInboxItem {
    /// The "why it is here" line's glyph, per kind.
    public static func glyph(forKind kind: String) -> String {
        switch kind {
        case "question": return "questionmark.bubble"
        case "confirm": return "hand.raised"
        case "integration": return "arrow.triangle.merge"
        case "containment": return "lock.shield"
        case "discard": return "trash"
        case "boundary-path": return "exclamationmark.lock"
        case "posture-widen": return "arrow.up.left.and.arrow.down.right"
        case "scope": return "scope"
        case "new-tab": return "plus.rectangle.on.rectangle"
        case "guardrail": return "exclamationmark.triangle.fill"
        default: return "hand.raised"
        }
    }
}

// MARK: - The capability token (brief §10.9)

public enum SupervisorToken {
    /// `<MARVIN_DATA_DIR>/supervisor/token`, with the sidecar's fallback to
    /// `~/.marvin` (`paths.ts`: the variable trimmed, blank ignored).
    public static func path(environment: [String: String], home: String) -> String {
        let raw = environment["MARVIN_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let dir = raw.isEmpty ? (home as NSString).appendingPathComponent(".marvin") : (raw as NSString).standardizingPath
        return ((dir as NSString).appendingPathComponent("supervisor") as NSString).appendingPathComponent("token")
    }

    /// The sidecar writes 64 hex characters and a newline. Anything else is
    /// refused rather than sent as a header: a file that could carry a CR/LF
    /// must never reach `setValue(_:forHTTPHeaderField:)`.
    public static func parse(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count == 64, t.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains($0) })
        else { return nil }
        return t
    }
}

// MARK: - Transcript marking (brief §6.8)

public enum SupervisorEnvelope {
    public static let openTag = "<supervisor-message>"
    public static let closeTag = "</supervisor-message>"

    /// The supervisor's own words inside the envelope the sidecar wraps them
    /// in; the whole message when there is no envelope.
    public static func body(_ message: String) -> String {
        guard let open = message.range(of: openTag),
              let close = message.range(of: closeTag, range: open.upperBound..<message.endIndex) else { return message }
        return message[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The inline chip on a supervisor-given answer or decision.
    public static func answeredChip(decision: String, isQuestion: Bool) -> String {
        if isQuestion { return "answered by supervisor" }
        return decision == "deny" ? "denied by supervisor" : "allowed by supervisor"
    }

    public static let touchedDivider =
        "Supervisor touched this turn · pushes, merges and boundary edits now ask you, even in full auto"
}

// MARK: - Activity rail entry (2026-10-31)

/// The Supervisor's icon in the left activity rail: a second way to the pinned
/// tab, for when many chat tabs push it out of sight. Present on the same rule
/// as the tab; its badge counts what Needs you counts for the supervisor —
/// every open inbox item (`SupervisorInboxLayout.total`).
public struct SupervisorRailEntry: Equatable, Sendable {
    public let badge: Int

    /// nil while the supervisor is off: no icon, as there is no tab.
    public static func make(mode: String?, openItems: Int) -> SupervisorRailEntry? {
        guard SupervisorChat.tabVisible(mode: mode) else { return nil }
        return SupervisorRailEntry(badge: max(0, openItems))
    }

    /// The rail is 44 pt wide; a badge past two digits would cover the glyph.
    public var badgeText: String? {
        guard PaneBadge.shows(badge) else { return nil }
        return badge > 99 ? "99+" : String(badge)
    }

    /// Tooltip and VoiceOver label in one.
    public var label: String {
        guard badge > 0 else { return "Supervisor" }
        return "Supervisor — \(badge) waiting for you"
    }
}

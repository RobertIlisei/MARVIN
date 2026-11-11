// SupervisorMerge — the standing merge authorisation as values (ADR-0134, plan [6.6]).
//
// The user may give a project ONE standing, expiring authorisation: finished tab
// branches merge into one named local branch, each behind a gate command the
// user approved. The RUNTIME merges; the supervisor can only hold a branch or
// undo its own hold. Nothing here is an act: the card is the consent (the
// user's click, ADR-0128), and the workspace reads the authorisation, shows it
// at all times, and offers the user's own revoke / release / check-again.
// Pure logic and wire types, pinned by assertions (ADR-0114).

import Foundation

// MARK: - Shared wire pieces

public struct SupervisorMergeHold: Decodable, Equatable, Sendable {
    public struct Window: Decodable, Equatable, Sendable {
        public let from: String
        public let to: String
        public init(from: String, to: String) { self.from = from; self.to = to }
    }
    public let pathGlob: String
    public let window: Window
    public init(pathGlob: String, window: Window) { self.pathGlob = pathGlob; self.window = window }
}

/// What the merge card shows (`item.queue.proposal` on a `merge` card): the target and the gate command in full.
public struct SupervisorMergeProposal: Decodable, Equatable, Sendable {
    public let target: String
    public let gate: String
    public let timeoutMs: Int
    public let holds: [SupervisorMergeHold]
    public let validForHours: Int
    public let timeZone: String
    public init(target: String, gate: String, timeoutMs: Int, holds: [SupervisorMergeHold] = [], validForHours: Int, timeZone: String) {
        self.target = target; self.gate = gate; self.timeoutMs = timeoutMs; self.holds = holds
        self.validForHours = validForHours; self.timeZone = timeZone
    }
}

/// The authorisation a new card would end.
public struct SupervisorMergeReplaces: Decodable, Equatable, Sendable {
    public let target: String
    public let gate: String
    public init(target: String, gate: String) { self.target = target; self.gate = gate }
}

// MARK: - GET /api/supervisor/merge

public struct SupervisorMergeView: Decodable, Equatable, Sendable {
    public struct Authorisation: Decodable, Equatable, Sendable {
        public let target: String
        /// The text the user approved, in full.
        public let gate: String
        public let timeoutSeconds: Int
        public let holds: [SupervisorMergeHold]
        public let approvedAt: String
        public let expiresAt: String
        public let timeZone: String
        public let expired: Bool
        public init(target: String, gate: String, timeoutSeconds: Int, holds: [SupervisorMergeHold], approvedAt: String,
                    expiresAt: String, timeZone: String, expired: Bool) {
            self.target = target; self.gate = gate; self.timeoutSeconds = timeoutSeconds; self.holds = holds
            self.approvedAt = approvedAt; self.expiresAt = expiresAt; self.timeZone = timeZone; self.expired = expired
        }
    }
    public struct Ended: Decodable, Equatable, Sendable {
        /// `revoked` | `expired`.
        public let why: String
        public let at: String
        public let target: String
        public init(why: String, at: String, target: String) { self.why = why; self.at = at; self.target = target }
    }
    public struct BranchHold: Decodable, Equatable, Sendable {
        public let branch: String
        public let reason: String
        public let at: String
        /// Only `supervisor` holds exist; the user's release is the route's.
        public let by: String
    }
    public struct Branch: Decodable, Equatable, Sendable, Identifiable {
        public var id: String { branch }
        public let branch: String
        /// `merged` | `skipped` | `failed` | `waiting` | `running` | `held`; anything else reads as skipped.
        public let status: String
        public let code: String
        public let reason: String
        public let at: String
        /// `clean` | `conflict` | `unknown`.
        public let prediction: String?
        public let gateExit: Int?
        public let commit: String?
        /// What was (or could not be) sent to the tab: the conflict list, the failing output's tail.
        public let report: String?
        /// `sent` | `recorded` (a closed tab cannot be messaged).
        public let reported: String?
        public let tab: String?
        public init(branch: String, status: String, code: String, reason: String, at: String, prediction: String?,
                    gateExit: Int?, commit: String?, report: String?, reported: String?, tab: String?) {
            self.branch = branch; self.status = status; self.code = code; self.reason = reason; self.at = at
            self.prediction = prediction; self.gateExit = gateExit; self.commit = commit; self.report = report
            self.reported = reported; self.tab = tab
        }
    }
    public struct Running: Decodable, Equatable, Sendable {
        /// `predicting` | `merging` | `gate` | `advancing`.
        public let stage: String
        public let branch: String
        public let startedAt: String
    }

    public let authorisation: Authorisation?
    public let ended: Ended?
    public let holds: [BranchHold]
    public let branches: [Branch]
    public let running: Running?

    private enum CodingKeys: String, CodingKey { case authorisation, ended, holds, branches, running }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        authorisation = try? c.decodeIfPresent(Authorisation.self, forKey: .authorisation)
        ended = try? c.decodeIfPresent(Ended.self, forKey: .ended)
        holds = (try? c.decode([BranchHold].self, forKey: .holds)) ?? []
        branches = (try? c.decode([Branch].self, forKey: .branches)) ?? []
        running = try? c.decodeIfPresent(Running.self, forKey: .running)
    }

    public init(authorisation: Authorisation? = nil, ended: Ended? = nil, holds: [BranchHold] = [],
                branches: [Branch] = [], running: Running? = nil) {
        self.authorisation = authorisation; self.ended = ended; self.holds = holds
        self.branches = branches; self.running = running
    }

    public static func decode(_ data: Data) -> SupervisorMergeView? {
        try? JSONDecoder().decode(SupervisorMergeView.self, from: data)
    }
}

// MARK: - What the workspace says

public enum SupervisorMergePresentation {
    public static let maxValidDays = 14
    public static let minTimeoutMinutes = 1
    public static let maxTimeoutMinutes = 240
    public static let defaultTimeoutMinutes = 90
    public static let defaultValidDays = 7
    public static let maxGateChars = 1000

    public enum Tone: Equatable, Sendable { case neutral, active, held, needsYou, done }

    public struct RowState: Equatable, Sendable {
        public let label: String
        public let tone: Tone
        public let reason: String
    }

    /// One branch's state in words; the reason is the pass's own, shown whole.
    public static func rowState(_ b: SupervisorMergeView.Branch) -> RowState {
        switch b.status {
        case "merged": return RowState(label: "Merged", tone: .done, reason: b.reason)
        case "failed": return RowState(label: "Failed", tone: .needsYou, reason: b.reason)
        case "held": return RowState(label: "Held", tone: .held, reason: b.reason)
        case "waiting": return RowState(label: "Waiting", tone: .held, reason: b.reason)
        case "running": return RowState(label: "Running", tone: .active, reason: b.reason)
        default: return RowState(label: "Skipped", tone: .neutral, reason: b.reason)
        }
    }

    /// Who placed a branch hold and why — the supervisor's holds are the only ones that exist, and they say so.
    public static func holdLine(_ h: SupervisorMergeView.BranchHold) -> String {
        "\(h.branch) — held by the \(h.by): \(h.reason)"
    }

    /// "scripts/gate/** only 21:00–07:00 (Europe/Bucharest)".
    public static func ruleLine(_ h: SupervisorMergeHold, timeZone: String) -> String {
        let zone = timeZone.isEmpty ? "local time" : timeZone
        return "\(h.pathGlob) only \(h.window.from)–\(h.window.to) (\(zone))"
    }

    /// What the pass is doing now, or nil.
    public static func runningLine(_ r: SupervisorMergeView.Running, now: Date = Date()) -> String {
        let stage: String
        switch r.stage {
        case "predicting": stage = "Checking"
        case "merging": stage = "Merging"
        case "gate": stage = "Gate running on"
        case "advancing": stage = "Moving the target to"
        default: stage = "Working on"
        }
        let since = SupervisorMergePresentation.date(r.startedAt).map { elapsed(from: $0, to: now) }
        return since.map { "\(stage) \(r.branch) · \($0)" } ?? "\(stage) \(r.branch)"
    }

    /// The one line shown at all times: on / off / how it ended, and when it expires.
    public static func statusLine(_ v: SupervisorMergeView?, now: Date = Date()) -> String {
        guard let v else { return "Standing merge: reading…" }
        if let a = v.authorisation {
            if a.expired { return "Standing merge into \(a.target): expired — nothing merges until you approve a new one" }
            return "Standing merge into \(a.target) · \(expiryText(a.expiresAt, now: now))"
        }
        if let e = v.ended {
            return "Standing merge into \(e.target): \(e.why == "expired" ? "expired" : "revoked") — nothing merges without your click"
        }
        return "Standing merge: off — nothing merges without your click"
    }

    public static func expiryText(_ iso: String, now: Date = Date()) -> String {
        guard let d = date(iso) else { return "expires \(iso)" }
        let secs = Int(d.timeIntervalSince(now))
        if secs <= 0 { return "expired" }
        if secs >= 2 * 86_400 { return "expires in \(secs / 86_400) days" }
        if secs >= 3_600 { return "expires in \(secs / 3_600) h" }
        return "expires in \(max(1, secs / 60)) min"
    }

    /// The first branch waiting on the user's own checkout, so the workspace can say so in words and offer "Check again".
    public static func waitingForCheckout(_ v: SupervisorMergeView) -> SupervisorMergeView.Branch? {
        v.branches.first { $0.status == "waiting" && $0.code == "checkout-busy" }
    }

    public static func summary(_ v: SupervisorMergeView) -> String {
        let merged = v.branches.filter { $0.status == "merged" }.count
        let waiting = v.branches.filter { $0.status == "waiting" || $0.status == "held" }.count
        let failed = v.branches.filter { $0.status == "failed" }.count
        var parts = ["\(merged) merged"]
        if waiting > 0 { parts.append("\(waiting) waiting or held") }
        if failed > 0 { parts.append("\(failed) failed") }
        return parts.joined(separator: " · ")
    }

    /// "exit 3 · commit a1b2c3d · predicted clean" — the facts the ledger carries, per branch.
    public static func factsLine(_ b: SupervisorMergeView.Branch) -> String {
        var parts: [String] = []
        if let p = b.prediction { parts.append("predicted \(p)") }
        if let g = b.gateExit { parts.append("gate exit \(g)") }
        if let c = b.commit { parts.append("commit \(c.prefix(10))") }
        if let t = b.tab { parts.append(t) }
        if let r = b.reported { parts.append(r == "sent" ? "sent to the tab" : "recorded here — the tab could not be messaged") }
        return parts.joined(separator: " · ")
    }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    static func elapsed(from: Date, to: Date) -> String {
        let s = max(0, Int(to.timeIntervalSince(from)))
        if s >= 3_600 { return "\(s / 3_600) h \((s % 3_600) / 60) min" }
        if s >= 60 { return "\(s / 60) min" }
        return "\(s) s"
    }

    // MARK: The card

    /// The card's lines: nothing is summarised, because that exact text is what the user approves.
    public static func cardLines(_ p: SupervisorMergeProposal, replaces: SupervisorMergeReplaces?) -> [String] {
        var out = [
            "Merge finished tab branches into \(p.target) — a local branch, never pushed, tagged or sent as a merge request.",
            "Each branch merges in a scratch copy first, and \(p.target) moves only if the gate command exits 0 within \(p.timeoutMs / 60_000) minutes.",
            "Valid for \(validText(hours: p.validForHours)) from your click; you can revoke it at any time.",
        ]
        for h in p.holds { out.append("Hold: \(ruleLine(h, timeZone: p.timeZone))") }
        if let r = replaces { out.append("Replaces the authorisation into \(r.target) that runs: \(r.gate)") }
        return out
    }

    public static func validText(hours: Int) -> String {
        hours % 24 == 0 ? "\(hours / 24) day\(hours / 24 == 1 ? "" : "s")" : "\(hours) hours"
    }

    // MARK: The form

    public struct HoldParse: Equatable, Sendable {
        public let holds: [SupervisorMergeHold]
        public let error: String?
    }

    /// One rule per line: `scripts/gate/** | 21:00-07:00`. A bad line is named, nothing is guessed.
    public static func parseHolds(_ text: String) -> HoldParse {
        var holds: [SupervisorMergeHold] = []
        for (i, raw) in text.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let halves = line.split(separator: "|", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard halves.count == 2, !halves[0].isEmpty else { return HoldParse(holds: [], error: "Line \(i + 1): write a path pattern, a bar, then a window like 21:00-07:00.") }
            let times = halves[1].split(separator: "-").map { $0.trimmingCharacters(in: .whitespaces) }
            guard times.count == 2, isClock(times[0]), isClock(times[1]), times[0] != times[1] else {
                return HoldParse(holds: [], error: "Line \(i + 1): the window is two different times like 21:00-07:00.")
            }
            holds.append(SupervisorMergeHold(pathGlob: halves[0], window: .init(from: times[0], to: times[1])))
        }
        return HoldParse(holds: holds, error: nil)
    }

    static func isClock(_ s: String) -> Bool {
        let p = s.split(separator: ":")
        guard p.count == 2, p[0].count == 2, p[1].count == 2, let h = Int(p[0]), let m = Int(p[1]) else { return false }
        return (0...23).contains(h) && (0...59).contains(m)
    }

    /// Why the form cannot raise a card yet, or nil.
    public static func formError(target: String, gate: String, validDays: Int, timeoutMinutes: Int) -> String? {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "Name the branch to merge into." }
        if t.hasPrefix("marvin/") { return "Merge into your integration branch, not one of MARVIN's own marvin/ branches." }
        let g = gate.trimmingCharacters(in: .whitespacesAndNewlines)
        if g.isEmpty { return "Write the gate command." }
        if g.count > maxGateChars { return "The gate command is at most \(maxGateChars) characters." }
        if !(1...maxValidDays).contains(validDays) { return "Valid for 1 to \(maxValidDays) days." }
        if !(minTimeoutMinutes...maxTimeoutMinutes).contains(timeoutMinutes) { return "The gate's time limit is \(minTimeoutMinutes) to \(maxTimeoutMinutes) minutes." }
        return nil
    }

    // MARK: Request bodies — the user's own acts; the approval is the inbox card's click

    /// Raises the card that shows the target and the gate in full; it authorises nothing until that card is clicked.
    public static func proposeBody(projectId: String, target: String, gate: String, validDays: Int, timeoutMinutes: Int, holds: [SupervisorMergeHold]) -> [String: Any] {
        [
            "projectId": projectId, "action": "propose",
            "target": target.trimmingCharacters(in: .whitespacesAndNewlines),
            "gate": gate.trimmingCharacters(in: .whitespacesAndNewlines),
            "validForHours": min(maxValidDays, max(1, validDays)) * 24,
            "timeoutSeconds": min(maxTimeoutMinutes, max(minTimeoutMinutes, timeoutMinutes)) * 60,
            "holds": holds.map { ["pathGlob": $0.pathGlob, "window": ["from": $0.window.from, "to": $0.window.to]] as [String: Any] },
        ]
    }
    public static func revokeBody(projectId: String) -> [String: Any] { ["projectId": projectId, "action": "revoke"] }
    public static func releaseHoldBody(projectId: String, branch: String) -> [String: Any] { ["projectId": projectId, "action": "release-hold", "branch": branch] }
    public static func retryBody(projectId: String) -> [String: Any] { ["projectId": projectId, "action": "retry"] }
}

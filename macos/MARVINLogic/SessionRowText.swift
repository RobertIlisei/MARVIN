// SessionRowText — what a Sessions-pane row says (UX review round 2, R2-11,
// W-03, W-10).
//
// A row used to be ten facts joined with " · " on one 9.5 pt line, cut in the
// middle, with the state last: "isolated: marvin/tab/... · 21 commits · +880
// −13 · graph 20 · reads 19 (1.0×) · skills 0/6 · $4.10 · Done · 6m ago". The
// owner watching fourteen tabs reads the state first and one fact second, so a
// row is now two lines:
//
//   line 1   the name, then the STATE SENTENCE ("Waiting 12 min") that is never
//            cut before the name is;
//   line 2   the ONE fact that matters for that state;
//
// and everything that is a measurement of the work rather than a status (graph
// calls, reads, skills, cost, commits, the plan) moves to the row's hover card.
//
// Pure, over `SessionEntry` and the row's derived state, so every sentence is
// tested without a view.

import Foundation

public enum SessionRowText {
    /// "30s", "6m", "2h", "3d". Never negative; the same words the pane has always used.
    public static func ago(_ date: Date, now: Date) -> String {
        let s = Int(max(0, now.timeIntervalSince(date)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86_400 { return "\(s / 3600)h" }
        return "\(s / 86_400)d"
    }

    // MARK: - Line 1: the state sentence

    public static func stateSentence(_ state: SessionRowState, _ e: SessionEntry, now: Date) -> String {
        switch state {
        case .needsYou(let n): return n > 1 ? "Needs you (\(n))" : "Needs you"
        case .working: return e.liveSince.map { "Working \(ago($0, now: now))" } ?? "Working"
        case .interrupted: return "Cut off"
        case .failed: return e.lastTurnAt.map { "Failed \(ago($0, now: now)) ago" } ?? "Failed"
        case .waiting: return e.waitSince.map { "Waiting \(SessionWait.duration(since: $0, now: now))" } ?? "Waiting"
        case .finished: return e.lastTurnAt.map { "Finished \(ago($0, now: now)) ago" } ?? "Finished"
        case .done: return e.lastTurnAt.map { "Done \(ago($0, now: now)) ago" } ?? "Done"
        case .idle: return e.lastTurnAt.map { "Idle \(ago($0, now: now))" } ?? "Idle"
        case .draft: return "New"
        }
    }

    /// The sentence for a row whose group header already names its state and
    /// whose pane is narrow: Finished rows say only how long ago ("3m ago"), so
    /// the fact beside it ("merged") still fits at 260 pt. Every other state
    /// keeps its full sentence.
    public static func narrowSentence(_ state: SessionRowState, _ e: SessionEntry, now: Date) -> String {
        guard state == .finished, let ended = e.lastTurnAt else { return stateSentence(state, e, now: now) }
        return "\(ago(ended, now: now)) ago"
    }

    // MARK: - Line 2: the one fact

    public static func keyFact(_ state: SessionRowState, _ e: SessionEntry, now: Date) -> String? {
        switch state {
        case .needsYou:
            if let c = e.pendingConfirms.values.sorted(by: { ($0.since ?? "") < ($1.since ?? "") }).first {
                let tool = ToolLabel.plain(c.toolName)
                let what = (c.excerpt ?? "").split(whereSeparator: \.isNewline).joined(separator: " ")
                    .trimmingCharacters(in: .whitespaces)
                return what.isEmpty ? "asks to use \(tool)" : "\(tool): \(what)"
            }
            if let a = e.attention { return a.kind == "chain-cap" ? "stopped at the chain cap" : "asked you a question" }
            return "waiting for your answer"
        case .working:
            return e.activityLabel ?? "running"
        case .interrupted:
            return "a restart cut off its last turn"
        case .failed:
            return "its last turn ended with an error"
        case .waiting:
            guard let w = e.waitingOn else { return nil }
            return SessionWait.label(kind: w.kind, label: w.label, cause: w.cause)
        case .finished where e.isMergedOrGone:
            // One short word, so a 260 pt row keeps it: there is nothing left to
            // review in the tree. Where it merged to is on the hover card.
            return e.worktree?.mergedInto != nil || e.worktree?.state == "merged" ? "merged" : "worktree gone"
        case .finished, .done:
            if let into = e.worktree?.mergedInto { return "merged into \(into); close the tab to reclaim the branch" }
            return changes(e) ?? planLine(e, now: now, withAge: false) ?? (state == .done ? "scope met" : "its turn completed")
        case .idle:
            return planLine(e, now: now, withAge: false) ?? changes(e) ?? treeLabel(e, full: false)
        case .draft:
            return "no message sent yet"
        }
    }

    // MARK: - The hover card: what is a measurement, not a status

    /// First line the full name, second the id; then only the facts that exist.
    public static func details(_ state: SessionRowState, _ e: SessionEntry, now: Date, name: String,
                               claim: String?, supervisorEnabled: Bool, isOpenTab: Bool = true) -> [String] {
        var lines = [name, e.id]
        if !isOpenTab { lines.append("Not open as a tab. Open it to read the conversation.") }
        lines.append(treeLabel(e, full: true))
        if let path = e.tree?.path { lines.append(path) }
        if let w = e.worktree {
            var parts = ["\(w.commits) commit\(w.commits == 1 ? "" : "s")"]
            if w.dirty { parts.append("uncommitted changes") }
            if let b = w.behind, b > 0 { parts.append("behind by \(b)") }
            if let into = w.mergedInto { parts.append("merged into \(into)") }
            lines.append(parts.joined(separator: " \u{B7} "))
        }
        if let d = changes(e) { lines.append(d) }
        if let p = planLine(e, now: now, withAge: true) { lines.append(p) }
        if let u = e.graphUsage {
            let reads = u.fileReads + u.bashReads
            var g = u.ratio.map { "graph \(u.graphCalls) \u{B7} reads \(reads) (\(String(format: "%.1f", $0))\u{D7})" }
                ?? "graph \(u.graphCalls) \u{B7} reads \(reads)"
            g += " \u{2014} Read/Grep \(u.fileReads), shell \(u.bashReads)"
            lines.append(g)
        }
        if let s = e.skills, !s.required.isEmpty {
            var line = "skills \(s.used.count)/\(s.required.count) used"
            if !s.missing.isEmpty { line += " \u{B7} not run: " + s.missing.joined(separator: ", ") }
            lines.append(line)
            if let first = s.first, !first.isEmpty { lines.append("start skills (before the first change): " + first.joined(separator: ", ")) }
        }
        if let c = e.costUsd, c > 0 { lines.append(String(format: "$%.2f", c)) }
        if let claim, !claim.isEmpty { lines.append("holding: " + claim) }
        if supervisorEnabled, let sup = e.supervisor, sup.delegation != .off {
            if sup.stoppedByUser == true { lines.append("stopped \u{2014} supervisor waits for you") }
            else if let w = sup.waitingOnOwn { lines.append("supervisor waits \u{2014} tab waiting on its \(w == "job" ? "build" : "wakeup")") }
        }
        return lines
    }

    // MARK: - Pieces

    /// "own branch fix-the-thing" on the row, the full branch on the card;
    /// "shared checkout" when the tab works in the project's own tree. One
    /// word per concept: this is what the tab header chip calls "own branch".
    private static func treeLabel(_ e: SessionEntry, full: Bool) -> String {
        guard e.tree?.mode == .worktree else { return e.isDraft ? "draft" : "shared checkout" }
        guard let branch = e.tree?.branch ?? e.worktree?.branch, !branch.isEmpty else { return "own branch" }
        let shown = full || !branch.hasPrefix("marvin/tab/") ? branch : String(branch.dropFirst("marvin/tab/".count))
        return "own branch \(shown)"
    }

    private static func changes(_ e: SessionEntry) -> String? {
        guard let d = e.diff, d.files > 0 else { return nil }
        return "\(d.files) file\(d.files == 1 ? "" : "s") \u{B7} +\(d.added) \u{2212}\(d.removed)"
    }

    private static func planLine(_ e: SessionEntry, now: Date, withAge: Bool) -> String? {
        guard let p = e.plan, p.total > 0 else { return nil }
        var line = "\(p.done)/\(p.total) steps"
        guard withAge else { return line }
        if let at = p.lastTodoAt, let d = SessionLedger.parseISO(at) {
            line += " \u{B7} updated \(ago(d, now: now)) ago"
            if p.isStale(now: now, lastActivity: e.isLive ? now : e.lastTurnAt) { line = "\u{26A0}\u{FE0E} " + line }
        }
        if p.seeded == true { line += " \u{B7} seeded from the brief" }
        return line
    }
}

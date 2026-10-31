import Foundation

// ADR-0128 / plan [7.1] — the Supervisor tab's decisions, as values the
// MARVINTests runner can assert (ADR-0114: decisions in MARVINLogic, drawing
// in MARVIN). Brief §12.

/// One line of `GET /api/supervisor/message`.
public struct SupervisorChatMessage: Decodable, Equatable, Identifiable, Sendable {
    /// A reply's origin: the user messages its wake carried (`message`), or — [7.3] —
    /// the follow a report is about (`follow`). A report answers no user message.
    public struct Origin: Decodable, Equatable, Sendable {
        public let kind: String
        public let messageIds: [String]
        public let followId: String?
        public init(messageIds: [String]) { self.kind = "message"; self.messageIds = messageIds; self.followId = nil }
        public init(followId: String) { self.kind = "follow"; self.messageIds = []; self.followId = followId }
        enum CodingKeys: String, CodingKey { case kind, messageIds, followId }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "message"
            messageIds = try c.decodeIfPresent([String].self, forKey: .messageIds) ?? []
            followId = try c.decodeIfPresent(String.self, forKey: .followId)
        }
    }
    /// [7.3] — a tab, ledger line or inbox item a reply mentions, resolved by the server.
    /// `label` is the server's (a tab's title, a line's verb, an item's raw act), never the reply's prose.
    public struct Ref: Decodable, Equatable, Hashable, Sendable {
        public let kind: String
        public let id: String
        public let label: String
        public init(kind: String, id: String, label: String) { self.kind = kind; self.id = id; self.label = label }
    }
    public let id: String
    public let at: String
    /// `user` or `supervisor`.
    public let from: String
    public let text: String
    /// [7.3] — `report`: a follow's report, the one reply no user message asked for.
    public let kind: String?
    /// A reply's wake and the user messages it answers.
    public let wakeId: String?
    public let origin: Origin?
    /// [7.2] — the inbox items this reply's wake raised for its messages (server-filtered): the cards under it.
    public let items: [String]?
    /// [7.3] — the links under it.
    public let refs: [Ref]?

    public init(id: String, at: String, from: String, text: String, kind: String? = nil, wakeId: String? = nil, origin: Origin? = nil, items: [String]? = nil, refs: [Ref]? = nil) {
        self.id = id; self.at = at; self.from = from; self.text = text; self.kind = kind; self.wakeId = wakeId; self.origin = origin; self.items = items; self.refs = refs
    }

    public var isReply: Bool { from == "supervisor" }
    public var isReport: Bool { isReply && kind == "report" }
}

/// [7.3] — one line of `GET /api/supervisor/follows`.
public struct SupervisorFollow: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let sessionId: String
    public let tabTitle: String?
    /// `scope-met` or `merge-ready`.
    public let until: String
    /// `open` or `ended`.
    public let state: String
    public let endedBy: String?
    public init(id: String, sessionId: String, tabTitle: String?, until: String, state: String = "open", endedBy: String? = nil) {
        self.id = id; self.sessionId = sessionId; self.tabTitle = tabTitle; self.until = until; self.state = state; self.endedBy = endedBy
    }
    public var isOpen: Bool { state == "open" }
}

public struct SupervisorFollows: Decodable, Equatable, Sendable {
    public let follows: [SupervisorFollow]
}

/// The GET's body.
public struct SupervisorConversation: Decodable, Equatable, Sendable {
    public let messages: [SupervisorChatMessage]
    public init(messages: [SupervisorChatMessage]) { self.messages = messages }
}

public enum SupervisorChat {
    /// The server's limit (`MAX_USER_MESSAGE_CHARS`).
    public static let maxMessageChars = 4_000

    /// Brief §12.1 — the pinned tab exists only while the supervisor is on; the
    /// Sessions pane's off line stays the one place to start it.
    public static func tabVisible(mode: String?) -> Bool {
        guard let mode else { return false }
        return mode != "off"
    }

    /// Brief §12.4 — user messages no reply names yet ("Waiting for the current wake").
    /// A reply written before milestone 7 carries no origin and answers everything before it.
    public static func waiting(_ messages: [SupervisorChatMessage]) -> [String] {
        var answered = Set<String>()
        var legacyCut = -1
        for (i, m) in messages.enumerated() where m.isReply {
            if let o = m.origin { answered.formUnion(o.messageIds) } else { legacyCut = i }
        }
        return messages.enumerated()
            .filter { $0.offset > legacyCut && !$0.element.isReply && !answered.contains($0.element.id) }
            .map(\.element.id)
    }

    /// The text the composer may send, trimmed; nil when it may not.
    public static func sendable(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || t.count > maxMessageChars ? nil : t
    }

    /// [7.2] — what stands under a reply for one id it lists. The card is the
    /// inbox item itself (ADR-0128 §3): open, it is the escalation card with the
    /// server's actions; settled anywhere, it collapses to one line.
    public enum Card: Equatable, Sendable {
        case open(SupervisorInboxItem)
        case settled(id: String, line: String)
        /// Not fetched yet, or gone: nothing is drawn — the reply's text never stands in for a card.
        case missing
    }

    public static func card(_ id: String, items: [String: SupervisorInboxItem]) -> Card {
        guard let i = items[id] else { return .missing }
        return i.isOpen ? .open(i) : .settled(id: id, line: settledLine(i))
    }

    /// Brief §12.2 — "Done — you merged fix-flags". The words after the dash are the
    /// server's raw-act summary, so the app invents no act verb (§11).
    public static func settledLine(_ i: SupervisorInboxItem) -> String {
        let what = i.rawAct?.summary ?? i.escalatedBecause.label
        switch (i.state, i.resolvedBy) {
        case ("resolved", "user"): return "Done — \(what)"
        case ("resolved", "tab"): return "Answered in the tab — \(what)"
        case ("dismissed", _): return "Dismissed — \(what)"
        default: return "No longer needed — \(what)"
        }
    }

    /// Ids every reply lists, in order, once — what the conversation fetches cards for.
    public static func cardIds(_ messages: [SupervisorChatMessage]) -> [String] {
        var seen = Set<String>()
        return messages.flatMap { $0.items ?? [] }.filter { seen.insert($0).inserted }
    }

    /// [7.2] brief — a send card says whose message it is, and names the tab's level
    /// when that is why it is a card (ADR-0128 §4: card-sent messages stay the supervisor's).
    public static func sendNote(_ i: SupervisorInboxItem) -> String? {
        guard i.rawAct?.toolName == "send" else { return nil }
        let arrives = "Sent, it arrives in the tab as the supervisor's message, not yours."
        return i.escalatedBecause.code == "delegation-observe" ? "The tab is at observe. \(arrives)" : arrives
    }

    /// The text a send card would deliver — what its "Edit…" sheet starts from.
    public static func sendText(_ i: SupervisorInboxItem) -> String? {
        guard i.rawAct?.toolName == "send", case .object(let o)? = i.rawAct?.input, case .string(let t)? = o["message"] else { return nil }
        return t
    }

    /// ADR-0128 §6 — under a user message the supervisor could not answer.
    public enum Unanswered: Equatable, Sendable {
        case retrying(attempt: Int)
        case failed
    }

    public static func unanswered(_ messageId: String, retry: SupervisorStatus.MessageRetry?) -> Unanswered? {
        guard let r = retry, r.messageIds.contains(messageId) else { return nil }
        return r.state == "failed" ? .failed : .retrying(attempt: r.attempts)
    }

    // MARK: - [7.4] The rest of the brief's states

    /// ADR-0128 §7 — at the cap the conversation ends with the budget guardrail item itself,
    /// with its Raise cap… chip; nothing else in the inbox is drawn there.
    public static func budgetGuardrail(_ inbox: [SupervisorInboxItem]) -> SupervisorInboxItem? {
        inbox.first { $0.kind == "guardrail" && $0.isOpen && ($0.guardrail?.kind == "budget" || $0.escalatedBecause.code == "budget") }
    }

    /// Brief §12.4 — the paused notice above the composer, and whether it carries the
    /// strip's Resume. At the cap the guardrail's Raise cap… is the verb, so no Resume;
    /// and while that card is drawn it *is* the notice, so there is no second one.
    public static func pausedNotice(_ status: SupervisorStatus?, budgetCard: Bool) -> (headline: String, resume: Bool)? {
        guard status?.run == "paused" else { return nil }
        if status?.pause?.reason == "budget" {
            return budgetCard ? nil : ("Paused at today's cap — your message waits until you raise it", false)
        }
        return ("Paused — your message waits until you resume", true)
    }

    /// Brief §12.4 — under a message no wake has carried yet.
    public static func waitingLine(paused: Bool) -> String {
        paused ? "Waiting — the supervisor is paused" : "Waiting for the next wake"
    }

    /// Brief §12.7 — what VoiceOver reads for one line. The user's is "You"; the
    /// supervisor's always names the supervisor and is never read as the user's.
    public static func accessibilityLabel(_ m: SupervisorChatMessage, reportTab: String?) -> String {
        guard m.isReply else { return "You: \(m.text)" }
        if m.isReport { return "Supervisor report\(reportTab.map { " on \($0)" } ?? ""), not from you: \(m.text)" }
        return "Supervisor reply, not from you: \(m.text)"
    }

    /// The feed says which conversation line moved; the app re-reads the token-gated GET.
    public static func needsReload(after event: SupervisorFeedEvent) -> Bool {
        if case .message = event { return true }
        return false
    }

    // MARK: - [7.3] Following and reporting

    /// The follow chips: open follows, oldest first, as the server lists them.
    public static func openFollows(_ follows: [SupervisorFollow]) -> [SupervisorFollow] {
        follows.filter(\.isOpen)
    }

    /// "Following fix-flags · until merged" — what the chip says it waits for.
    public static func followLabel(_ f: SupervisorFollow) -> String {
        let tab = f.tabTitle?.isEmpty == false ? f.tabTitle! : String(f.sessionId.prefix(8))
        return "Following \(tab) · \(f.until == "merge-ready" ? "until it is ready to merge" : "until its scope is met")"
    }

    /// The tab a report is about, by its follow; nil for any other reply.
    public static func reportTab(_ m: SupervisorChatMessage, follows: [SupervisorFollow]) -> String? {
        guard m.isReport, let fid = m.origin?.followId, let f = follows.first(where: { $0.id == fid }) else { return nil }
        return f.tabTitle?.isEmpty == false ? f.tabTitle : String(f.sessionId.prefix(8))
    }

    /// Where a ref goes. Only kinds the server resolves; anything else draws nothing.
    public enum RefTarget: Equatable, Sendable {
        case tab(String)
        case item(String)
        case ledger(String)
    }

    public static func refTarget(_ r: SupervisorChatMessage.Ref) -> RefTarget? {
        switch r.kind {
        case "tab": return .tab(r.id)
        case "item": return .item(r.id)
        case "ledger": return .ledger(r.id)
        default: return nil
        }
    }

    /// The SF Symbol a ref's link carries.
    public static func refSymbol(_ r: SupervisorChatMessage.Ref) -> String {
        switch r.kind {
        case "tab": return "rectangle.on.rectangle"
        case "item": return "tray"
        default: return "list.bullet.rectangle"
        }
    }

    /// Brief §12.2 — a reply is Markdown with no actionable element (ADR-0128 §3):
    /// every link run is removed and the URL stays visible as inert text.
    public static func neutralisedReply(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
        var linked: [(Range<AttributedString.Index>, URL)] = []
        for run in a.runs { if let url = run.link { linked.append((run.range, url)) } }
        // Back to front, so earlier ranges stay valid as text is inserted after them.
        for (range, url) in linked.reversed() {
            a[range].link = nil
            let shown = String(a[range].characters)
            if shown != url.absoluteString { a.characters.insert(contentsOf: " (\(url.absoluteString))", at: range.upperBound) }
        }
        return a
    }
}

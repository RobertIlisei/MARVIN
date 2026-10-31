import Foundation

// ADR-0128 / plan [7.1] — the Supervisor tab's decisions, as values the
// MARVINTests runner can assert (ADR-0114: decisions in MARVINLogic, drawing
// in MARVIN). Brief §12.

/// One line of `GET /api/supervisor/message`.
public struct SupervisorChatMessage: Decodable, Equatable, Identifiable, Sendable {
    public struct Origin: Decodable, Equatable, Sendable {
        public let messageIds: [String]
        public init(messageIds: [String]) { self.messageIds = messageIds }
    }
    public let id: String
    public let at: String
    /// `user` or `supervisor`.
    public let from: String
    public let text: String
    /// A reply's wake and the user messages it answers.
    public let wakeId: String?
    public let origin: Origin?
    /// [7.2] — the inbox items this reply's wake raised for its messages (server-filtered): the cards under it.
    public let items: [String]?

    public init(id: String, at: String, from: String, text: String, wakeId: String? = nil, origin: Origin? = nil, items: [String]? = nil) {
        self.id = id; self.at = at; self.from = from; self.text = text; self.wakeId = wakeId; self.origin = origin; self.items = items
    }

    public var isReply: Bool { from == "supervisor" }
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

    /// The feed says which conversation line moved; the app re-reads the token-gated GET.
    public static func needsReload(after event: SupervisorFeedEvent) -> Bool {
        if case .message = event { return true }
        return false
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

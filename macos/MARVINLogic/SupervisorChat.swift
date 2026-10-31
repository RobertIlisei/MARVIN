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

    public init(id: String, at: String, from: String, text: String, wakeId: String? = nil, origin: Origin? = nil) {
        self.id = id; self.at = at; self.from = from; self.text = text; self.wakeId = wakeId; self.origin = origin
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

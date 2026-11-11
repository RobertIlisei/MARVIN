// ProjectNotices — the wire type and the pure rules behind "Tell every tab…"
// (ADR-0131). A notice is a short dated fact every tab in the project carries
// in its next turns; the sidecar validates it, this file only mirrors the
// limits so the sheet can say "too long" before a round trip, and words the
// time left.

import Foundation

/// One live notice of `GET /api/notices`.
public struct ProjectNotice: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public let createdAt: String
    public let expiresAt: String
    /// `user` or `supervisor`.
    public let author: String
    public init(id: String, text: String, createdAt: String, expiresAt: String, author: String) {
        self.id = id; self.text = text; self.createdAt = createdAt; self.expiresAt = expiresAt; self.author = author
    }
}

public struct ProjectNoticeList: Decodable, Equatable, Sendable {
    public let notices: [ProjectNotice]
}

/// How long a notice the user posts lives. The server allows up to seven days.
public enum ProjectNoticeLifetime: Int, CaseIterable, Identifiable, Sendable {
    case hour = 1
    case day = 24
    case week = 168

    public var id: Int { rawValue }
    public var hours: Int { rawValue }
    public var label: String {
        switch self {
        case .hour: return "1 hour"
        case .day: return "24 hours"
        case .week: return "7 days"
        }
    }
}

public enum ProjectNotices {
    /// The server's limit (`MAX_NOTICE_CHARS`).
    public static let maxChars = 400

    /// The text the sheet may post, trimmed with line breaks folded to spaces;
    /// nil when it may not (empty, or over the limit).
    public static func postable(_ raw: String) -> String? {
        let t = raw.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return t.isEmpty || t.count > maxChars ? nil : t
    }

    public static func decodeList(_ data: Data) -> [ProjectNotice]? {
        try? JSONDecoder().decode(ProjectNoticeList.self, from: data).notices
    }

    public static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// "23 h left", "42 min left", "expired"; the largest whole unit.
    public static func remaining(_ notice: ProjectNotice, now: Date) -> String {
        guard let end = date(notice.expiresAt) else { return "" }
        let secs = end.timeIntervalSince(now)
        if secs <= 0 { return "expired" }
        if secs >= 86_400 { return "\(Int(secs / 86_400)) d left" }
        if secs >= 3_600 { return "\(Int(secs / 3_600)) h left" }
        return "\(max(1, Int(secs / 60))) min left"
    }

    /// "You" or "Supervisor" — who posted it.
    public static func authorLabel(_ notice: ProjectNotice) -> String {
        notice.author == "supervisor" ? "Supervisor" : "You"
    }
}

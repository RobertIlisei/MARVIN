// BacklogItem — one parked item of the project backlog (ADR-0044).
//
// Lives in MARVINLogic, not next to `BacklogService`, so the browsing rules
// (search, filter, sort, group, row text, which action is primary) are pure
// functions over the same value the window shows, and MARVINTests can assert
// them. The wire shape is the sidecar's `/api/backlog` row; nothing here
// changes it.

import Foundation

public struct BacklogItem: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    /// provisional | open | doing | done | dismissed — `var` so a row updates in place.
    public var status: String
    /// low | med | high
    public let severity: String
    public let created: String
    /// ADR-0064 — what sort of work this is. Optional in the wire shape so the
    /// 430 items written before the field existed still decode.
    public let kind: String?
    /// Waiting on something outside the repo. Orthogonal to status and kind.
    public let blocked: Bool?
    public let blockedOn: String?
    /// ADR-0113 — who holds the item while it is `doing`.
    public let claimedBy: String?
    public let claimedBranch: String?

    public init(
        id: String, title: String, body: String, status: String, severity: String, created: String,
        kind: String? = nil, blocked: Bool? = nil, blockedOn: String? = nil,
        claimedBy: String? = nil, claimedBranch: String? = nil
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.status = status
        self.severity = severity
        self.created = created
        self.kind = kind
        self.blocked = blocked
        self.blockedOn = blockedOn
        self.claimedBy = claimedBy
        self.claimedBranch = claimedBranch
    }

    /// "tab: fix-the-thing" or "session 8cb24ed6" — nil when unclaimed.
    public var holderLabel: String? {
        guard let by = claimedBy, !by.isEmpty else { return nil }
        if let b = claimedBranch, !b.isEmpty {
            return "tab: " + (b.hasPrefix("marvin/tab/") ? String(b.dropFirst("marvin/tab/".count)) : b)
        }
        return "session \(by.prefix(8))"
    }

    /// Never nil at the call site — an absent kind means "unspecified", which
    /// is a real value, not a missing one.
    public var kindOrUnspecified: String { kind ?? "unspecified" }
    public var isBlocked: Bool { blocked ?? false }
}

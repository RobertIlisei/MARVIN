// PermissionStrategyChoice — the three permission postures, and the decisions
// about them that can be asserted (ADR-0115).
//
// MARVIN had two: `gated`, which confirms every edit and unsafe command, and
// `auto`, whose docstring promised it behaved "like Claude Code with
// --dangerously-skip-permissions". That promise had quietly stopped being
// true: since ADR-0015 the auto path accumulated four confirm-raising rules —
// a lane gate, a shared-checkout git gate, worktree containment, and metered
// CI — so a user in auto still met a dialog on the shapes they cared about
// most.
//
// `full` is the posture that promise described. It waives the three
// CONTAINMENT confirms and keeps two things, decided with the user on
// 2026-09-11: anything that spends CI minutes, because that is the only
// confirm that costs money, and the hard-deny floor, because "a subagent may
// never write" is an invariant the rest of MARVIN is built on rather than a
// preference.

import Foundation

public enum PermissionStrategyChoice: String, CaseIterable, Sendable {
    case gated
    case auto
    case full

    /// Unknown input resolves to the SAFEST posture, never the most permissive.
    /// A stale default, a hand-edited plist or an older sidecar must not be
    /// able to widen permissions by accident.
    public static func parse(_ raw: String) -> PermissionStrategyChoice {
        PermissionStrategyChoice(rawValue: raw) ?? .gated
    }

    /// What the pill reads.
    public var label: String {
        switch self {
        case .gated: return "gated"
        case .auto: return "auto"
        case .full: return "full auto"
        }
    }

    /// Cycling forward walks toward MORE autonomy and wraps at the end, so the
    /// dangerous posture is never one stray click away from the safest one.
    public var next: PermissionStrategyChoice {
        switch self {
        case .gated: return .auto
        case .auto: return .full
        case .full: return .gated
        }
    }

    /// True when this posture waives the containment confirms.
    public var skipsContainmentConfirms: Bool { self == .full }

    public var help: String {
        switch self {
        case .gated:
            return "Permissions: gated — every Edit, Write and unsafe shell command asks first. Click for auto."
        case .auto:
            return "Permissions: auto — tool calls run, with an audit entry each; MARVIN still asks before leaving its own worktree or spending CI minutes. Click for full auto."
        case .full:
            return "Permissions: FULL AUTO — nothing asks except a question from MARVIN itself and anything that spends CI minutes. An isolated tab will edit your shared checkout without asking. Click for gated."
        }
    }
}

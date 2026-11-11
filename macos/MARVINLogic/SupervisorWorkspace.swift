// SupervisorWorkspace — the Supervisor workspace's decisions as values
// (design brief §13). The workspace is layout only: it re-hosts the
// conversation, the settings block and the log, and adds no act, verb or
// policy. What is decided here is what each host shows, so the decisions are
// pinned by assertions rather than by renders (ADR-0114).

import Foundation

// MARK: - The inspector (§13.6)

/// The right column's segments. There is deliberately no *Needs you* segment:
/// the Sessions pane is the one inbox list (brief discovery answer 1, ADR-0112).
public enum SupervisorInspectorSegment: String, CaseIterable, Sendable {
    case tabs, queue, log, settings

    public var title: String {
        switch self {
        case .tabs: return "Tabs"
        case .queue: return "Queue"
        case .log: return "Log"
        case .settings: return "Settings"
        }
    }

    /// Tabs is the default; Settings never is — the autonomy switches sit one
    /// deliberate step from a fluent reply (§13.6, brief §1). A stored value
    /// that is not a segment, or is Settings, reads as Tabs.
    public static func restored(_ raw: String?) -> SupervisorInspectorSegment {
        guard let raw, let s = SupervisorInspectorSegment(rawValue: raw), s != .settings else { return .tabs }
        return s
    }
}

// MARK: - Where the workspace draws (§13.2, §13.9)

public enum SupervisorWorkspace {
    /// The right column (Brain + chat) is covered only while the supervisor is
    /// enabled. Off, the workspace is the centre's set-up form and the right
    /// column stays the selected tab's: there is no supervisor to describe.
    public static func coversRightColumn(open: Bool, mode: String?) -> Bool {
        open && SupervisorChat.tabVisible(mode: mode)
    }

    /// §13.8 — disabling the supervisor while the workspace is open closes it;
    /// it does not swap to the set-up form.
    /// The header's mode text. The strip's " · N waiting" is dropped: the
    /// header's "N for you" chip already says it (§13.3).
    public static func headerMode(_ strip: SupervisorStrip) -> String {
        strip.modeLabel.components(separatedBy: " · ").filter { !$0.hasSuffix(" waiting") }.joined(separator: " · ")
    }

    public static func staysOpen(after old: String?, _ new: String?) -> Bool {
        !(SupervisorChat.tabVisible(mode: old) && !SupervisorChat.tabVisible(mode: new))
    }
}

// MARK: - The Sessions pane's one line (§13.7)

public struct SupervisorPaneLine: Equatable, Sendable {
    public enum Chip: Equatable, Sendable {
        case kill
        case resume(enabled: Bool)
    }

    /// SF Symbol for the leading glyph; nil = the binoculars mark (or the
    /// spinner when `showsProgress`).
    public let glyph: String?
    public let showsProgress: Bool
    public let tone: SupervisorStrip.Tone
    /// One short word from a fixed list, or nil when a chip or the meter says it.
    public let word: String?
    /// From 80 % of the cap the meter replaces the word.
    public let meter: SupervisorStrip.Meter?
    public let chip: Chip?
    public let showsPause: Bool
    /// The full state sentence — the line's help text and VoiceOver value.
    public let sentence: String

    /// The fixed vocabulary. Each fits beside the title, Pause and the chevron at 260 pt.
    public static let words = ["Shadow", "Autonomous", "At daily cap", "Paused", "Wake failed",
                               "Not waking", "Reconnecting", "No control"]

    /// nil while the supervisor is off: the pane keeps §6.7's off line instead.
    public static func make(_ strip: SupervisorStrip) -> SupervisorPaneLine? {
        let near = strip.meter?.level == "near"
        func line(_ word: String?, chip: Chip? = nil, pause: Bool = true, meterReplaces: Bool = false) -> SupervisorPaneLine {
            SupervisorPaneLine(glyph: strip.glyph, showsProgress: strip.showsProgress, tone: strip.tone,
                               word: meterReplaces && near ? nil : word,
                               meter: meterReplaces && near ? strip.meter : nil,
                               chip: chip, showsPause: pause && strip.controlsEnabled,
                               sentence: strip.accessibilityValue)
        }
        switch strip.state {
        case .off: return nil
        case .shadow: return line("Shadow", meterReplaces: true)
        case .autonomous: return line("Autonomous", meterReplaces: true)
        // A chip carries the state; with the word too it truncated at 260 pt.
        case .waking: return line(nil, chip: .kill)
        case .pausedByUser, .killed, .pausedByFault:
            if case .resume(let enabled) = strip.primary { return line(nil, chip: .resume(enabled: enabled), pause: false) }
            return line("Paused", pause: false)
        case .overBudget: return line("At daily cap", pause: false)
        case .failed: return line("Wake failed")
        case .stale: return line("Not waking")
        case .disconnected: return line("Reconnecting")
        case .tokenUnavailable: return line("No control", pause: false)
        }
    }
}

// MARK: - The supervisor Brain (§13.5)

/// What the re-targeted orb shows. Existing `BrainState` profiles only: no
/// "still" profile — a paused supervisor is drawn idle through the Reduce
/// Motion path (advisor condition 16).
public struct SupervisorBrainFace: Equatable, Sendable {
    public enum Profile: String, Equatable, Sendable { case idle, thinking, error }

    public let profile: Profile
    /// Drawn through the Reduce Motion path: paused, killed, at the cap, unknown.
    public let still: Bool
    /// Caption line 2.
    public let state: String
    /// SF Symbol beside line 2, for any state that is not neutral.
    public let glyph: String?
    public let tone: SupervisorStrip.Tone
    /// Caption line 3, one line, tail-truncated.
    public let summary: String
    public let accessibilityValue: String

    /// `openTabs` is the number of open tabs ("watching 4 of 6"); `following`
    /// the titles of open follows.
    public static func make(strip: SupervisorStrip, status: SupervisorStatus?, openTabs: Int?,
                            following: [String], now: Date, timeZone: TimeZone = .current) -> SupervisorBrainFace {
        let watched = status?.watchedTabs ?? 0
        var normal: [String] = []
        if let openTabs, openTabs >= watched { normal.append("watching \(watched) of \(openTabs)") }
        else { normal.append("watching \(watched)") }
        // "woke" before "following": a follow's tab title is long, and the line
        // truncates from the tail (critique, polish).
        if let at = status?.lastWake?.at.flatMap(SessionLedger.parseISO) {
            normal.append("woke " + SupervisorStrip.Format(now: now, timeZone: timeZone).ago(at))
        }
        if !following.isEmpty { normal.append("following " + following.joined(separator: ", ")) }
        let normalSummary = normal.joined(separator: " · ")

        func face(_ p: Profile, _ state: String, still: Bool = false, summary: String? = nil) -> SupervisorBrainFace {
            let s = summary ?? normalSummary
            return SupervisorBrainFace(profile: p, still: still, state: state, glyph: strip.showsProgress ? nil : strip.glyph,
                                       tone: strip.tone, summary: s,
                                       accessibilityValue: [state.replacingOccurrences(of: " · ", with: ", ") + ".",
                                                            s.isEmpty ? "" : s.replacingOccurrences(of: " · ", with: ". ") + "."]
                                           .filter { !$0.isEmpty }.joined(separator: " "))
        }
        switch strip.state {
        case .off, .shadow: return face(.idle, "idle")
        case .autonomous:
            let on = status?.autonomousCategories ?? []
            let lead = on.isEmpty ? [] : ["autonomous: " + on.joined(separator: ", ")]
            return face(.idle, "idle", summary: (lead + normal).joined(separator: " · "))
        case .waking: return face(.thinking, strip.modeLabel.lowercased())
        case .pausedByUser: return face(.idle, "paused", still: true, summary: strip.detail)
        case .killed: return face(.idle, "paused · wake aborted", still: true, summary: strip.detail)
        case .overBudget: return face(.idle, "paused · daily cap", still: true, summary: strip.detail)
        case .pausedByFault: return face(.idle, strip.modeLabel.lowercased().replacingOccurrences(of: " — ", with: " · "),
                                          still: true, summary: strip.detail)
        case .failed: return face(.error, "wake failed", summary: strip.failure?.headline ?? strip.detail)
        case .stale: return face(.idle, "not waking", summary: strip.detail)
        case .disconnected: return face(.idle, "unknown", still: true, summary: "reconnecting…")
        case .tokenUnavailable: return face(.idle, "unknown", still: true, summary: "MARVIN can't read the supervisor token")
        }
    }
}

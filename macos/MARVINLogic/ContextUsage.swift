// ContextUsage — pure helpers for the AppStatusBar context-pressure
// segment (ADR-0022 §2). Two responsibilities:
//
//   1. Parse the `usage` block from a Claude CLI `cli.event` payload
//      and compute the resident-context-token count = bytes the model
//      walks every turn = `cache_read_input_tokens + input_tokens`.
//      `cache_creation_input_tokens` is *not* added — those are
//      tokens being WRITTEN to cache for the next turn, not bytes the
//      model walked this turn, so summing them double-counts on
//      re-cache turns.
//
//   2. Classify a token count into one of four bands for the colour
//      ramp. Bands are tuned for Sonnet 4.x's 200K window and the
//      user's reported pain point at ~145K (ADR-0022 §2):
//
//        < 40K  → healthy   (tertiary text)
//        < 80K  → climbing  (secondary text)
//        < 140K → high      (orange)
//        ≥ 140K → critical  (red)
//
// Both helpers are pure functions so they pin cleanly in unit tests
// without standing up a full chat session.

import Foundation

/// Resident-context band for the colour ramp. Stable enum values so
/// the AppStatusBar can switch on the case without re-reading the
/// thresholds.
public enum ContextBand: Sendable {
    case healthy
    case climbing
    case high
    case critical

    /// Hint copy shown on hover. Kept here so the band → text
    /// mapping is single-source-of-truth.
    public var hint: String {
        switch self {
        case .healthy: return "Context healthy"
        case .climbing: return "Climbing — long sessions slow"
        case .high: return "High — decisions getting slow"
        case .critical: return "Approaching limit — start a new session"
        }
    }
}

public enum ContextUsageReader {
    /// Classify a resident-context-token count into one of four bands.
    /// Boundaries are inclusive on the upper side: 39_999 is healthy,
    /// 40_000 is climbing, etc. Pinned by `context-band` test.
    public static func band(forTokens tokens: Int) -> ContextBand {
        if tokens < 40_000 { return .healthy }
        if tokens < 80_000 { return .climbing }
        if tokens < 140_000 { return .high }
        return .critical
    }

    /// Read the `usage` block from a cli.event payload and return
    /// `(resident, billable)` token counts. `resident` drives the
    /// status-bar colour ramp; `billable` is shown in the hover
    /// tooltip as the "new this turn" figure (cache_creation +
    /// input — the bytes that will actually bill).
    ///
    /// Returns `(nil, nil)` when the payload is not an assistant
    /// event with `usage`. Pinned by `context-tokens` test.
    public static func read(
        cliEventData data: Data
    ) -> (resident: Int?, billable: Int?) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String,
              type == "assistant",
              let message = json["message"] as? [String: Any],
              let usage = message["usage"] as? [String: Any]
        else { return (nil, nil) }
        let cacheRead = usage["cache_read_input_tokens"] as? Int ?? 0
        let input = usage["input_tokens"] as? Int ?? 0
        let cacheCreation = usage["cache_creation_input_tokens"] as? Int ?? 0
        let resident = cacheRead + input
        let billable = cacheCreation + input
        // Treat all-zero as no signal yet (initial event before the
        // server reports usage).
        if resident == 0 && billable == 0 { return (nil, nil) }
        return (resident, billable)
    }
}

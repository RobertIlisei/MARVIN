// ContextUsageBridge — bridge wrapper around the pure
// `ContextUsageReader` (which lives in MARVINLogic so it can be
// unit-tested without an Xcode test target). The pure helper can't
// reach into MarvinBridge because that type is internal to the MARVIN
// executable target; this file keeps the thin glue inside MARVIN.

// ## Every write here is session-gated (2026-09-01)
//
// All three counters describe ONE session's SDK conversation, and all three
// used to be written ungated — directly below two lines in the same handler
// that ARE gated (`setMarvinState` / `setBusy`). A turn that is not on screen
// still streams, so whichever session wrote last owned the status bar: the
// `ctx` figure, the `graph N · reads M` chip and the subagent ledger could all
// describe a different session from the transcript underneath them. That is
// what "the 2 sessions are interconnected" looked like (user, 2026-09-01) —
// the conversations were separate the whole time; the chrome above them was
// not. `forSession` is not optional here on purpose: a counter with no session
// to attribute it to has nowhere correct to go.

import Foundation
import MARVINLogic

extension ContextUsageReader {
    /// Read + push to the bridge in one call. The chat preview's
    /// cli.event handler invokes this so the AppStatusBar segment
    /// updates live without the chat layer having to know the
    /// bridge field names. ADR-0022 §2.
    @MainActor
    static func applyTo(bridge: MarvinBridge, cliEventData data: Data, forSession sessionId: String?) {
        guard bridge.acceptsSessionCounters(from: sessionId) else { return }
        // The SDK's own number, when the event carries it (result events).
        if let w = reportedContextWindow(cliEventData: data) { bridge.reportedContextWindow = w }
        let parsed = read(cliEventData: data)
        if let r = parsed.resident { bridge.residentContextTokens = r }
        if let b = parsed.billable { bridge.billableThisTurn = b }
    }
}

extension ToolUseCounter {
    /// Parse + push to the bridge in one call. Increments the per-session
    /// counts the AppStatusBar's "graph N · reads M" chip reads.
    /// 2026-05-27 graphify-drift audit.
    @MainActor
    static func applyTo(bridge: MarvinBridge, cliEventData data: Data, forSession sessionId: String?) {
        guard bridge.acceptsSessionCounters(from: sessionId) else { return }
        let delta = deltaForCliEvent(data)
        if delta == ToolUseCounts() { return }
        bridge.sessionGraphCalls += delta.graphCalls
        bridge.sessionFileReadCalls += delta.fileReadCalls
        bridge.sessionGraphSummaryCalls += delta.graphSummaryCalls
    }
}

extension SubagentLedger {
    /// Feed the live event stream into the bridge's ledger — what the
    /// "SUBAGENTS THIS SESSION" popover reads.
    ///
    /// This glue was missing (2026-08-30). `SubagentLedger.apply` was called
    /// ONLY from the transcript-replay path, so the popover showed whatever
    /// was reconstructed when a session was loaded from disk and nothing
    /// dispatched during the live turn — a graphify update fanning out five
    /// `graph-extractor` chunks registered as zero. Sitting beside its two
    /// siblings here is the point: the live handler calls all three together,
    /// so the next reader of that block sees the ledger is fed.
    @MainActor
    static func applyTo(bridge: MarvinBridge, cliEventData data: Data, forSession sessionId: String?) {
        guard bridge.acceptsSessionCounters(from: sessionId) else { return }
        bridge.subagents.apply(cliEventData: data)
    }
}

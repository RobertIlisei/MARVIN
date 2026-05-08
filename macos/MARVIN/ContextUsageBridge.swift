// ContextUsageBridge — bridge wrapper around the pure
// `ContextUsageReader` (which lives in MARVINLogic so it can be
// unit-tested without an Xcode test target). The pure helper can't
// reach into MarvinBridge because that type is internal to the MARVIN
// executable target; this file keeps the thin glue inside MARVIN.

import Foundation
import MARVINLogic

extension ContextUsageReader {
    /// Read + push to the bridge in one call. The chat preview's
    /// cli.event handler invokes this so the AppStatusBar segment
    /// updates live without the chat layer having to know the
    /// bridge field names. ADR-0022 §2.
    @MainActor
    static func applyTo(bridge: MarvinBridge, cliEventData data: Data) {
        let parsed = read(cliEventData: data)
        if let r = parsed.resident { bridge.residentContextTokens = r }
        if let b = parsed.billable { bridge.billableThisTurn = b }
    }
}

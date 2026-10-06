// ServerRefusalText — the words a tab shows when the sidecar refuses a turn
// before it starts (ADR-0122).
//
// A refused first message arrives as a non-2xx response whose body is JSON
// `{ "error": "worktree could not be created: …", "code": "worktree-failed" }`.
// The chat view used to print the thrown Swift error — `httpStatus(409, body:
// Optional("{\"error\":…"))` — which hid the one sentence the user needs (the
// disk is full) inside an enum dump. Pure, so the extraction is asserted.

import Foundation

public enum ServerRefusalText {
    /// The refusal's own sentence (plus its hint) when `body` is a
    /// `worktree-failed` response, else nil — every other failure keeps the
    /// text it always had.
    public static func worktreeFailure(fromBody body: String?) -> String? {
        guard let data = body?.data(using: .utf8),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              json["code"] as? String == "worktree-failed",
              let error = json["error"] as? String, !error.isEmpty
        else { return nil }
        if let hint = json["hint"] as? String, !hint.isEmpty { return "\(error)\n\(hint)" }
        return error
    }
}

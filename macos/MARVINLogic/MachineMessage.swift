// MachineMessage — a user-role transcript line the person did not write
// (UX review R2-09).
//
// A finished background job and a scheduled wakeup are delivered to the model
// as USER turns, so the transcript drew them in the user's bubble with the
// label "you". Scrolling a tab back, the owner could not tell what he said
// from what the system said. The sidecar's own wording is the contract
// (`background-jobs.ts`, `turn-orchestrator.ts`):
//
//   [scheduled wakeup — <reason>]\n\n<prompt>
//
// `<reason>` is "background job done: <label>" / "background job stopped: …" /
// "background job interrupted: …" or the model's own wakeup reason. Only these
// are classified; text the person typed (including "[queued …]" messages,
// which are theirs) never is.

import Foundation

public struct MachineMessage: Equatable, Sendable {
    /// "system · job finished" — in place of "you".
    public let label: String
    /// One line: "gated docs commit · exit code 0".
    public let headline: String
    /// The full text, for the expand.
    public let detail: String

    private static let wakeupPrefix = "[scheduled wakeup"
    private static let bareJob = "A background job you started earlier"

    public static func classify(_ text: String) -> MachineMessage? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix(wakeupPrefix) {
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            let header = trimmed[trimmed.index(trimmed.startIndex, offsetBy: wakeupPrefix.count)..<close]
            var reason = header.trimmingCharacters(in: .whitespaces)
            if reason.hasPrefix("\u{2014}") { reason = String(reason.dropFirst()).trimmingCharacters(in: .whitespaces) }
            let body = String(trimmed[trimmed.index(after: close)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if let name = after("background job done:", in: reason) {
                return job(name: name, body: body, detail: trimmed)
            }
            if let name = after("background job stopped:", in: reason) {
                return MachineMessage(label: "system \u{B7} job stopped", headline: name, detail: trimmed)
            }
            if let name = after("background job interrupted:", in: reason) {
                return MachineMessage(label: "system \u{B7} job cut off", headline: name, detail: trimmed)
            }
            return MachineMessage(label: "system \u{B7} wakeup", headline: reason, detail: trimmed)
        }
        if trimmed.hasPrefix(bareJob) {
            if trimmed.hasPrefix(bareJob + " was stopped") {
                return MachineMessage(label: "system \u{B7} job stopped", headline: result(in: trimmed) ?? "stopped", detail: trimmed)
            }
            if trimmed.hasPrefix(bareJob + " was cut off") {
                return MachineMessage(label: "system \u{B7} job cut off", headline: "cut off by a restart", detail: trimmed)
            }
            return job(name: nil, body: trimmed, detail: trimmed)
        }
        return nil
    }

    private static func job(name: String?, body: String, detail: String) -> MachineMessage {
        let result = result(in: body)
        let failed = body.contains("did NOT succeed") || (result.map { $0 != "exit code 0" } ?? false)
        let headline = [name, result].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{B7} ")
        return MachineMessage(
            label: failed ? "system \u{B7} job failed" : "system \u{B7} job finished",
            headline: headline.isEmpty ? "background job" : headline,
            detail: detail
        )
    }

    private static func after(_ prefix: String, in reason: String) -> String? {
        reason.hasPrefix(prefix) ? String(reason.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces) : nil
    }

    /// The `Result:` line of a job report, first line only.
    private static func result(in body: String) -> String? {
        for line in body.split(whereSeparator: \.isNewline) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("Result:") {
                let value = String(l.dropFirst("Result:".count)).trimmingCharacters(in: .whitespaces)
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }
}

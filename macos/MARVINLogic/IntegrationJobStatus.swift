// IntegrationJobStatus — the one line the Source Control panel shows while an
// integration is running (ADR-0109, amended 2026-09-11).
//
// Prepare MR squashes N branches, makes one commit under the project's own
// commit hooks, and pushes. On a real project that is minutes, and the panel
// used to render nothing at all for it: the sheet closed, two buttons dimmed,
// and the user asked "how do I know it's working or not?".
//
// The phrasing rules, all learned from that:
//   - Name the PHASE, not the operation. "Prepare MR running" says nothing;
//     "Committing — running the project's commit hooks" says why it is slow.
//   - Count what can be counted. "Squashing 3 of 6" is progress; a spinner
//     is not.
//   - Always carry elapsed time. It is the only thing that distinguishes
//     "working" from "wedged", and it is what the user reads first.
//
// Pure logic, no AppKit — testable from MARVINTests.

import Foundation

public enum IntegrationJobStatus {
    /// Phases the sidecar reports. Unknown strings degrade to a plain
    /// "Working" rather than an empty line, so an older client never goes
    /// silent against a newer sidecar.
    public static func line(
        kind: String,
        phase: String,
        current: String?,
        done: Int,
        total: Int,
        elapsedMs: Int
    ) -> String {
        let elapsed = DurationFormat.humanize(ms: elapsedMs)
        let subject = (current?.isEmpty ?? true) ? nil : current
        let counted = total > 0 ? "\(min(done + 1, total)) of \(total)" : nil

        var head: String
        switch phase {
        case "preparing":
            head = kind == "merge-all" ? "Preparing" : "Cutting the integration branch"
        case "squashing":
            head = counted.map { "Squashing \($0)" } ?? "Squashing"
        case "merging":
            head = counted.map { "Merging \($0)" } ?? "Merging"
        case "committing":
            // The slowest phase on every real project, and the one that looks
            // most like a hang. Say what is actually running.
            head = "Committing — running the project's commit hooks"
        case "pushing":
            head = subject.map { "Pushing to \($0)" } ?? "Pushing"
        default:
            head = "Working"
        }

        // The subject is the branch being folded; "pushing" already spent it
        // on the remote's name.
        if let subject, phase == "squashing" || phase == "merging" {
            head += " · \(subject)"
        }
        return "\(head) · \(elapsed)"
    }

    /// What the panel says once a run has ended and the client never saw the
    /// reply (it timed out, or the app was relaunched mid-run).
    public static func finishedNotice(ok: Bool, summary: String) -> String {
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return ok ? "Integration finished." : "Integration failed." }
        return trimmed
    }
}

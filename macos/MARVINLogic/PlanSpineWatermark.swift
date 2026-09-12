// PlanSpineWatermark — ADR-0116. Which of two statements about a plan's
// progress is the later one.
//
// Hydration has two sources for step statuses: the stored spine, and the last
// `TodoWrite` in the replayed transcript tail. ADR-0052 made the spine win
// unconditionally, on the reasoning that the tail loses a plan presented hours
// ago. That is right about plan STRUCTURE and wrong about progress the moment
// the spine is the older of the two — and it was, for a whole session:
// the spine only ever advanced when a client was watching, so every step
// finished by a scheduled-wakeup turn was thrown away on the next hydrate by
// the very assignment meant to protect it (the plan read 8/14 with all
// fourteen steps shipped).
//
// Since ADR-0116 the sidecar projects each joinable batch into the spine and
// stamps `lastTodoAt` with that turn's end. So the two sources can be ordered
// instead of ranked: structure still comes from the spine, and the replayed
// batch is layered on top only when it is provably newer than what the server
// has already seen.
//
// Lives in MARVINLogic (no SwiftUI) so `swift run MARVINTests` can pin it.

import Foundation

public enum PlanSpineWatermark {
    /// Should a replayed `TodoWrite` be applied over the stored spine?
    ///
    /// Only on PROOF that it is newer. Both stamps are ISO-8601 UTC strings of
    /// the same shape, so a lexicographic compare orders them.
    ///
    /// A spine with no watermark is one no server has projected yet — a
    /// session that predates this ADR, or one whose batches were never
    /// joinable. Saying "apply the replay" there would re-introduce exactly the
    /// ADR-0052 regression on every legacy session, on no evidence at all, so
    /// the absent case keeps the old behaviour and the spine stands. The
    /// watermark appears on the first batch the server can join.
    public static func replayIsNewer(replayAt: String?, spineAt: String?) -> Bool {
        guard let spineAt, !spineAt.isEmpty else { return false }
        guard let replayAt, !replayAt.isEmpty else { return false }
        return replayAt > spineAt
    }
}

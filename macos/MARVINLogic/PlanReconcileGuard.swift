// PlanReconcileGuard — ADR-0052. Pure logic guarding ADR-0049's ordinal
// join against RE-BASED TodoWrite batches.
//
// The `[N]` tag joins a TodoWrite item to plan step N by ordinal alone —
// there is no plan identity in the tag. In production (2026-07-02) the
// model, after user interruptions, repeatedly re-based its numbering to
// whatever list it was currently thinking about (`[19] …` one turn,
// `[1]…[18]` for eighteen micro-tasks the next). Reconciling those against
// the ACTIVE plan silently overwrote steps 1..N's statuses with unrelated
// work — plan corruption with no visible error.
//
// The guard is batch-level and conservative: it only fires when the batch
// LOOKS like a self-contained re-based list (several items, tags exactly
// 1..K consecutive, K different from the plan's step count) AND the tagged
// texts overwhelmingly fail to match the steps they address. Legitimate
// updates — partial lists, rewordings of the right steps, sub-task tags —
// never trip it. When it fires, callers strip the tags and route the batch
// through the ADR-0046 content backstop (match → update, else nest), so
// the work is still captured without corrupting step statuses.
//
// Lives in MARVINLogic (no SwiftUI) so `swift run MARVINTests` can pin it.

import Foundation

public enum PlanTextMatch {
    /// Lowercase, fold every non-alphanumeric run to a single space, trim.
    /// The canonical form used for `PlanStep.id` and all content matching.
    public static func normalize(_ s: String) -> String {
        var out = ""
        var lastSpace = false
        for scalar in s.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                out.unicodeScalars.append(scalar)
                lastSpace = false
            } else if !lastSpace {
                out.append(" ")
                lastSpace = true
            }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// Exact equality, or containment when both sides are long enough that
    /// the containment isn't accidental.
    public static func matches(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        guard a.count >= 6, b.count >= 6 else { return false }
        return a.contains(b) || b.contains(a)
    }

    /// How much identical leading text two sub-tasks must share before we treat
    /// a rewording as the SAME work (ADR-0068).
    ///
    /// 40 characters is deliberately conservative. Real plan items in this
    /// codebase diverge early when they are genuinely different
    /// ("Milestone 2: wire ActivityController…" vs "…wire TreatmentController…"
    /// share only 18), while a reworded restatement of one item keeps a long
    /// identical head ("Milestone A (sweep-side): zilier_entries + documents
    /// widened match, …" — 60+ before it diverges).
    public static let sameWorkPrefix = 40

    /// Do two normalised strings describe the same piece of work?
    ///
    /// `matches` (equality or containment) misses the case that actually
    /// corrupted a real plan: the model restating a sub-task in fewer words, so
    /// neither string contains the other. Measured on
    /// `grouped-backlog-fix-pass.md` — 24 duplicated bullets, all of this shape.
    ///
    /// Prefix agreement is only trusted when BOTH strings are longer than the
    /// threshold; otherwise a short generic opener ("run make fast…") could
    /// swallow unrelated items.
    public static func sameWork(_ a: String, _ b: String) -> Bool {
        if matches(a, b) { return true }
        guard a.count > sameWorkPrefix, b.count > sameWorkPrefix else { return false }
        return a.prefix(sameWorkPrefix) == b.prefix(sameWorkPrefix)
    }
}

public enum PlanRebaseGuard {
    /// Minimum tagged items before the heuristic may fire — a one-off
    /// mis-tag is the per-item backstop's job, not a re-base.
    public static let minBatchSize = 3
    /// The batch is "unrelated" when at most this fraction of its tagged
    /// texts match the steps their ordinals address.
    public static let maxMatchFraction = 1.0 / 3.0

    /// Decide whether an incoming batch's top-level `[N]` tags should be
    /// DISTRUSTED (stripped, content-matched instead).
    ///
    /// - Parameters:
    ///   - taggedSteps: the parsed `[N]` ordinal of every top-level tagged
    ///     item, in batch order (sub-task `[N.M]` items excluded).
    ///   - taggedTexts: the tag-stripped content of those same items,
    ///     parallel to `taggedSteps`.
    ///   - stepIds: the active plan's step ids (normalized content), in order.
    /// - Returns: true when the batch looks re-based against a foreign list.
    public static func looksRebased(
        taggedSteps: [Int],
        taggedTexts: [String],
        stepIds: [String]
    ) -> Bool {
        guard taggedSteps.count == taggedTexts.count,
              taggedSteps.count >= minBatchSize,
              !stepIds.isEmpty else { return false }

        // Signature 1 — a self-contained list: tags are exactly 1..K.
        let sorted = taggedSteps.sorted()
        guard sorted == Array(1...taggedSteps.count) else { return false }

        // Signature 2 — the list's size disagrees with the plan's.
        // (K == step count is far more likely a legitimate full-plan
        // update that rewords steps; never guard that.)
        guard taggedSteps.count != stepIds.count else { return false }

        // Signature 3 — the texts don't match the steps they address.
        var matched = 0
        var addressed = 0
        for (i, step) in taggedSteps.enumerated() where step >= 1 && step <= stepIds.count {
            addressed += 1
            if PlanTextMatch.matches(stepIds[step - 1], PlanTextMatch.normalize(taggedTexts[i])) {
                matched += 1
            }
        }
        guard addressed > 0 else { return true }  // every tag out of range = foreign list
        return Double(matched) / Double(addressed) <= maxMatchFraction
    }
}

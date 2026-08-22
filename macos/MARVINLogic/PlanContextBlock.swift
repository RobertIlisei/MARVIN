import Foundation

/// Renders the active plan into the `<system-reminder>` block injected on every
/// turn (ADR-0051), with completed sub-tasks collapsed (ADR-0068 addendum).
///
/// ## Why this is its own type
///
/// It used to be a closure inside `ChatPreviewView`, which meant the single
/// most context-expensive string MARVIN produces had no test covering it. It
/// lives in MARVINLogic now for the same reason `FileTree` and `ChatMarkdown`
/// do: so its invariants are pinned by tests rather than by hoping.
///
/// ## Why completed sub-tasks are collapsed
///
/// Measured on a real plan (`Grouped backlog fix pass`, agri-saas-platform,
/// 2026-08-17): 20 steps, **336 sub-tasks, 61 % of them already completed**,
/// rendered in full into **every single turn** —
///
///     full block            36,694 chars   ~9,173 tokens/turn
///     completed collapsed   16,007 chars   ~4,001 tokens/turn
///
/// ~5,200 tokens per turn spent restating finished work. That pile is not
/// inert: it is what the model mis-read when it reported that a real plan
/// "never was" tracked and that genuine merged work had been "fabricated".
/// Completed items carry no information about what to do NEXT, which is the
/// only question this block exists to answer.
///
/// Nothing is lost — the plan file and the plan state keep every sub-task, and
/// the UI still shows them all. Only what the MODEL sees is condensed, and the
/// count is stated so "omitted" can never read as "not done".
public enum PlanContextBlock {
    /// A step must have more than this many completed sub-tasks before they are
    /// collapsed. Below it, showing them costs little and reads better than a
    /// summary line — collapsing "1 of 2 complete" is pure obfuscation.
    public static let collapseThreshold = 3

    public static func glyph(_ status: String) -> String {
        switch status {
        case "completed": return "[x]"
        case "in_progress": return "[~]"
        default: return "[ ]"
        }
    }

    /// Build the injected block, or nil when there is no plan worth injecting.
    ///
    /// - Parameter plan: the active plan.
    /// - Returns: the full `<system-reminder>` body.
    public static func render(plan: Plan) -> String? {
        guard !plan.steps.isEmpty else { return nil }

        // PROVENANCE (ADR-0068). Without id + path this block is an
        // unverifiable checklist: asked to check it, the model had to scan
        // `.marvin/plans/` (303 files on a real project), and a failed scan was
        // read as proof the plan never existed.
        let provenance = plan.path.map { " · source: \($0)" } ?? " · not yet written to disk"
        var lines = [
            "Active plan — \"\(plan.title)\" (id: \(plan.id))\(provenance) · current status "
                + "(authoritative; supersedes any earlier TodoWrite/tool statuses in this "
                + "transcript). You are mid-execution on this plan — continue it and keep its "
                + "checklist updated; a step is done only when all its sub-tasks are. "
                + "This block IS the plan of record: if it disagrees with what you can find on "
                + "disk, read the source file above before concluding anything about it. "
                + "Completed sub-tasks may be summarised as a count — a summarised item IS "
                + "done; do not redo it, and read the source file if you need its detail.",
        ]

        for (i, step) in plan.steps.enumerated() {
            lines.append("\(glyph(step.status)) \(i + 1). \(step.content)")

            let subs = step.subtasks
            let completed = subs.filter { $0.status == "completed" }.count
            let collapse = completed > collapseThreshold

            if collapse {
                lines.append(
                    "    [x] \(completed) of \(subs.count) sub-tasks complete"
                        + (completed == subs.count ? "" : " (completed ones omitted; the open ones follow)")
                )
            }

            for (j, sub) in subs.enumerated() {
                if collapse && sub.status == "completed" { continue }
                // NOTE: `j` is the ORIGINAL index. Renumbering after omission
                // would silently renumber the model's own reference points and
                // make the block disagree with the file it cites.
                lines.append("    \(glyph(sub.status)) \(i + 1).\(j + 1) \(sub.content)")
            }
        }
        return lines.joined(separator: "\n")
    }
}

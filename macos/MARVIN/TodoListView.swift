// TodoListView — ADR-0036. The live to-do checklist, Cursor / Claude-Code
// style. MARVIN's model emits a `TodoWrite` tool call (each call rewrites
// the WHOLE list with per-item status); we capture the latest from the
// turn's cli.event stream and render it as a checklist that ticks off as
// items move pending → in_progress → completed. Most visible in Plan mode
// (the plan's steps) but works in Agent mode too.

import SwiftUI

/// One checklist item, mirroring the `TodoWrite` tool input shape.
struct TodoItem: Equatable {
    let content: String
    /// "pending" | "in_progress" | "completed".
    let status: String
    /// Present-tense label the model uses while the item is active
    /// (e.g. "Wiring the gate"); shown in place of `content` when running.
    let activeForm: String?
    /// ADR-0049 — the stable join key parsed from a `[N.M]` tag (sub-task M of
    /// plan step N). nil for tier-1 items and untagged backstop matches. Lets a
    /// sub-task re-match its own row across successive `TodoWrite`s by key
    /// rather than by fuzzy content, so rephrasing never duplicates it.
    var key: String? = nil
}

/// ADR-0049 — parses the stable plan-step tag the executor prefixes onto each
/// `TodoWrite` item: `[N]` is plan step N (1-based), `[N.M]` is sub-task M of
/// step N. The tag is the *join key* that replaces ADR-0046's fuzzy content
/// matching — the model references a step by its ordinal, not by reproducing
/// its exact prose. Returns the parsed ordinals plus the content with the tag
/// stripped (so the tag never reaches the UI or the saved plan file).
enum PlanTag {
    private static let re = try? NSRegularExpression(pattern: #"^\s*\[(\d+)(?:\.(\d+))?\]\s*(.*)$"#)

    /// (step, sub, text). `step`/`sub` are nil when absent; `text` is the
    /// content with any leading tag removed (falls back to the original string
    /// when no tag is present).
    static func parse(_ s: String) -> (step: Int?, sub: Int?, text: String) {
        guard let re else { return (nil, nil, s) }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        guard let m = re.firstMatch(in: s, range: range),
              let rs = Range(m.range(at: 1), in: s),
              let rt = Range(m.range(at: 3), in: s) else { return (nil, nil, s) }
        let step = Int(s[rs])
        var sub: Int? = nil
        if m.range(at: 2).location != NSNotFound, let rm = Range(m.range(at: 2), in: s) {
            sub = Int(s[rm])
        }
        let text = String(s[rt]).trimmingCharacters(in: .whitespaces)
        return (step, sub, text.isEmpty ? s : text)
    }

    /// Strip a leading `[N]` / `[N.M]` tag from content for display. Tier-1
    /// items shouldn't carry tags, but if the model emits one anyway we don't
    /// want it leaking into the bare task-list strip.
    static func strip(_ s: String) -> String { parse(s).text }
}

/// ADR-0046 — one top-level step of a plan. The plan owns its steps; a step
/// can hold `subtasks` discovered mid-execution (a `TodoWrite` item that maps
/// to no existing step gets nested under the active step rather than replacing
/// the plan). Top-level completion is computed over step `status` only —
/// sub-tasks never drive "Plan complete".
struct PlanStep: Equatable, Identifiable {
    /// Stable key derived from the (normalised) step content, so successive
    /// `TodoWrite`s reconcile against the same step.
    let id: String
    var content: String
    /// "pending" | "in_progress" | "completed".
    var status: String
    var activeForm: String?
    var subtasks: [TodoItem]

    init(content: String, status: String = "pending", activeForm: String? = nil, subtasks: [TodoItem] = []) {
        self.id = PlanProgress.normalize(content)
        self.content = content
        self.status = status
        self.activeForm = activeForm
        self.subtasks = subtasks
    }
}

/// ADR-0046 — a plan as the durable spine. Persists for the session, owns its
/// ordered steps, and is one navigable entry in `ChatPreviewView.plans` (a new
/// plan never clobbers a prior one). `id` is the filesystem slug, so
/// re-presenting a same-titled plan reconciles into the same entry.
struct Plan: Equatable, Identifiable {
    let id: String          // PlanFile.slug(title)
    var title: String
    var text: String        // full plan markdown (saved to the file)
    var path: String?       // <workDir>/.marvin/plans/<slug>.md once written
    var steps: [PlanStep]

    /// Top-level completion — sub-tasks deliberately excluded (ADR-0046).
    var isComplete: Bool { !steps.isEmpty && steps.allSatisfy { $0.status == "completed" } }
    var doneCount: Int { steps.filter { $0.status == "completed" }.count }
}

/// Decodes the latest `TodoWrite` list out of an assistant cli.event.
/// Returns nil for any event that isn't a TodoWrite tool call, so callers
/// only replace the list when there's a new one.
enum TodoExtractor {
    private struct Wire: Codable {
        let type: String
        struct Msg: Codable {
            struct Block: Codable {
                let type: String
                let name: String?
                let input: TodoInput?
            }
            let content: [Block]?
        }
        let message: Msg?
    }
    private struct TodoInput: Codable {
        let todos: [WireTodo]?
    }
    private struct WireTodo: Codable {
        let content: String?
        let status: String?
        let activeForm: String?
    }

    static func todos(from data: Data) -> [TodoItem]? {
        guard let env = try? JSONDecoder().decode(Wire.self, from: data),
              env.type == "assistant",
              let blocks = env.message?.content
        else { return nil }
        guard let block = blocks.first(where: { $0.type == "tool_use" && $0.name == "TodoWrite" }),
              let raw = block.input?.todos
        else { return nil }
        return raw.map {
            TodoItem(
                content: $0.content ?? "",
                status: $0.status ?? "pending",
                activeForm: $0.activeForm
            )
        }
    }
}

/// Parses a Plan-mode plan (ExitPlanMode markdown) into seed to-do items, so
/// the approved plan becomes the tracked checklist (ADR-0036) even before the
/// model emits its own `TodoWrite`. Picks up numbered (`1.` / `1)`) and
/// bulleted (`-` / `*` / `•`) steps; ignores headings and prose. Falls back to
/// non-empty lines, then to a single "Execute the plan" item.
enum PlanParser {
    /// Matches a numbered (`1.` / `1)`) or bulleted (`-` / `*` / `•`) step line.
    private static let stepRE = try? NSRegularExpression(pattern: #"^\s*(?:\d+[.)]|[-*•])\s+(.+\S)\s*$"#)

    /// The step content of a single line — the marker stripped, emphasis /
    /// inline code removed — or nil if the line isn't a step. Shared by
    /// `todos(from:)` and `PlanFile.render` so parsing and rendering of the
    /// same line can never drift apart.
    static func stepText(of line: String) -> String? {
        guard let re = stepRE else { return nil }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let m = re.firstMatch(in: line, range: range),
              let r = Range(m.range(at: 1), in: line) else { return nil }
        let content = String(line[r])
            // strip markdown emphasis / inline code / trailing colons
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
        return content.count > 1 ? content : nil
    }

    static func todos(from plan: String) -> [TodoItem] {
        let lines = plan.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var items: [String] = []
        for line in lines {
            if let content = stepText(of: line) { items.append(content) }
        }
        if items.isEmpty {
            // No list markers — take substantive non-heading lines.
            items = lines
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !$0.hasPrefix("#") && $0.count > 3 }
        }
        if items.isEmpty { items = ["Execute the plan"] }
        // Cap so a giant plan doesn't flood the strip.
        return items.prefix(20).map { TodoItem(content: $0, status: "pending", activeForm: nil) }
    }

    /// ADR-0046 — seed a plan's top-level `PlanStep`s from its markdown. Same
    /// extraction as `todos(from:)`, lifted into the hierarchical type.
    static func steps(from plan: String) -> [PlanStep] {
        todos(from: plan).map { PlanStep(content: $0.content, status: $0.status, activeForm: $0.activeForm) }
    }
}

/// ADR-0049 — reconciles an incoming `TodoWrite` list into a plan's steps via a
/// stable join key (the `[N]` / `[N.M]` tag) rather than fuzzy content matching.
/// `[N]` updates plan step N in place; `[N.M]` nests as sub-task M of step N;
/// untagged items fall back to ADR-0046 content matching, then to nested
/// sub-tasks — so the plan can never be erased, and a step with sub-tasks
/// completes automatically when all of them do (upward propagation).
enum PlanProgress {
    /// Lowercase, fold every non-alphanumeric run to a single space, trim.
    /// Used both as the stable `PlanStep.id` and as the match key.
    static func normalize(_ s: String) -> String {
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

    /// Two normalised strings "match" on exact equality, or when one contains
    /// the other and both are long enough that the containment isn't accidental
    /// (guards against a 2-char step swallowing everything).
    static func matches(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        guard a.count >= 6, b.count >= 6 else { return false }
        return a.contains(b) || b.contains(a)
    }

    /// Merge incoming sub-tasks into a step's existing ones: match by stable
    /// `key` first (ADR-0049 — survives rephrasing), else by normalized content
    /// (ADR-0046 backstop), updating in place or appending. Keeps sub-task
    /// statuses live across successive `TodoWrite`s without duplicating rows.
    static func mergeSubtasks(_ existing: [TodoItem], _ incoming: [TodoItem]) -> [TodoItem] {
        var out = existing
        for item in incoming {
            let idx: Int?
            if let k = item.key {
                idx = out.firstIndex(where: { $0.key == k })
                    ?? out.firstIndex(where: { $0.key == nil && matches(normalize($0.content), normalize(item.content)) })
            } else {
                let ni = normalize(item.content)
                idx = out.firstIndex(where: { matches(normalize($0.content), ni) })
            }
            if let i = idx { out[i] = item } else { out.append(item) }
        }
        return out
    }

    /// Reconcile `incoming` (a fresh `TodoWrite` list) into `steps` (ADR-0049).
    /// Tagged items link by ordinal: `[N]` updates step N's status/activeForm,
    /// `[N.M]` nests as sub-task M of step N. Untagged items fall back to
    /// ADR-0046 content matching, then nest under the active step / a trailing
    /// "Additional work" bucket. Finally, every step that owns sub-tasks has its
    /// status DERIVED from them (all complete → complete) — the upward roll-up.
    static func reconcile(steps: [PlanStep], with incoming: [TodoItem]) -> [PlanStep] {
        var steps = steps
        var used = Set<Int>()
        var fuzzy: [TodoItem] = []   // untagged / out-of-range → content backstop

        for raw in incoming {
            let tag = PlanTag.parse(raw.content)
            if let s = tag.step, s >= 1, s <= steps.count {
                let idx = s - 1
                if let sub = tag.sub {
                    let keyed = TodoItem(content: tag.text, status: raw.status,
                                         activeForm: raw.activeForm, key: "\(s).\(sub)")
                    steps[idx].subtasks = mergeSubtasks(steps[idx].subtasks, [keyed])
                } else {
                    steps[idx].status = raw.status
                    steps[idx].activeForm = raw.activeForm
                    used.insert(idx)
                }
            } else {
                fuzzy.append(TodoItem(content: tag.text, status: raw.status, activeForm: raw.activeForm))
            }
        }

        // ADR-0046 backstop for untagged items: match a step by normalized
        // content, else collect for nesting.
        var unmatched: [TodoItem] = []
        for item in fuzzy {
            let ni = normalize(item.content)
            if let idx = steps.indices.first(where: { !used.contains($0) && matches(steps[$0].id, ni) }) {
                steps[idx].status = item.status
                steps[idx].activeForm = item.activeForm
                used.insert(idx)
            } else {
                unmatched.append(item)
            }
        }

        let bucketId = normalize("Additional work")
        if !unmatched.isEmpty {
            if let idx = steps.firstIndex(where: { $0.status == "in_progress" })
                ?? steps.lastIndex(where: { $0.status != "completed" && $0.id != bucketId }) {
                steps[idx].subtasks = mergeSubtasks(steps[idx].subtasks, unmatched)
            } else if let idx = steps.firstIndex(where: { $0.id == bucketId }) {
                steps[idx].subtasks = mergeSubtasks(steps[idx].subtasks, unmatched)
            } else {
                var bucket = PlanStep(content: "Additional work", status: "in_progress")
                bucket.subtasks = unmatched
                steps.append(bucket)
            }
        }

        // ADR-0049 — upward completion propagation. A step that owns sub-tasks
        // derives its status from them: all complete → the step completes; any
        // in flight, or the parent already marked in_progress → in_progress;
        // else leave the model-set status. This is the "subtasks done → main
        // task done" roll-up the user asked for. Steps with no sub-tasks keep
        // their model-driven status untouched.
        for idx in steps.indices where !steps[idx].subtasks.isEmpty {
            let subs = steps[idx].subtasks
            if subs.allSatisfy({ $0.status == "completed" }) {
                steps[idx].status = "completed"
            } else if subs.contains(where: { $0.status == "in_progress" || $0.status == "completed" })
                        || steps[idx].status == "in_progress" {
                steps[idx].status = "in_progress"
            }
        }
        return steps
    }
}

/// Filesystem helpers for the saved plan markdown (ADR-0036 two-tier
/// addendum). The plan is written to `<workDir>/.marvin/plans/<slug>.md`
/// and opened in the editor pane so the user can see the plan file.
enum PlanFile {
    /// Turn a plan title into a stable, filesystem-safe slug. Re-presenting
    /// the same-titled plan re-uses the file (no dated-clutter pile-up).
    static func slug(_ title: String) -> String {
        let lowered = title.lowercased()
        let mapped = lowered.map { ch -> Character in
            (ch.isLetter || ch.isNumber) ? ch : "-"
        }
        let collapsed = String(mapped)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        // Cap length, then trim any hyphen the cut left dangling at the edge
        // so we get "parcele-…-archive", not "parcele-…-archive-".
        let trimmed = String(collapsed.prefix(60))
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? "plan" : trimmed
    }

    /// ADR-0046 (follow-up) — project the plan's live progress onto its saved
    /// markdown so the file mirrors the chat strip: completed steps get a `[x]`
    /// checkbox, discovered sub-tasks appear nested under their step, and any
    /// step with no source line (the synthetic "Additional work" bucket, or a
    /// step the model rephrased past matching) is appended at the end.
    ///
    /// The overlay is anchored to each step's ORIGINAL line — the marker /
    /// numbering and prose are preserved (so the plan card and the file stay
    /// structurally aligned); only a `[ ]` / `[x]` box is inserted after the
    /// marker. Always rendered from `plan.text` (never from already-checkboxed
    /// output) and existing boxes are stripped before re-inserting, so the
    /// render is idempotent.
    static func render(_ plan: Plan) -> String {
        guard !plan.steps.isEmpty else { return plan.text }

        var byId: [String: PlanStep] = [:]
        for s in plan.steps { byId[s.id] = s }
        var emitted = Set<String>()

        // indent · marker (1. / - / •) · gap · rest-of-line
        let markerRE = try? NSRegularExpression(pattern: #"^(\s*)(\d+[.)]|[-*•])(\s+)(.*)$"#)
        // a leading checkbox already on the content (defensive idempotency)
        let boxRE = try? NSRegularExpression(pattern: #"^\[[ xX]\]\s*"#)

        func box(_ status: String) -> String { status == "completed" ? "[x] " : "[ ] " }

        func overlay(_ line: String, _ status: String) -> String {
            guard let re = markerRE else { return line }
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            guard let m = re.firstMatch(in: line, range: range),
                  let ri = Range(m.range(at: 1), in: line),
                  let rm = Range(m.range(at: 2), in: line),
                  let rg = Range(m.range(at: 3), in: line),
                  let rr = Range(m.range(at: 4), in: line) else { return line }
            var rest = String(line[rr])
            if let bre = boxRE {
                let rrange = NSRange(rest.startIndex..<rest.endIndex, in: rest)
                rest = bre.stringByReplacingMatches(in: rest, range: rrange, withTemplate: "")
            }
            return "\(line[ri])\(line[rm])\(line[rg])\(box(status))\(rest)"
        }

        func subLine(_ indent: String, _ item: TodoItem) -> String {
            "\(indent)  - \(box(item.status))\(item.content)"
        }

        var out: [String] = []
        let lines = plan.text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for line in lines {
            if let content = PlanParser.stepText(of: line) {
                let id = PlanProgress.normalize(content)
                if let step = byId[id], !emitted.contains(id) {
                    out.append(overlay(line, step.status))
                    let indent = line.prefix { $0 == " " || $0 == "\t" }
                    for sub in step.subtasks { out.append(subLine(String(indent), sub)) }
                    emitted.insert(id)
                    continue
                }
            }
            out.append(line)
        }

        // Steps with no source line (e.g. "Additional work") — append as a
        // checklist so discovered work still lands in the file.
        let leftovers = plan.steps.filter { !emitted.contains($0.id) }
        if !leftovers.isEmpty {
            if out.last?.isEmpty == false { out.append("") }
            for step in leftovers {
                out.append("- \(box(step.status))\(step.content)")
                for sub in step.subtasks { out.append(subLine("", sub)) }
            }
        }

        return out.joined(separator: "\n")
    }
}

/// The checklist strip, hosted above the chat input by ChatPreviewView.
///
/// ADR-0036 (two-tier addendum) — Cursor keeps two distinct things:
///   • **Tier 1 — Task list**: a bare `TodoWrite` checklist the agent emits
///     for any multi-step Agent-mode task. Ephemeral, no plan behind it,
///     neutral styling.
///   • **Tier 2 — Plan**: a plan-backed checklist (Plan mode, approved). The
///     plan IS the to-do list — it persists, ticks off in place, and links to
///     the saved plan file. Purple, titled, with an "Open plan" affordance.
/// `planTitle != nil` selects tier 2; otherwise the strip is tier 1.
struct TodoListStrip: View {
    /// Tier 1 — a bare `TodoWrite` checklist (no plan behind it).
    var todos: [TodoItem] = []
    /// Tier 2 (ADR-0046) — the active plan's top-level steps, each with nested
    /// sub-tasks. Non-nil selects tier 2 (overrides `todos`).
    var steps: [PlanStep]? = nil
    /// Non-nil => tier 2 (plan-backed). The plan's title, shown in the header.
    var planTitle: String? = nil
    /// ADR-0046 — all session plans, for the header picker. Shown only when
    /// more than one exists so the user can switch the active plan.
    var plans: [Plan] = []
    var activePlanId: String? = nil
    var onSelectPlan: ((String) -> Void)? = nil
    /// Re-open the saved plan markdown in the editor pane (tier 2 only).
    var onOpenPlanFile: (() -> Void)? = nil
    /// Dismiss the plan checklist entirely (the ✕). nil hides the close button.
    var onClose: (() -> Void)? = nil

    /// Collapse to just the header. Auto-set true once the plan completes so a
    /// finished plan shrinks to a one-line "✓ Plan complete" the user can keep
    /// or dismiss — instead of a stale full checklist lingering.
    @State private var collapsed: Bool = false

    /// Tier 2 (plan-backed) vs tier 1 (bare task list). Drives every
    /// styling fork below so the two never read as the same artifact.
    /// Tier 2 is selected by the presence of `steps`.
    private var isPlan: Bool { steps != nil }

    /// Count / completion is computed over the active unit — top-level plan
    /// steps in tier 2 (sub-tasks deliberately excluded, ADR-0046), todos in
    /// tier 1. So a sub-task-only `TodoWrite` can never read as "Plan complete".
    private var total: Int { isPlan ? (steps?.count ?? 0) : todos.count }
    private var done: Int {
        isPlan ? (steps?.filter { $0.status == "completed" }.count ?? 0)
               : todos.filter { $0.status == "completed" }.count
    }
    private var allDone: Bool { total > 0 && done == total }
    private var tint: Color { isPlan ? .purple : .blue }

    private var headerIcon: String {
        if allDone { return "checkmark.seal.fill" }
        return isPlan ? "map" : "checklist"
    }
    private var headerLabel: String {
        if isPlan {
            return allDone ? "Plan complete" : (planTitle ?? "Plan")
        }
        return allDone ? "Tasks complete" : "Task list"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Button { withAnimation(.easeInOut(duration: 0.12)) { collapsed.toggle() } } label: {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                }
                .buttonStyle(.plain)
                Image(systemName: headerIcon)
                    .font(.system(size: 10))
                    .foregroundStyle(allDone ? .green : tint)
                Text(headerLabel)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("\(done)/\(total)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                // ADR-0046 — switch the active plan when more than one exists,
                // so a newer plan never strands the earlier ones.
                if isPlan, plans.count > 1, let onSelectPlan {
                    Menu {
                        ForEach(plans) { plan in
                            Button {
                                onSelectPlan(plan.id)
                            } label: {
                                Label("\(plan.title)  ·  \(plan.doneCount)/\(plan.steps.count)",
                                      systemImage: plan.id == activePlanId ? "checkmark" : "map")
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.down.circle")
                            .font(.system(size: 10))
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .foregroundStyle(tint)
                    .help("Switch the active plan (\(plans.count) plans this session)")
                }
                Spacer()
                // Tier 2 only — re-focus the saved plan file in the editor.
                if isPlan, let onOpenPlanFile {
                    Button(action: onOpenPlanFile) {
                        Label("Open plan", systemImage: "doc.text")
                            .font(.system(size: 10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(tint)
                    .help("Open the saved plan file in the editor")
                }
                if let onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .frame(width: 16, height: 16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(isPlan ? "Dismiss the plan" : "Dismiss the task list")
                }
            }
            // Plans are short; cap the height and scroll if a long one
            // shows up so the strip never crowds the input bar.
            if !collapsed {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        if let steps {
                            // Tier 2 — top-level steps, each with its nested
                            // sub-tasks indented beneath (ADR-0046).
                            ForEach(steps) { step in
                                row(TodoItem(content: step.content, status: step.status, activeForm: step.activeForm))
                                ForEach(Array(step.subtasks.enumerated()), id: \.offset) { _, sub in
                                    row(sub, indent: true)
                                }
                            }
                        } else {
                            ForEach(Array(todos.enumerated()), id: \.offset) { _, item in
                                row(item)
                            }
                        }
                    }
                }
                .frame(maxHeight: 132)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background((allDone ? Color.green : tint).opacity(0.06))
        .onChange(of: allDone) { _, done in
            if done { withAnimation(.easeInOut(duration: 0.15)) { collapsed = true } }
        }
    }

    private func row(_ item: TodoItem, indent: Bool = false) -> some View {
        let running = item.status == "in_progress"
        let completed = item.status == "completed"
        let label = running ? (item.activeForm ?? item.content) : item.content
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            // Nested sub-tasks (ADR-0046) sit indented under their plan step.
            if indent {
                Rectangle().fill(.clear).frame(width: 14)
            }
            Image(systemName: statusIcon(item.status))
                .font(.system(size: indent ? 10 : 11))
                .foregroundStyle(statusColour(item.status))
            Text(label)
                .font(.system(size: indent ? 10 : 11))
                .strikethrough(completed)
                .foregroundStyle(completed ? .secondary : (running ? .primary : .secondary))
            Spacer(minLength: 0)
        }
    }

    private func statusIcon(_ s: String) -> String {
        switch s {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        default: return "circle"
        }
    }

    private func statusColour(_ s: String) -> Color {
        switch s {
        case "completed": return .green
        case "in_progress": return tint
        default: return .secondary
        }
    }
}

// TodoListView — ADR-0036. The live to-do checklist, Cursor / Claude-Code
// style. MARVIN's model emits a `TodoWrite` tool call (each call rewrites
// the WHOLE list with per-item status); we capture the latest from the
// turn's cli.event stream and render it as a checklist that ticks off as
// items move pending → in_progress → completed. Most visible in Plan mode
// (the plan's steps) but works in Agent mode too.

import MARVINLogic
import SwiftUI


/// The checklist strip, hosted above the chat input by ChatPreviewView.
///
/// ADR-0036 (two-tier addendum) — Cursor keeps two distinct things:
///   • **Tier 1 — Task list**: a bare `TodoWrite` checklist the agent emits
///     for any multi-step Agent-mode task. Ephemeral, no plan behind it,
///     neutral styling.
///   • **Tier 2 — Plan**: a plan-backed checklist (Plan mode, approved). The
///     plan IS the to-do list — it persists, ticks off in place, and links to
///     the saved plan file. Purple, titled, with an "Open plan" affordance.
/// A non-nil `steps` selects tier 2; otherwise the strip is tier 1.
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
    /// Open the session Plans panel (tier 2 only). nil hides the button.
    var onOpenPlansPanel: (() -> Void)? = nil
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
                // Tier 2 only — browse every session plan with full steps.
                if isPlan, let onOpenPlansPanel {
                    Button(action: onOpenPlansPanel) {
                        Label("Plans", systemImage: "list.bullet.rectangle")
                            .font(.system(size: 10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(tint)
                    .help("Browse this session's plans (\(plans.count))")
                }
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

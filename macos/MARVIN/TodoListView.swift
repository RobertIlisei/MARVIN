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
    static func todos(from plan: String) -> [TodoItem] {
        let lines = plan.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var items: [String] = []
        let stepRE = try? NSRegularExpression(pattern: #"^\s*(?:\d+[.)]|[-*•])\s+(.+\S)\s*$"#)
        for line in lines {
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            if let re = stepRE, let m = re.firstMatch(in: line, range: range),
               let r = Range(m.range(at: 1), in: line) {
                let content = String(line[r])
                    // strip markdown emphasis / inline code / trailing colons
                    .replacingOccurrences(of: "**", with: "")
                    .replacingOccurrences(of: "`", with: "")
                if content.count > 1 { items.append(content) }
            }
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
        let trimmed = String(collapsed.prefix(60))
        return trimmed.isEmpty ? "plan" : trimmed
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
    let todos: [TodoItem]
    /// Non-nil => tier 2 (plan-backed). The plan's title, shown in the header.
    var planTitle: String? = nil
    /// Re-open the saved plan markdown in the editor pane (tier 2 only).
    var onOpenPlanFile: (() -> Void)? = nil
    /// Dismiss the plan checklist entirely (the ✕). nil hides the close button.
    var onClose: (() -> Void)? = nil

    /// Collapse to just the header. Auto-set true once the plan completes so a
    /// finished plan shrinks to a one-line "✓ Plan complete" the user can keep
    /// or dismiss — instead of a stale full checklist lingering.
    @State private var collapsed: Bool = false

    private var done: Int { todos.filter { $0.status == "completed" }.count }
    private var allDone: Bool { !todos.isEmpty && done == todos.count }

    /// Tier 2 (plan-backed) vs tier 1 (bare task list). Drives every
    /// styling fork below so the two never read as the same artifact.
    private var isPlan: Bool { planTitle != nil }
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
                Text("\(done)/\(todos.count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
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
                        ForEach(Array(todos.enumerated()), id: \.offset) { _, item in
                            row(item)
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

    private func row(_ item: TodoItem) -> some View {
        let running = item.status == "in_progress"
        let completed = item.status == "completed"
        let label = running ? (item.activeForm ?? item.content) : item.content
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: statusIcon(item.status))
                .font(.system(size: 11))
                .foregroundStyle(statusColour(item.status))
            Text(label)
                .font(.system(size: 11))
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

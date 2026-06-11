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

/// The checklist strip, hosted above the chat input by ChatPreviewView.
struct TodoListStrip: View {
    let todos: [TodoItem]

    private var done: Int { todos.filter { $0.status == "completed" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "checklist")
                    .font(.system(size: 10))
                    .foregroundStyle(.purple)
                Text("Plan")
                    .font(.system(size: 11, weight: .semibold))
                Text("\(done)/\(todos.count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            // Plans are short; cap the height and scroll if a long one
            // shows up so the strip never crowds the input bar.
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, item in
                        row(item)
                    }
                }
            }
            .frame(maxHeight: 132)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.purple.opacity(0.06))
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
        case "in_progress": return .purple
        default: return .secondary
        }
    }
}

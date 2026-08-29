// SubagentLedger — what MARVIN's subagents are doing this session, from the
// SDK event stream (ADR-0080 / ADR-0081 observability).
//
// Dispatches are `tool_use` blocks named `Agent` (or the pre-rename `Task`)
// with a `subagent_type`; the SDK's `system/task_started` confirms the task
// id and whether it went to the background; `system/task_notification`
// settles it. Pure and stateful: feed it every `cli.event`, read the summary.
// Lives in MARVINLogic so the parsing is test-pinned (ADR-0022).

import Foundation

public struct SubagentSummary: Sendable, Equatable {
    /// Dispatch counts by `subagent_type`, e.g. `["scout": 3, "implementer": 1]`.
    public var dispatchedByType: [String: Int] = [:]
    public var background: Int = 0
    public var running: Int = 0
    public var completed: Int = 0
    public var failed: Int = 0

    public var dispatched: Int { dispatchedByType.values.reduce(0, +) }
    public init() {}
}

public struct SubagentLedger: Sendable, Equatable {
    public private(set) var summary = SubagentSummary()
    /// task_id → subagent_type for tasks the SDK reports as running.
    private var live: [String: String] = [:]

    public init() {}

    /// Apply one `cli.event` payload. Returns true when anything changed.
    @discardableResult
    public mutating func apply(cliEventData data: Data) -> Bool {
        guard let env = try? JSONDecoder().decode(Wire.self, from: data) else { return false }
        switch env.type {
        case "assistant":
            var changed = false
            for b in env.message?.content ?? [] where b.type == "tool_use" {
                guard b.name == "Agent" || b.name == "Task" else { continue }
                let type = b.input?.subagent_type ?? "general-purpose"
                summary.dispatchedByType[type, default: 0] += 1
                changed = true
            }
            return changed
        case "system":
            switch env.subtype {
            case "task_started":
                guard env.task_type == "local_agent", let id = env.task_id else { return false }
                live[id] = env.subagent_type ?? "general-purpose"
                summary.running = live.count
                if env.is_backgrounded == true { summary.background += 1 }
                return true
            case "task_notification":
                guard let id = env.task_id, live.removeValue(forKey: id) != nil else { return false }
                summary.running = live.count
                if env.status == "completed" { summary.completed += 1 } else { summary.failed += 1 }
                return true
            default:
                return false
            }
        default:
            return false
        }
    }

    private struct Wire: Codable {
        let type: String
        let subtype: String?
        let task_id: String?
        let task_type: String?
        let subagent_type: String?
        let is_backgrounded: Bool?
        let status: String?
        struct Msg: Codable {
            struct Input: Codable { let subagent_type: String? }
            struct Block: Codable {
                let type: String
                let name: String?
                let input: Input?
            }
            let content: [Block]?
        }
        let message: Msg?
    }
}

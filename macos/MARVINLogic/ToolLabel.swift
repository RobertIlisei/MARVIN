// ToolLabel — the words a confirm card uses for a tool (critique U12).
//
// The SDK names tools for the model: `Bash`, `MultiEdit`, `ExitPlanMode`,
// `mcp__playwright__browser_click`. A card that asks "may MARVIN do this?"
// reads better in the user's words, so the raw name stays in the transcript
// (machine voice, Mono-For-Machines) and in the card's tooltip, and the card
// itself says what the call does. A name this table does not know passes
// through unchanged: a wrong friendly label would be worse than a raw one.

import Foundation

public enum ToolLabel {
    public static func plain(_ toolName: String) -> String {
        if toolName.isEmpty { return "Tool" }
        switch toolName {
        case "Bash": return "Shell command"
        case "Edit", "MultiEdit": return "Edit file"
        case "Write": return "Write file"
        case "NotebookEdit": return "Edit notebook"
        case "ExitPlanMode": return "Plan"
        case "WebFetch": return "Fetch web page"
        case "Agent", "Task": return "Subagent"
        default: break
        }
        if toolName.hasPrefix("mcp__") {
            let parts = toolName.dropFirst("mcp__".count).components(separatedBy: "__")
            let server = parts.first ?? ""
            let tool = parts.dropFirst().joined(separator: " ").replacingOccurrences(of: "_", with: " ")
            return tool.isEmpty ? server : "\(server) · \(tool)"
        }
        return toolName
    }
}

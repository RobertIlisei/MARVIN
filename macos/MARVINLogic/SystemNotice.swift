// SystemNotice — which `system` cli.events become a row in the chat.
//
// Pure. The reducer drops system events on purpose (an `init` per turn is
// noise), which also dropped two the user needs to see:
//
//   - `system/informational` (Agent SDK 0.3.283): warnings and notices raised
//     during a turn — a hook's block reason, slash-command output. Before
//     0.3.283 the CLI discarded them; now they arrive and must render.
//     `info` level is transcript-only by the SDK's own contract.
//   - `system/init.plugin_errors` (0.3.283): a staged plugin that did not
//     load. MARVIN mounts plugins as `--plugin-dir` entries (ADR-0053), so a
//     failure is reported against `inline[N]` with the directory's path —
//     its last segment is the plugin's staged name.

import Foundation

public enum SystemNotice {
    /// The row text for a system event the user should see, or nil.
    public static func text(cliEventData data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["type"] as? String == "system",
              let subtype = json["subtype"] as? String
        else { return nil }
        switch subtype {
        case "informational":
            let content = (json["content"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return nil }
            switch json["level"] as? String {
            case "warning": return "⚠ " + content
            case "notice", "suggestion": return content
            default: return nil
            }
        case "init":
            guard let errors = json["plugin_errors"] as? [[String: Any]], !errors.isEmpty else { return nil }
            let parts = errors.map { e -> String in
                let path = e["path"] as? String
                let name = path.map { ($0 as NSString).lastPathComponent }.flatMap { $0.isEmpty ? nil : $0 }
                    ?? (e["plugin"] as? String ?? "plugin")
                let message = e["message"] as? String ?? (e["type"] as? String ?? "failed")
                return "\(name): \(message)"
            }
            let noun = errors.count == 1 ? "plugin did" : "plugins did"
            return "⚠ \(errors.count) \(noun) not load — " + parts.joined(separator: "; ")
        default:
            return nil
        }
    }
}

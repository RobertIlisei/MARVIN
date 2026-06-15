// MemoryLog — append helper for `<workDir>/.marvin/session-notes.md`.
//
// ADR-0042 retargeted this. `.marvin/memory.md` is now a curated
// durable-facts INDEX owned by the `remember` MCP tool (rebuilt from
// per-fact files), so a manually-appended scope summary would be
// clobbered on the next `remember` AND is activity, not a durable
// fact. The Scope-met chip's "Save session note" therefore lands a
// dated one-liner in `session-notes.md` (a lightweight activity sink),
// not the durable-facts index. A first-class native "remember a fact"
// affordance is a follow-up (ADR-0042 Scope of Done). Originally
// ADR-0022 §3 + §4 (Scope-met chip → memory.md).
//
// Conservative: creates the parent directory if missing, opens for
// append, never overwrites. Failures log to NSLog and are silent in
// the UI (keeping the note is a side-effect, not a barrier to
// continuing the conversation).

import Foundation

enum MemoryLog {
    /// Append `line` (no trailing newline needed) to
    /// `<workDir>/.marvin/session-notes.md`. Creates the file + parent
    /// dir on first use. Idempotent within a session — duplicate clicks
    /// land duplicate lines, which is preferable to silently dropping
    /// the second click.
    @discardableResult
    static func append(workDir: String, line: String) -> Bool {
        let url = URL(fileURLWithPath: workDir)
            .appendingPathComponent(".marvin", isDirectory: true)
            .appendingPathComponent("session-notes.md")
        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true
            )
        } catch {
            NSLog("[MemoryLog] failed to create parent dir: \(error)")
            return false
        }
        let entry = line.hasSuffix("\n") ? line : line + "\n"
        guard let data = entry.data(using: .utf8) else { return false }
        if !FileManager.default.fileExists(atPath: url.path) {
            do {
                try data.write(to: url)
            } catch {
                NSLog("[MemoryLog] failed initial write: \(error)")
                return false
            }
            return true
        }
        do {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            NSLog("[MemoryLog] append failed: \(error)")
            return false
        }
        return true
    }
}

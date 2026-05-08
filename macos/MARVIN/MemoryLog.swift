// MemoryLog — append helper for `<workDir>/.marvin/memory.md`
// (ADR-0022 §3 + §4). The chat's Scope-met chip strip calls this
// when the user clicks "Save to memory.md", landing a one-line entry
// the next session will pick up via `buildProjectContext`.
//
// Conservative: creates the parent directory if missing, opens for
// append, never overwrites. Failures log to NSLog and are silent in
// the UI (keeping memory.md is a side-effect, not a barrier to
// continuing the conversation).

import Foundation

enum MemoryLog {
    /// Append `line` (no trailing newline needed) to
    /// `<workDir>/.marvin/memory.md`. Creates the file + parent dir
    /// on first use. Idempotent within a session — duplicate clicks
    /// land duplicate lines, which is preferable to silently dropping
    /// the second click.
    @discardableResult
    static func append(workDir: String, line: String) -> Bool {
        let url = URL(fileURLWithPath: workDir)
            .appendingPathComponent(".marvin", isDirectory: true)
            .appendingPathComponent("memory.md")
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

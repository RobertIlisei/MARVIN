// RunFileCommand — the shell command that runs a single source file.
//
// This is INTERPRETER knowledge, not project knowledge (Golden Rule 6):
// "a .py file is run by python3" is a fact about Python, true in every
// project, in the same category as "a .py comment starts with #" already
// encoded in `EditorTextOps.lineCommentToken`. What must never appear here
// is a project's own entry point, script name, or task runner — that is
// what the Build Task list reads out of the project itself.
//
// Returning nil is a first-class answer. A language with no single-file
// run story (Java before 11, C without a compile step, or anything not
// listed) gets no command rather than a guess that fails in the terminal.

import Foundation

public enum RunFileCommand {
    /// The command to run `path`, or nil when the language has no
    /// meaningful single-file run.
    public static func command(forPath path: String) -> String? {
        let ext = (path as NSString).pathExtension.lowercased()
        let quoted = shellQuoted(path)
        switch ext {
        case "py":          return "python3 \(quoted)"
        case "js", "mjs", "cjs": return "node \(quoted)"
        case "ts", "mts":   return "npx tsx \(quoted)"
        case "rb":          return "ruby \(quoted)"
        case "sh", "bash":  return "bash \(quoted)"
        case "zsh":         return "zsh \(quoted)"
        case "pl":          return "perl \(quoted)"
        case "php":         return "php \(quoted)"
        case "lua":         return "lua \(quoted)"
        case "r":           return "Rscript \(quoted)"
        case "swift":       return "swift \(quoted)"
        case "go":          return "go run \(quoted)"
        // `java` runs a single .java source file directly from JDK 11 on
        // (JEP 330). Below that it needs javac first, and printing the
        // wrong one is worse than printing nothing — but 11 shipped in
        // 2018, so this is the right default.
        case "java":        return "java \(quoted)"
        case "kt":          return "kotlin \(quoted)"
        case "rs":          return "cargo run"     // a .rs file is not a program
        case "exs":         return "elixir \(quoted)"
        case "dart":        return "dart run \(quoted)"
        default:            return nil
        }
    }

    /// Single-quote for POSIX shells. The command is typed into a live
    /// terminal, so a path with a space — or a quote — must not become two
    /// arguments or an unterminated string.
    public static func shellQuoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

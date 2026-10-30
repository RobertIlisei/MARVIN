// ShellQuote — a path reaches the terminal as one literal word.
//
// The Tasks panel typed `cd <dir> && <command>` into the user's shell with only
// spaces escaped, so a directory name holding a quote, `$`, backtick or `;` was
// interpreted by the shell rather than passed to `cd` (audit K18). Single quotes
// make everything but another single quote inert.

import Foundation

public enum ShellQuote {
    /// `value` as one POSIX shell word. A single quote cannot appear inside
    /// single quotes, so it closes the string, is escaped, and reopens it.
    public static func single(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The `cd … && ` that precedes a task's command, or nothing when the task
    /// runs where the terminal already is.
    public static func cdPrefix(directory: String?) -> String {
        guard let directory else { return "" }
        return "cd \(single(directory)) && "
    }
}

public enum ReviseDraft {
    /// What the composer holds after "Revise". The button used to overwrite the
    /// draft; the user's unsent text is kept and the prompt follows it
    /// (audit C12).
    public static let prompt = "Revise the plan — "

    public static func compose(existing: String) -> String {
        let kept = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        return kept.isEmpty ? prompt : existing + "\n\n" + prompt
    }
}

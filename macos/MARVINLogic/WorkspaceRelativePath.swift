// WorkspaceRelativePath — a path as the user would cite it in a message.
//
// "Copy Relative Path" is the one people actually paste into chat, an issue
// or a commit message, and getting it slightly wrong (a leading slash, or a
// prefix match that isn't a real ancestor) makes the result useless in a way
// that is not obvious until someone else tries to open it.
//
// Pure (ADR-0022) because the edge cases — a file outside the workspace, a
// root with a trailing slash, a sibling directory that merely shares a name
// prefix — are exactly what a unit test is for and what a running app is not.

import Foundation

public enum WorkspaceRelativePath {
    /// `path` expressed relative to `root`, or nil when it is not inside it.
    public static func of(_ path: String, in root: String) -> String? {
        guard !root.isEmpty else { return nil }
        // Normalise the root to exactly one trailing separator, so both
        // "/a/b" and "/a/b/" behave the same.
        var base = root
        while base.hasSuffix("/") && base.count > 1 { base.removeLast() }
        if path == base { return "" }
        // The separator matters: without it "/a/bc/d" would look like it
        // lives under "/a/b".
        let prefix = base.hasSuffix("/") ? base : base + "/"
        guard path.hasPrefix(prefix) else { return nil }
        return String(path.dropFirst(prefix.count))
    }
}

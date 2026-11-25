// SourceControlCollapse — which of the pane's groups are closed, and what a
// first launch looks like.
//
// The set stores what is CLOSED, so a group added in a later version is open by
// default. An empty stored set is a choice (the person opened everything), not
// "never stored", which is why `initial` takes an optional. The defaults close
// only what is reference rather than work: spent worktrees, the commit graph
// and stashes.
//
// Pure (ADR-0022); the view layer owns the UserDefaults key.

import Foundation

public enum SourceControlCollapse {
    public static let defaultClosed: Set<String> = ["worktrees.spent", "section.history", "section.stashes"]

    public static func initial(stored: [String]?) -> Set<String> {
        stored.map(Set.init) ?? defaultClosed
    }

    public static func toggled(_ id: String, in set: Set<String>) -> Set<String> {
        var s = set
        if s.contains(id) { s.remove(id) } else { s.insert(id) }
        return s
    }

    public static func encode(_ set: Set<String>) -> [String] { set.sorted() }
}

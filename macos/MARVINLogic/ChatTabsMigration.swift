// ChatTabsMigration — move the chat tab strip off a UserDefaults key it was
// sharing with the editor (ADR-0107).
//
// `marvin.openTabs.<pid>` was written by TWO unrelated lists: the editor's
// file tabs (`NativePrefs.setOpenTabs`, JSON `Data`) and the chat strip's
// session ids (`ChatPreviewModel.persistOpenTabs`, a native `[String]`).
// Each reader used a type-specific accessor, so whichever wrote last made the
// other silently read empty — editor tabs vanished on relaunch after the chat
// strip wrote, and vice versa. Chat tabs now live under
// `marvin.chatTabs.<pid>`; this decides, from what is on disk, what the strip
// should show and whether the legacy key can be freed for the editor.
//
// Pure (ADR-0022): the caller reads the two keys and applies the result.

public enum ChatTabsMigration {
    public struct Result: Equatable {
        /// The open chat tabs, in order, deduplicated.
        public let tabs: [String]
        /// Write `tabs` under the new key (only when it came from the legacy one).
        public let writeNewKey: Bool
        /// Remove the legacy key — it provably held the chat list, and freeing
        /// it hands the key back to the editor.
        public let removeLegacyKey: Bool
    }

    /// - Parameters:
    ///   - newValue: `marvin.chatTabs.<pid>` read as `[String]?`.
    ///   - legacyStringArray: `marvin.openTabs.<pid>` read via `stringArray(forKey:)`.
    ///     That accessor returns nil for the editor's `Data`, so the editor's
    ///     tabs are never mistaken for chat tabs and never touched.
    public static func resolve(newValue: [String]?, legacyStringArray: [String]?) -> Result {
        if let newValue {
            return Result(tabs: dedupe(newValue), writeNewKey: false, removeLegacyKey: false)
        }
        if let legacy = legacyStringArray {
            return Result(tabs: dedupe(legacy), writeNewKey: true, removeLegacyKey: true)
        }
        return Result(tabs: [], writeNewKey: false, removeLegacyKey: false)
    }

    /// Order-preserving, first occurrence wins, blanks dropped.
    public static func dedupe(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for id in ids where !id.isEmpty && !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        return out
    }

    /// Which tab to show after closing `closed`: the one that was to its
    /// right, else the new last one, else nil (nothing left).
    public static func neighbour(after closed: String, in tabs: [String]) -> String? {
        guard let idx = tabs.firstIndex(of: closed) else { return tabs.last }
        let rest = tabs.filter { $0 != closed }
        if idx < rest.count { return rest[idx] }
        return rest.last
    }
}

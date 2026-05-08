// ScopeMetDetector — find the personality's Phase 7 close marker in
// the latest assistant text block (ADR-0022 §3).
//
// MARVIN's personality emits, on every real-work turn end:
//
//     **Scope met:** <past-tense DoD bullets>. Anything else, or
//     should I stop?
//     <!-- marvin:scope-met -->
//
// The HTML comment is the load-bearing detection signal — it survives
// personality-text drift (a future personality rewrite could say
// "Scope satisfied:" instead and the visible prose would change, but
// the sentinel is a stable contract). The chat UI watches for it and
// renders a chip strip below the latest message offering:
//
//   * Save to memory.md — opens a one-line append composer
//   * Start fresh next turn (⌘⇧N) — calls model.clear()
//
// Pure helper, no UI dependencies — pinned by `scope-met` test in
// MARVINTests.

import Foundation

public enum ScopeMetDetector {
    /// The literal sentinel emitted by personality.ts. Kept as a
    /// constant so the personality file and the detector can't
    /// silently drift apart — if you change one, the other will
    /// fail to detect and the test will catch it.
    public static let sentinel = "<!-- marvin:scope-met -->"

    /// Returns true when the given assistant text contains the
    /// scope-met sentinel. Substring match is sufficient — we don't
    /// need anchoring because the sentinel is unique enough that an
    /// accidental occurrence in normal prose is essentially
    /// impossible (HTML comments inside regular chat output are
    /// already rare; the `marvin:` prefix removes the rest).
    public static func isPresent(in text: String) -> Bool {
        return text.contains(sentinel)
    }
}

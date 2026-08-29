// DragResize — height from a drag, for bottom-anchored panes.
//
// MARVIN has two resizable strips stacked above the composer: the plan
// checklist and the composer's own editor. Both are BOTTOM-ANCHORED — the
// tray hugs the input bar, so growing either one expands it UPWARD and the
// grip stays roughly where it is. The natural sign (`start + translation`)
// therefore reads inverted: you drag down, the pane grows up, and the handle
// never follows the pointer (user, 2026-08-30, on the plan pane).
//
// `ChatInputView` had already worked this out and inverted its own gesture;
// `TodoListView` had not, so two sibling grips behaved oppositely. This is
// that rule in one tested place, so the next resizable strip inherits it
// instead of picking a sign at random.

import Foundation

public enum DragResize {
    /// New height for a bottom-anchored pane.
    ///
    /// - `start`: height when the gesture began — anchoring on it and applying
    ///   the TOTAL translation each frame is what stops the pane drifting once
    ///   the clamp bites and the pointer keeps travelling.
    /// - `translation`: SwiftUI's `value.translation.height`, positive downward.
    public static func height(
        start: Double,
        translation: Double,
        min minHeight: Double,
        max maxHeight: Double
    ) -> Double {
        let proposed = start - translation
        return Swift.min(Swift.max(proposed, minHeight), maxHeight)
    }
}

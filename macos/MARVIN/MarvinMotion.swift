// MarvinMotion — `withAnimation` that honours System Settings ▸ Accessibility ▸
// Display ▸ Reduce motion.
//
// What survives is decided in `MotionPolicy` (MARVINLogic, asserted): movement —
// disclosures opening, strips collapsing, scrolls that slide — is dropped, and
// fades and colour changes are left alone. The setting is read from the
// workspace rather than from `@Environment(\.accessibilityReduceMotion)` so the
// same call works from a `Task` closure or a button action, where no view
// environment is in reach.

import AppKit
import MARVINLogic
import SwiftUI

enum MarvinMotion {
    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// `withAnimation`, minus the animation when the user asked for less motion.
    @MainActor
    static func with<R>(
        _ animation: Animation? = .default,
        kind: MotionKind = .movement,
        _ body: () throws -> R
    ) rethrows -> R {
        let play = MotionPolicy.plays(kind, reduceMotion: reduceMotion)
        return try withAnimation(play ? animation : nil, body)
    }
}

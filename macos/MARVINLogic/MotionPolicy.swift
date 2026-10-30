// MotionPolicy — which animations survive "Reduce motion".
//
// The audit counted Reduce Motion honoured at 3 of 33 animation sites. Apple's
// guidance is not "no animation": it is to replace movement — slides, scales,
// expanding and collapsing — and to leave crossfades and colour changes, which
// do not trigger the vestibular discomfort the setting exists for.

import Foundation

public enum MotionKind: Sendable {
    /// Something moves or resizes: a disclosure opening, a row sliding, a strip
    /// collapsing, a scale on press.
    case movement
    /// Something fades or changes colour in place: a hover tint, a notice
    /// appearing, a view cross-dissolving.
    case fade
}

public enum MotionPolicy {
    public static func plays(_ kind: MotionKind, reduceMotion: Bool) -> Bool {
        switch kind {
        case .movement: return !reduceMotion
        case .fade: return true
        }
    }
}

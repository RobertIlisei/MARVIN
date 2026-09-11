// How a PaneNotice looks. The kind is decided in MARVINLogic (pure, tested);
// the glyph and colour are this module's, because the theme is.
//
// Colour alone would not be enough — a red word among tinted status text is
// just another tinted word (2026-09-11). The glyph is what makes the kind
// readable at a glance, and it is the same four glyphs macOS uses for status,
// completion, warning and error.

import MARVINLogic
import SwiftUI

extension PaneNotice.Kind {
    var symbol: String {
        switch self {
        case .info: return "info.circle"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var tint: Color {
        switch self {
        case .info: return MarvinTheme.textMuted
        case .success: return GitDecorationColor.added
        case .warning: return .orange
        case .error: return GitDecorationColor.deleted
        }
    }
}

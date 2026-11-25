// PaneMetrics — the type and spacing tokens a pane draws with.
//
// The values live in `MARVINLogic/PaneStandard.swift` (so a test can hold them
// to the 11 pt floor); this is the SwiftUI face of the same numbers. A pane
// never writes `.font(.system(size: 10))` — it picks a token, and the source
// scan in `MARVINTests` fails the build when it does the other thing.

import MARVINLogic
import SwiftUI

enum PaneFont {
    /// A pane's title when it is not the uppercase kind.
    static let paneTitle = Font.system(size: PaneTypeScale.paneTitle, weight: .semibold)
    /// The first line of a row.
    static let rowTitle = Font.system(size: PaneTypeScale.rowTitle)
    /// A row title that is an identifier (a skill, a plugin, a rule id).
    static let rowTitleMono = Font.system(size: PaneTypeScale.rowTitle, design: .monospaced)
    /// The one secondary line, and trailing state text.
    static let secondary = Font.system(size: PaneTypeScale.rowSecondary)
    static let secondaryMono = Font.system(size: PaneTypeScale.rowSecondary, design: .monospaced)
    /// A group header's label.
    static let group = Font.system(size: PaneTypeScale.groupLabel, weight: .semibold)
    /// A count: digits that do not jitter as they change.
    static let count = Font.system(size: PaneTypeScale.groupLabel, weight: .semibold).monospacedDigit()
    /// A button's label.
    static let action = Font.system(size: PaneTypeScale.action, weight: .medium)
    /// Text inside the filter field.
    static let field = Font.system(size: PaneTypeScale.field)
    static let emptyHeadline = Font.system(size: PaneTypeScale.emptyHeadline, weight: .medium)
    static let hint = Font.system(size: PaneTypeScale.emptyHint)
}

enum PaneSpace {
    static let hairline = CGFloat(PaneSpacing.hairline)
    static let tight = CGFloat(PaneSpacing.tight)
    static let compact = CGFloat(PaneSpacing.compact)
    static let standard = CGFloat(PaneSpacing.standard)
    /// The left and right edge of a header, a group header and a row.
    static let gutter = CGFloat(PaneSpacing.gutter)
    static let section = CGFloat(PaneSpacing.section)
    static let roomy = CGFloat(PaneSpacing.roomy)
    /// A row's smallest height: the pointer target, with one line of text.
    static let rowMinHeight: CGFloat = 26
}

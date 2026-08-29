import AppKit
import SwiftUI

/// Flat, minimal shell palette (Antigravity-redesign pass, roadmap
/// 2026-08-29). Fixed per appearance rather than derived from the system
/// window/accent colors the rest of AppKit uses — that's what makes system
/// chrome look "adaptive" instead of deliberately designed. Adaptive across
/// light/dark via the same `NSColor(name:dynamicProvider:)` mechanism every
/// system semantic color (`.windowBackgroundColor` etc.) uses internally, so
/// it tracks `preferredColorScheme` / system appearance the same way.
///
/// The dark values are sampled from Antigravity's own chrome: sidebar
/// `#181818`, editor `#1F1F1F`. The key design property is that these are
/// CLOSE — the eye separates regions by hairline borders, not by fill
/// contrast. The first cut of this file used `#0D0D0F` / `#111113`, which
/// read as "very dark and weird" precisely because it over-separated.
enum MarvinTheme {
    /// Sidebar / rail / chrome-strip fill — the darker of the two surfaces.
    static let background = Color(nsColor: backgroundNSColor)
    /// Same fill as `NSColor`, for AppKit-level hooks (`NSWindow.backgroundColor`
    /// so live split-view resizes never expose the system window fill).
    static let backgroundNSColor = adaptiveNS(dark: "181818", light: "F3F3F3")
    /// Editor / chat / content fill — very slightly lighter than
    /// `background`. Every "content" region (file viewer body, chat
    /// messages, code blocks) sits on this.
    static let panel = adaptive(dark: "1F1F1F", light: "FFFFFF")
    /// One step above `panel` — used for inset surfaces on the content
    /// (code blocks, the input box, cards) so they lift very slightly.
    static let elevated = Color(nsColor: elevatedNSColor)
    /// Same, as `NSColor` — the hover tooltip is an AppKit panel.
    static let elevatedNSColor = adaptiveNS(dark: "262626", light: "F7F7F7")
    /// Hairline divider / border color. Low-contrast on purpose.
    static let border = Color(nsColor: borderNSColor)
    /// Same, as `NSColor` — the split-view divider is drawn with AppKit.
    static let borderNSColor = adaptiveNS(dark: "2B2B2B", light: "E5E5E5")
    /// Primary text.
    static let textPrimary = Color(nsColor: textPrimaryNSColor)  // VS Code editor fg
    /// Same, as `NSColor` — for AppKit-drawn surfaces (the hover tooltip).
    static let textPrimaryNSColor = adaptiveNS(dark: "D4D4D4", light: "1F1F1F")
    /// Secondary / caption text.
    static let textMuted = adaptive(dark: "9D9D9D", light: "6E6E6E")
    /// Selection / hover fill on rows.
    static let rowSelected = adaptive(dark: "37373D", light: "E4E6F1")
    static let rowHover = adaptive(dark: "2A2D2E", light: "F0F0F0")

    /// The one shared timing curve for pane show/hide, tab switches, and
    /// state changes that used to snap. Antigravity's transitions are
    /// short and unfussy — a 180ms ease-out reads as "smooth" without
    /// ever feeling like the app is waiting on itself.
    static let transition: Animation = .easeOut(duration: 0.18)

    /// Height of a pane's title row (the "agri-saas-platform" strip above the
    /// file tree). Shared with the activity rail so its first icon centres on
    /// the row, the way VS Code / Antigravity line the two up — the user read
    /// an 8pt rail offset against a 38pt header as "buttons not aligned to the
    /// top bar" (2026-08-29).
    static let paneHeaderHeight: CGFloat = 38

    private static func adaptive(dark: String, light: String) -> Color {
        Color(nsColor: adaptiveNS(dark: dark, light: light))
    }

    private static func adaptiveNS(dark: String, light: String) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }
}

private extension NSColor {
    /// Minimal 6-digit hex parser — only what MarvinTheme's literals need.
    convenience init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = CGFloat((v >> 16) & 0xFF) / 255
        let g = CGFloat((v >> 8) & 0xFF) / 255
        let b = CGFloat(v & 0xFF) / 255
        self.init(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}

/// Hairline separator in the MARVIN palette.
///
/// SwiftUI's `Divider()` paints `NSColor.separatorColor` — a translucent white
/// in dark mode that reads noticeably LIGHTER than the `MarvinTheme.border`
/// hairlines drawn by hand, and lighter again than the near-black AppKit
/// split-view divider. Three separator colours in one window was the
/// "some are black, some are grey" report of 2026-08-29.
///
/// Wrapping rather than replacing `Divider` keeps its one genuinely useful
/// behaviour: it is orientation-aware, drawing horizontally inside a `VStack`
/// and vertically inside an `HStack`. A fixed-size `Rectangle` would have to
/// pick one and be wrong half the time.
struct MarvinDivider: View {
    var body: some View {
        Divider().overlay(MarvinTheme.border)
    }
}

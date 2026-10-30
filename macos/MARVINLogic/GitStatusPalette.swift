// GitStatusPalette — the git decoration colours, per appearance, and the
// contrast arithmetic that holds them honest (audit L4).
//
// One RGB per status served both appearances. On a dark surface that is fine
// (added 8.75:1, modified 9.40:1); on white as file-name text it was not
// (added 1.88:1, modified 1.75:1, deleted 3.97:1). The dark values below are
// the ones that shipped, unchanged. The light values keep each hue and
// saturation and lower the lightness until the colour reaches 4.5:1 on the
// worst light surface it can sit on (row-selected `#E4E6F1`); the test pins that.

import Foundation

public enum GitStatusPalette {
    public static let addedDark = "6BD18F"
    public static let modifiedDark = "E8BD78"
    public static let deletedDark = "D95440"

    public static let addedLight = "257641"
    public static let modifiedLight = "8B5E18"
    public static let deletedLight = "BC3925"
}

/// WCAG 2.x contrast, on `RRGGBB` hex strings.
public enum ContrastRatio {
    private static func channels(_ hex: String) -> (Double, Double, Double) {
        let v = UInt32(hex, radix: 16) ?? 0
        return (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
    }

    private static func luminance(_ hex: String) -> Double {
        func lin(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let (r, g, b) = channels(hex)
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    public static func ratio(_ a: String, _ b: String) -> Double {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// Hue in degrees, 0..<360.
    public static func hue(_ hex: String) -> Double {
        let (r, g, b) = channels(hex)
        let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
        guard d > 0 else { return 0 }
        var h: Double
        if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
        else if mx == g { h = (b - r) / d + 2 }
        else { h = (r - g) / d + 4 }
        h *= 60
        return h < 0 ? h + 360 : h
    }
}

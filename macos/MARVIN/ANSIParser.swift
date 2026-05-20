// ANSIParser — parse ANSI SGR (Select Graphic Rendition) escape
// sequences from terminal output into an AttributedString that
// SwiftUI's `Text(AttributedString)` renders with per-character
// foreground / background / weight / italic / underline attributes.
//
// Scope:
//   • CSI SGR sequences (`ESC [ … m`) — colour, weight, italic,
//     underline, reset, default-fg/bg.
//   • CSI non-SGR sequences (cursor moves, erase line, etc.) —
//     stripped silently. We don't render in a terminal grid, so
//     they have no meaningful effect.
//   • OSC sequences (`ESC ] … BEL` / `ESC ] … ESC \`) — stripped.
//     Window titles, hyperlinks, etc. Not relevant to our pane.
//   • Colour modes:
//     – 8-colour: codes 30-37 (fg), 40-47 (bg)
//     – 16-colour bright: codes 90-97 (fg bright), 100-107 (bg bright)
//     – 256-colour: 38;5;N / 48;5;N
//     – Truecolour: 38;2;R;G;B / 48;2;R;G;B
//
// Anti-scope:
//   • DEC private sequences (`ESC [ ? … h/l`) — stripped silently.
//   • Tab expansion, line wrapping — caller's job; we emit one
//     line's worth of attributed text per call.
//   • Cursor positioning — we're a streaming-text pane, not a grid.
//
// Used by TerminalPaneView's `lineView` to render command output.
// Pure value-type API (no @MainActor isolation, no UI dep) so it
// can be unit-tested independently from a SwiftUI view tree if
// MARVINTests ever picks it up.

import AppKit
import SwiftUI

enum ANSIParser {
    /// Parse `text` (one line of terminal output) into an
    /// AttributedString. `defaultColor` is the base foreground colour
    /// the caller wants when no ANSI fg colour is active — for example,
    /// stderr lines may pass `.red` so untinted segments still read as
    /// errors.
    static func parse(_ text: String, defaultColor: Color) -> AttributedString {
        var out = AttributedString("")
        var state = SGRState()

        // Walk the input as a UTF-8 byte stream. SwiftUI's Text +
        // AttributedString preserves UTF-8 grapheme clusters; we only
        // care about ESC (0x1B) as the trigger byte so a byte walk is
        // safe for ASCII-keyed escape sequences mixed with arbitrary
        // UTF-8 payload text.
        var i = text.startIndex
        var runStart = text.startIndex

        func flushRun(upTo end: String.Index) {
            guard end > runStart else { return }
            let chunk = String(text[runStart..<end])
            var piece = AttributedString(chunk)
            piece.foregroundColor = state.foreground ?? defaultColor
            if let bg = state.background {
                piece.backgroundColor = bg
            }
            if state.bold { piece.font = .system(size: 12, weight: .bold, design: .monospaced) }
            if state.italic { piece.font = (piece.font ?? .system(size: 12, design: .monospaced)).italic() }
            if state.underline { piece.underlineStyle = .single }
            out.append(piece)
        }

        while i < text.endIndex {
            let ch = text[i]
            // ESC = 0x1B. Could be CSI (ESC [) or OSC (ESC ]) or other.
            if ch == "\u{001B}" {
                flushRun(upTo: i)
                let next = text.index(after: i)
                if next >= text.endIndex {
                    // Stray ESC at end of line — drop it.
                    runStart = text.endIndex
                    i = text.endIndex
                    break
                }
                let intro = text[next]
                if intro == "[" {
                    // CSI: ESC [ … <final-byte>
                    // final-byte is in the range 0x40..0x7E
                    var cur = text.index(after: next)
                    while cur < text.endIndex {
                        let b = text[cur]
                        // Per VT100 spec: parameter bytes 0x30-0x3F,
                        // intermediate bytes 0x20-0x2F, final byte
                        // 0x40-0x7E. Stop at the final byte.
                        if let asciiByte = b.asciiValue, asciiByte >= 0x40, asciiByte <= 0x7E {
                            // We have ESC [ params <final>. Decode if SGR.
                            let paramText = text[text.index(after: next)..<cur]
                            if b == "m" {
                                // SGR — update state.
                                state.apply(paramString: String(paramText))
                            }
                            // Non-SGR CSI: discarded. Cursor movement,
                            // erase line, scroll region, etc.
                            cur = text.index(after: cur)
                            break
                        }
                        cur = text.index(after: cur)
                    }
                    runStart = cur
                    i = cur
                    continue
                } else if intro == "]" {
                    // OSC: ESC ] … <terminator>
                    // Terminator is BEL (0x07) or ST (ESC \).
                    var cur = text.index(after: next)
                    while cur < text.endIndex {
                        let b = text[cur]
                        if b == "\u{0007}" {
                            cur = text.index(after: cur)
                            break
                        }
                        if b == "\u{001B}" {
                            // ESC \ — string terminator
                            let after = text.index(after: cur)
                            if after < text.endIndex, text[after] == "\\" {
                                cur = text.index(after: after)
                                break
                            }
                        }
                        cur = text.index(after: cur)
                    }
                    runStart = cur
                    i = cur
                    continue
                } else {
                    // Other ESC-prefixed (CHARSET designation, single
                    // shift, etc.) — drop the ESC + one following byte.
                    let drop = text.index(after: next)
                    runStart = drop
                    i = drop
                    continue
                }
            }
            i = text.index(after: i)
        }
        // Flush trailing run.
        flushRun(upTo: text.endIndex)
        return out
    }
}

// MARK: - SGRState

/// Running SGR state. Updated by `apply(paramString:)` when we hit
/// an `ESC [ … m` sequence; queried by the parser when it emits a
/// text run between escapes.
private struct SGRState {
    var foreground: Color? = nil
    var background: Color? = nil
    var bold = false
    var italic = false
    var underline = false

    /// Apply one SGR sequence's semicolon-separated parameter list.
    /// Empty param ("ESC [ m") means reset, per ECMA-48.
    mutating func apply(paramString: String) {
        let raw = paramString.isEmpty ? "0" : paramString
        let codes = raw.split(separator: ";").map { Int($0) ?? 0 }
        var i = 0
        while i < codes.count {
            let code = codes[i]
            switch code {
            case 0: // reset
                foreground = nil
                background = nil
                bold = false
                italic = false
                underline = false
            case 1: bold = true
            case 3: italic = true
            case 4: underline = true
            case 22: bold = false
            case 23: italic = false
            case 24: underline = false
            case 30...37: // standard fg
                foreground = Self.standardColor(code - 30, bright: false)
            case 39: foreground = nil // default fg
            case 40...47: // standard bg
                background = Self.standardColor(code - 40, bright: false)
            case 49: background = nil // default bg
            case 90...97: // bright fg
                foreground = Self.standardColor(code - 90, bright: true)
            case 100...107: // bright bg
                background = Self.standardColor(code - 100, bright: true)
            case 38, 48:
                // Extended colour. Next code says which mode:
                //   2 → R; G; B (truecolour, 3 params)
                //   5 → N      (256-palette index, 1 param)
                guard i + 1 < codes.count else { i += 1; continue }
                let mode = codes[i + 1]
                if mode == 2, i + 4 < codes.count {
                    let r = clamp8(codes[i + 2])
                    let g = clamp8(codes[i + 3])
                    let b = clamp8(codes[i + 4])
                    let c = Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
                    if code == 38 { foreground = c } else { background = c }
                    i += 4
                } else if mode == 5, i + 2 < codes.count {
                    let idx = codes[i + 2]
                    let c = Self.palette256Color(idx)
                    if code == 38 { foreground = c } else { background = c }
                    i += 2
                } else {
                    i += 1 // malformed — skip the mode byte and move on
                }
            default:
                // Bold-off (21), reverse-video (7/27), strike (9/29),
                // blink (5/25), faint (2), etc. — silently ignored.
                break
            }
            i += 1
        }
    }

    /// 8/16-colour palette. Tuned for both light and dark mode so
    /// stderr output stays legible against either background.
    /// Values are taken from the "VS Code default dark+" theme so
    /// they feel familiar to anyone who's used that palette.
    static func standardColor(_ index: Int, bright: Bool) -> Color {
        // 0 black, 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 7 white
        if bright {
            switch index {
            case 0: return Color(.sRGB, red: 0.40, green: 0.40, blue: 0.40)
            case 1: return Color(.sRGB, red: 1.00, green: 0.40, blue: 0.40)
            case 2: return Color(.sRGB, red: 0.40, green: 0.85, blue: 0.40)
            case 3: return Color(.sRGB, red: 1.00, green: 0.90, blue: 0.40)
            case 4: return Color(.sRGB, red: 0.40, green: 0.60, blue: 1.00)
            case 5: return Color(.sRGB, red: 1.00, green: 0.50, blue: 1.00)
            case 6: return Color(.sRGB, red: 0.40, green: 0.90, blue: 0.90)
            case 7: return Color(.sRGB, red: 1.00, green: 1.00, blue: 1.00)
            default: return .primary
            }
        } else {
            switch index {
            case 0: return Color(.sRGB, red: 0.20, green: 0.20, blue: 0.20)
            case 1: return Color(.sRGB, red: 0.80, green: 0.20, blue: 0.20)
            case 2: return Color(.sRGB, red: 0.20, green: 0.65, blue: 0.30)
            case 3: return Color(.sRGB, red: 0.80, green: 0.70, blue: 0.20)
            case 4: return Color(.sRGB, red: 0.20, green: 0.45, blue: 0.85)
            case 5: return Color(.sRGB, red: 0.75, green: 0.30, blue: 0.75)
            case 6: return Color(.sRGB, red: 0.20, green: 0.65, blue: 0.70)
            case 7: return Color(.sRGB, red: 0.75, green: 0.75, blue: 0.75)
            default: return .primary
            }
        }
    }

    /// 256-colour palette. The first 16 are the standard set above;
    /// 16..231 is the 6×6×6 RGB cube; 232..255 is a 24-step greyscale
    /// ramp. Standard mapping from the xterm spec.
    static func palette256Color(_ index: Int) -> Color {
        if index < 0 || index > 255 { return .primary }
        if index < 8 {
            return standardColor(index, bright: false)
        }
        if index < 16 {
            return standardColor(index - 8, bright: true)
        }
        if index < 232 {
            // 6×6×6 cube: idx = 16 + 36r + 6g + b, each in 0..5
            let n = index - 16
            let r = (n / 36) % 6
            let g = (n / 6) % 6
            let b = n % 6
            // xterm uses these 6 ramp values: 0, 95, 135, 175, 215, 255
            let ramp = [0.0, 95.0/255, 135.0/255, 175.0/255, 215.0/255, 1.0]
            return Color(.sRGB, red: ramp[r], green: ramp[g], blue: ramp[b])
        }
        // Greyscale ramp: 24 steps from 8 to 238 in increments of 10.
        let n = index - 232
        let level = (8.0 + 10.0 * Double(n)) / 255.0
        return Color(.sRGB, red: level, green: level, blue: level)
    }
}

private func clamp8(_ v: Int) -> Int { max(0, min(255, v)) }

// SymbolsIcon — file and folder glyphs from the Symbols icon theme.
//
// ## Why this replaced the Seti port
//
// MARVIN shipped a hand-drawn approximation of VS Code's **Seti** theme on the
// assumption that Antigravity — a VS Code fork — used the stock default. It
// doesn't. Antigravity bundles **Symbols** (Miguel Solorio, MIT) and ships it
// as the default icon theme, and the two differ in the exact places the user
// kept pointing at (2026-08-29):
//
//   * Seti has **no folder icons at all** (`vs-seti-icon-theme.json` has no
//     `folder` key). Symbols has 72, keyed by folder NAME — `docs`, `apps`,
//     `scripts`, `.github` each get their own glyph. That is the "their
//     directories have also something else" in the side-by-side.
//   * Coverage: 1237 mappings (380 extensions + 649 filenames + 102 language
//     ids + 106 folder names) against the 60 hand-drawn SVGs the Seti port
//     had, which is why `.gitlab-ci.yml` and friends fell through to a blank
//     SF Symbol.
//
// The assets are vendored verbatim from the installed Antigravity bundle into
// `Resources/Symbols/{files,folders}` (LICENSE.md alongside); the lookup
// tables are generated into `SymbolsIconMap.swift` by
// `scripts/generate-symbols-icon-map.py`. Colours are baked into each SVG, so
// there is no palette table here and no tinting at the call site — except for
// directories, where the git-decoration tint still wins (see FileTreeView).
//
// Resolution order mirrors the theme spec: exact filename → longest matching
// extension → language id → default.

import AppKit
import Foundation

enum SymbolsIcon {
    private static var cache: [String: NSImage] = [:]
    private static let missing = NSImage()  // sentinel for "looked, not found"

    /// Glyph for a path, rasterised at `size` points. Returns `nil` only when
    /// the asset is missing from the bundle — the theme itself always
    /// resolves, via `document` / `folder`.
    ///
    /// The `size` is not cosmetic. An `NSImage` backed by an SVG re-renders
    /// the vector EVERY time it is drawn at a size it has no cached rep for,
    /// and a `LazyVStack` of file rows redraws all of them on every frame of a
    /// live pane resize — 40 vector rasterisations per frame, which is what
    /// made dragging the left split stutter while the (Metal-backed) right
    /// split stayed fluid. Rasterising once per (icon, size) and handing
    /// SwiftUI a bitmap turns that into a blit.
    static func image(forPath path: String, isDirectory: Bool, size: CGFloat) -> NSImage? {
        let name = (path as NSString).lastPathComponent
        guard let rel = isDirectory ? folderIcon(for: name) : fileIcon(for: name) else { return nil }
        return raster(rel, size: size)
    }

    /// Folder-name lookup, lowercased, falling back to the generic folder.
    static func folderIcon(for name: String) -> String? {
        SymbolsIconMap.byFolderName[name.lowercased()] ?? SymbolsIconMap.defaultFolder
    }

    /// Filename → glyph, following the theme's own precedence.
    ///
    /// Extensions are matched LONGEST-FIRST because the theme keys multi-part
    /// extensions (`test.ts`, `d.ts`, `config.js`) alongside single ones, and
    /// `foo.test.ts` must not resolve as a plain `ts`.
    static func fileIcon(for name: String) -> String? {
        let lower = name.lowercased()
        if let exact = SymbolsIconMap.byFileName[lower] { return exact }

        let parts = lower.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count > 1 {
            // "a.b.c.ts" → try "b.c.ts", then "c.ts", then "ts".
            for start in 1..<parts.count {
                let candidate = parts[start...].joined(separator: ".")
                if let hit = SymbolsIconMap.byExtension[candidate] { return hit }
            }
        }
        // A dotfile with no extension ("`.gitignore`" when the exact table
        // misses) reads as a language id in the theme more often than not.
        if let lang = SymbolsIconMap.byLanguageId[lower.hasPrefix(".") ? String(lower.dropFirst()) : lower] {
            return lang
        }
        return SymbolsIconMap.defaultFile
    }

    /// Bitmap of `rel` at `size` points, memoised per (icon, size).
    ///
    /// Drawn into an explicit `NSBitmapImageRep` at the display's backing
    /// scale rather than via `lockFocus`, which would inherit whatever scale
    /// the current graphics context happens to have — nil on a background
    /// thread, 1x during some AppKit passes, so the glyph would come out soft
    /// on Retina.
    private static func raster(_ rel: String, size: CGFloat) -> NSImage? {
        let key = "\(rel)@\(size)"
        if let hit = cache[key] { return hit === missing ? nil : hit }
        guard let src = load(rel) else {
            cache[key] = missing
            return nil
        }
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let points = NSSize(width: size, height: size)
        let pixels = Int((size * scale).rounded())
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return src }
        rep.size = points
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        src.draw(in: NSRect(origin: .zero, size: points))
        NSGraphicsContext.restoreGraphicsState()
        let out = NSImage(size: points)
        out.addRepresentation(rep)
        cache[key] = out
        return out
    }

    /// `files/yaml` → `Resources/Symbols/files/yaml.svg`, memoised.
    ///
    /// The bundle layout is preserved (a folder reference, not the flattened
    /// copy the other resources get) because `files/` and `folders/` both
    /// contain a `folder.svg` — flattening would silently drop one of them.
    private static func load(_ rel: String) -> NSImage? {
        if let hit = cache[rel] { return hit === missing ? nil : hit }
        let dir = (rel as NSString).deletingLastPathComponent      // files | folders
        let base = (rel as NSString).lastPathComponent
        guard let url = Bundle.main.url(
                  forResource: base, withExtension: "svg", subdirectory: "Symbols/\(dir)"
              ),
              let img = NSImage(contentsOf: url)
        else {
            cache[rel] = missing
            return nil
        }
        img.isTemplate = false
        cache[rel] = img
        return img
    }
}

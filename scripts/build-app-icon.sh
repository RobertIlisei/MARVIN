#!/usr/bin/env bash
# Renders apps/macos/MARVIN/Resources/marvin-app.svg into a macOS
# .icns (AppIcon) using a tiny Swift program that drives NSImage's
# native SVG support (macOS 12+). Output is written to:
#
#   apps/macos/MARVIN/Resources/AppIcon.icns
#
# Run after touching marvin-app.svg. The .icns is checked in so a
# fresh clone doesn't need to re-render on every build.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$REPO_ROOT/apps/macos/MARVIN/Resources/marvin-app.svg"
OUT_ICNS="$REPO_ROOT/apps/macos/MARVIN/Resources/AppIcon.icns"
TMP="$(mktemp -d -t marvin-icon)"
ICONSET="$TMP/AppIcon.iconset"

if [ ! -f "$SVG" ]; then
  echo "missing $SVG" >&2
  exit 1
fi

mkdir -p "$ICONSET"

# Tiny Swift renderer — loads the SVG as an NSImage and rasterises
# at the requested pixel size into a PNG. NSImage gained vector SVG
# support on macOS 12; we lock the deployment target there.
cat > "$TMP/render.swift" <<'SWIFT'
import AppKit

guard CommandLine.arguments.count == 4 else {
  FileHandle.standardError.write("usage: render <svg> <size> <png>\n".data(using: .utf8)!)
  exit(2)
}
let svgPath = CommandLine.arguments[1]
guard let size = Int(CommandLine.arguments[2]), size > 0 else { exit(2) }
let outPath = CommandLine.arguments[3]

guard let img = NSImage(contentsOfFile: svgPath) else {
  FileHandle.standardError.write("failed to load \(svgPath)\n".data(using: .utf8)!)
  exit(1)
}

let pixel = NSSize(width: size, height: size)
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: size, pixelsHigh: size,
  bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = pixel

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.setFill()
NSRect(origin: .zero, size: pixel).fill()
img.draw(in: NSRect(origin: .zero, size: pixel),
         from: .zero,
         operation: .sourceOver,
         fraction: 1.0,
         respectFlipped: true,
         hints: [.interpolation: NSImageInterpolation.high])
NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
try data.write(to: URL(fileURLWithPath: outPath))
SWIFT

# Compile once
swiftc -O -o "$TMP/render" "$TMP/render.swift"

# Apple iconset spec — every entry, both 1x and 2x.
render() {
  local size="$1" name="$2"
  "$TMP/render" "$SVG" "$size" "$ICONSET/$name"
}

render   16 icon_16x16.png
render   32 icon_16x16@2x.png
render   32 icon_32x32.png
render   64 icon_32x32@2x.png
render  128 icon_128x128.png
render  256 icon_128x128@2x.png
render  256 icon_256x256.png
render  512 icon_256x256@2x.png
render  512 icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil -c icns -o "$OUT_ICNS" "$ICONSET"

rm -rf "$TMP"

echo "wrote $OUT_ICNS"

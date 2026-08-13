// MarkdownSnapshot — dev-only rasteriser for the chat markdown renderer.
//
// Verifying chat rendering meant asking the user for a screenshot and
// iterating blind, which cost several wrong guesses (a table that looked
// plausible in code drew rows on top of each other). This renders
// `MarkdownView` straight to a PNG with no window, no session, and no scroll
// position, so the layout can be inspected directly.
//
// Entirely inert unless `MARVIN_SNAPSHOT_MD` is set to an output path:
//
//     MARVIN_SNAPSHOT_MD=/tmp/md.png /Applications/MARVIN.app/Contents/MacOS/MARVIN
//
// The app writes the PNG and exits without opening a window.

import AppKit
import SwiftUI

enum MarkdownSnapshot {
    /// Sample exercising every block type, including the shapes that broke:
    /// a multi-column table with a long prose cell, and inline code in prose.
    static let sample = """
    ## Phase 2/3 — Vetted findings

    Some prose with `inline code`, **bold**, *italic*, and a [link](https://x.com).\n\n    MR opened: https://gitlab.com/RobertIlisei/agri-saas-platform/-/merge_requests/112 — see `README.md` and `package.json:1` for context.

    | # | Severity | Category | Location | Finding | Fix summary |
    | --- | --- | --- | --- | --- | --- |
    | 1 | HIGH | Purpose & frequency / Physicality | `login.tsx:61-69` | Primary "Continuă cu AgriCore ID" button — the one element every session requires clicking — has no `hover`, `active`, or `focus-visible` state at all | Add `transition-colors hover:opacity-90 active:scale-[0.97] focus-visible:ring-2`, transform-only, ~160ms |
    | 2 | MEDIUM | Cohesion & tokens | `Button.tsx:66-71` | Shared `Button` primitive has `transition-colors` + focus ring but no `active:scale` in any variant | Add `active:scale-[0.97]` + transform transition to `baseClass` so every `Button` inherits it |
    | 3 | LOW | Cohesion & tokens | `tailwind.css` | Zero custom easing tokens exist; STANDARDS.md flags built-in CSS easings as "too weak" | Optional: introduce one `--ease-out-strong` token |

    ### Missed opportunities

    - The hero copy on `/login` never enters — a 200-250ms fade would read as intentional.
    - The testimonial block could get a 30-80ms stagger on first paint.

    1. First ordered item
    2. Second ordered item

    > A blockquote line.

    ```swift
    let x = 1
    func greet(_ name: String) -> String { "hi \\(name)" }
    ```

    ---
    """

    /// Render width, overridable via `MARVIN_SNAPSHOT_W` so narrow-panel
    /// reflow can be checked, not just the roomy case.
    static var renderWidth: CGFloat {
        if let raw = ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_W"],
           let v = Double(raw), v > 200 { return CGFloat(v) }
        return 900
    }

    /// Returns true when it handled a snapshot run (caller should exit).
    @MainActor
    static func runIfRequested() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_MD"],
              !path.isEmpty else { return false }

        // Snapshot with a workDir so file-reference linkification is exercised
        // too, not just the block layout.
        // MARVIN_SNAPSHOT_REPEAT=N renders N copies and reports elapsed layout
        // time. Added after RichText.sizeThatFits hung the main thread for 9
        // minutes: rendering has a cost curve now, so it needs a measurement.
        let repeats = ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_REPEAT"]
            .flatMap(Int.init) ?? 1
        let body = repeats > 1
            ? (0..<repeats).map { _ in sample }.joined(separator: "\n\n")
            : sample
        let started = ProcessInfo.processInfo.systemUptime

        let view = MarkdownView(
            text: body,
            fillWidth: true,
            workDir: ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_WORKDIR"]
        )
            .padding(16)
            .frame(width: Self.renderWidth)
            .background(Color(nsColor: .windowBackgroundColor))

        // NOT ImageRenderer: it cannot rasterise NSViewRepresentable content
        // and substitutes an "unsupported view" placeholder, which turned every
        // paragraph into a yellow bar once prose moved to NSTextView. Hosting
        // the view in a real (offscreen) window and asking AppKit to cache its
        // display captures the actual pixel output, subviews included.
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: Self.renderWidth, height: 10)
        host.layoutSubtreeIfNeeded()
        let fitted = host.fittingSize
        host.frame = NSRect(
            x: 0,
            y: 0,
            width: Self.renderWidth,
            height: max(fitted.height, 10)
        )

        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        // Offscreen, but ordered in — an unrendered window caches as blank.
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()

        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            FileHandle.standardError.write(Data("snapshot: no bitmap rep\n".utf8))
            return true
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: NSBitmapImageRep.FileType.png, properties: [:])
        else {
            FileHandle.standardError.write(Data("snapshot: render failed\n".utf8))
            return true
        }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
            print("snapshot written: \(path)")
            print(String(format: "layout+render: %.0f ms for %d copies", elapsed, repeats))
        } catch {
            FileHandle.standardError.write(Data("snapshot: \(error)\n".utf8))
        }
        return true
    }
}

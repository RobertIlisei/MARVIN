// LayoutOscillationProbe — names the view whose size will not settle.
//
// 2026-09-12: MARVIN spun at 100 % on the main thread for ten minutes and
// was force-quit. `sample` showed the loop — SwiftUI's lazy layout
// (`LazyLayoutViewCache.updatePrefetchPhases` ↔ `LazySubviewPlacements.
// updateValue`) re-placing children whose `_FlexFrameLayout` text
// measurement kept changing — and not one MARVIN frame in it. The AppKit
// constraint breaker (ADR-0062) never fired because no constraint pass was
// involved. Reading source produced candidates, not a cause; the rule in
// CLAUDE.md is that after that point you instrument.
//
// This is the instrument. `onGeometryChange` reports a view's size WITHOUT
// inserting a view (the ADR-0062 lesson: AppKit's runaway-pass breaker
// counts passes against the number of views in the window, so a
// `GeometryReader` background can turn a diagnosis into a crash). A label
// whose size changes `threshold` times inside `window` seconds is written
// to the exceptions log with its last sizes, then muted so the log stays
// readable. Attached to the transcript stack, each transcript row, and the
// Sessions pane list — the lazy stacks the sample's shape points at.
//
// Cost when nothing oscillates: one dictionary write per genuine size
// change, on the main thread, which is where the change already happened.

import SwiftUI

@MainActor
enum LayoutOscillationProbe {
    private struct Track {
        var count = 0
        var windowStart: TimeInterval = 0
        var recent: [CGSize] = []
        var mutedUntil: TimeInterval = 0
    }

    /// Size changes inside `window` seconds that count as "not settling".
    /// A row re-measured on a resize or a stream of tokens changes a handful
    /// of times a second; a layout loop changes hundreds.
    static let threshold = 40
    static let window: TimeInterval = 1.0
    static let muteFor: TimeInterval = 10.0

    private static var tracks: [String: Track] = [:]

    static func record(_ label: String, size: CGSize) {
        let now = Date().timeIntervalSinceReferenceDate
        var t = tracks[label] ?? Track()
        if now < t.mutedUntil { return }
        if now - t.windowStart > window {
            t.windowStart = now
            t.count = 0
            t.recent.removeAll(keepingCapacity: true)
        }
        t.count += 1
        t.recent.append(size)
        if t.recent.count > 8 { t.recent.removeFirst() }
        if t.count >= threshold {
            let sizes = t.recent.map { "\(Int($0.width))×\(Int($0.height))" }.joined(separator: " ")
            ExceptionLog.appendPublic(
                "\n----- layout oscillation: \(label) — \(t.count) size changes in \(window)s -----\n"
                    + "last sizes: \(sizes)\n"
            )
            t.mutedUntil = now + muteFor
            t.count = 0
            t.recent.removeAll(keepingCapacity: true)
        }
        tracks[label] = t
    }
}

extension View {
    /// Report this view's size changes to `LayoutOscillationProbe` under
    /// `label`. No-op below macOS 15, where `onGeometryChange` does not
    /// exist and the only alternative inserts a view.
    @ViewBuilder
    func layoutOscillationProbe(_ label: String) -> some View {
        if #available(macOS 15.0, *) {
            self.onGeometryChange(for: CGSize.self) { proxy in
                proxy.size
            } action: { size in
                LayoutOscillationProbe.record(label, size: size)
            }
        } else {
            self
        }
    }
}

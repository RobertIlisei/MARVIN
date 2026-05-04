// BrainMetalView — Phase 4c. NSViewRepresentable wrapping MTKView,
// with a minimal clear-color render pass. No particles yet — 4d
// wires shaders + the BrainSimulation buffers from 4b.
//
// ## Why MTKView (not CAMetalLayer directly)
//
// MTKView gives us:
//   - A backing CAMetalLayer + drawable management for free.
//   - `preferredFramesPerSecond` for cadence tuning.
//   - `setNeedsDisplay(_:)` and `isPaused` for pause / resume on
//     visibility change (4h needs these).
//   - Auto-resize handling — `drawableSize` updates on layout, so
//     a HSplitView splitter drag (Phase 3 wiring) routes through
//     MTLLayer's standard sizing path without us tracking
//     NSWindow.frame manually.
// CAMetalLayer would force us to reimplement all five; MTKView is
// the SwiftUI-friendly path. ADR-0019 §5 left this open
// ("compute kernel vs vertex-stage physics") — the layer choice
// itself isn't an open question.
//
// ## Why a separate Window during 4c
//
// Same iteration discipline as Phase 2b and 3b: a half-built
// MTKView shouldn't replace anything in the user's main window
// while we're still figuring out shader pipelines. The
// "Brain (preview)" Window scene gives us a sandboxed surface to
// drive frame-rate measurements, GPU capture in Xcode, and the
// 4d/4e shader iteration. 4g promotes the view into the work-pane
// empty-state once parity with the WebView's <BrainLiquid> lands.

import MetalKit
import SwiftUI

/// MTKView delegate that does a clear-color pass each frame. State-
/// less for now — 4d adds vertex/index buffers, a render pipeline
/// state, and the per-frame uniform writes. Marked `@MainActor`
/// because MTKView dispatches its delegate calls on the main queue
/// already; the explicit annotation keeps Swift 6 strict-concurrency
/// from flagging the cross-isolation hops we don't actually do.
@MainActor
final class BrainMetalRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue

    /// Background colour the clear pass writes. Matches the WebView
    /// brain backdrop — a faint warm-tinted off-black on dark, an
    /// off-white on light. 4f wires the bridge's
    /// preferredColorScheme through this so theme flips re-tint
    /// instantly.
    var clearColor: MTLClearColor

    init?(view: MTKView, clearColor: MTLClearColor) {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else {
            // System has no Metal-capable GPU — caller should fall
            // back to the WebView brain. macOS 14 minimum (ADR-0016
            // §Resolved) means every supported machine has Metal,
            // so this branch is the "ran in a headless test runner"
            // case rather than a real user fallback.
            return nil
        }
        self.device = device
        self.commandQueue = queue
        self.clearColor = clearColor
        super.init()
        view.device = device
        // BGRA8Unorm is the standard drawable format on macOS; matches
        // what every Metal sample uses and keeps colour-space sRGB
        // by default. 4d may switch to BGRA8Unorm_sRGB to opt out
        // of MTLPixelFormat's automatic gamma; defer until shaders
        // exist and we can measure perceived brightness.
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = clearColor
        // 60 fps default — MTKView caps to the display's refresh
        // rate, so on a 120 Hz ProMotion display it'll drive at 120
        // fps, on a 60 Hz external it'll cap at 60. We don't pin
        // because the lab standalone doesn't either.
        view.preferredFramesPerSecond = 60
        // Phase 4c is not animated — the clear pass produces the
        // same colour every frame. `enableSetNeedsDisplay = true`
        // would let us draw on demand and skip 60 redundant frames
        // per second; but 4d/4e need a live loop anyway, so we keep
        // the loop running as the soak test for the Window scene.
        // 4h adds an `isPaused` gate when the window goes occluded.
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        // 4c: nothing to resize. 4d will resize the trail
        // accumulation texture here; 4e will resize compute thread-
        // group dispatch.
    }

    func draw(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let descriptor = view.currentRenderPassDescriptor,
              let buffer = commandQueue.makeCommandBuffer() else {
            return
        }
        // Pin the clear colour each frame — 4f flips this on theme
        // changes and we want the next frame to honour it without
        // a configure callback.
        descriptor.colorAttachments[0].clearColor = clearColor
        descriptor.colorAttachments[0].loadAction = .clear
        descriptor.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            return
        }
        // No draw calls — the load action's clear is the entire
        // pass.
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
    }
}

/// SwiftUI bridge to MTKView. Holds the renderer alive across
/// updates so its device/queue don't churn. The `clearColor`
/// argument lets the parent flip theme without us republishing
/// the whole view (4f's wire path).
struct BrainMetalView: NSViewRepresentable {
    let clearColor: MTLClearColor

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        // Auto-resize with the parent NSView — the SwiftUI frame
        // controls layout, MTKView mirrors via constraints.
        view.translatesAutoresizingMaskIntoConstraints = false
        let renderer = BrainMetalRenderer(view: view, clearColor: clearColor)
        context.coordinator.renderer = renderer
        view.delegate = renderer
        return view
    }

    func updateNSView(_ view: MTKView, context: Context) {
        // Push the latest clear colour onto the renderer; the next
        // frame picks it up. We don't replace the renderer because
        // its device/queue are expensive to rebuild and there's no
        // other state today that needs invalidation.
        context.coordinator.renderer?.clearColor = clearColor
    }

    @MainActor
    final class Coordinator {
        var renderer: BrainMetalRenderer?
    }
}

/// Resolve the bridge's preferred colour scheme to a Metal clear
/// colour matching the WebView brain backdrop. Nil scheme falls
/// through to dark, which is what most users see by default.
@MainActor
func brainClearColor(for scheme: ColorScheme?) -> MTLClearColor {
    switch scheme {
    case .light:
        // Matches the lab's light backdrop — a faint cool grey.
        return MTLClearColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1)
    default:
        // Dark / unset: deep near-black with a hint of warm
        // (matches the design's nebula context).
        return MTLClearColor(red: 0.05, green: 0.06, blue: 0.08, alpha: 1)
    }
}

// MARK: - Preview window

/// Phase 4c dev surface. A standalone Window scene hosting the
/// MTKView so we can iterate on the render pipeline (4d/4e) without
/// disturbing the main window's WebView brain. Retired in 4g once
/// the native renderer reaches parity with the WebView's
/// <BrainLiquid> and the work-pane empty state promotes it inline.
struct BrainPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            BrainMetalView(clearColor: brainClearColor(for: bridge.preferredColorScheme))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 360, idealWidth: 480, minHeight: 360, idealHeight: 480)
        .preferredColorScheme(bridge.preferredColorScheme)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "brain.head.profile")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("Brain — Phase 4 preview")
                    .font(.callout.weight(.semibold))
                Text("clear-pass smoke (4c)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(12)
    }
}

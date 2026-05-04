// BrainMetalView — Phase 4e. NSViewRepresentable wrapping MTKView,
// with the per-frame physics now running on a Metal compute kernel
// (4e) and the render passes carried forward unchanged from 4d.
//
//   per frame:
//     1. simulation.step(commandBuffer:)  — encodes a compute pass
//                                            that integrates +
//                                            projects every active
//                                            particle, writes a
//                                            ParticleInstance per
//                                            iid into instanceBuffer
//     2. accumulation pass                — fade quad
//                                            (rgba(0,0,0, 1-trail))
//                                            + instanced particle
//                                            quads reading from
//                                            instanceBuffer
//     3. composite pass                   — sample accumulation into
//                                            the drawable
//
// 4f wires `bridge.preferredColorScheme` + `bridge.isBusy` through
// into the state machine + palette uniform; 4g promotes the MTKView
// from this preview window into the work-pane empty state of the
// main window. 4h adds reduce-motion + idle frame-throttle +
// occlusion gates.
//
// ## Why one accumulation texture, not ping-pong
//
// ADR-0019 §5 picked single-accumulation as the default. The fade
// quad over a single texture is a one-pass GPU op that mirrors the
// canvas2d original's destination-out + drawDots structure. If
// TBDR-on-Apple-Silicon shows the dest blend as a perf cliff, we
// drop to ping-pong; 4e profiling hasn't measured that yet.
//
// ## Why the simulation is a separate object
//
// BrainGPUSimulation owns 14 MTLBuffers + a compute pipeline + the
// CPU-side rotation / attractor state. Letting BrainMetalRenderer
// own all of that directly bloats the renderer past the comfortable
// SwiftUI-NSViewRepresentable shape. Splitting the responsibilities
// also makes 4e's "60 fps at N=12 000" verifiable without a window
// — a future test could drive `simulation.step(...)` from a unit
// fixture without an MTKView at all.

import MetalKit
import SwiftUI

// MARK: - Renderer

/// MTKView delegate that owns the full 4e pipeline. Marked
/// `@MainActor` because MTKView dispatches `draw(in:)` /
/// `mtkView(_:drawableSizeWillChange:)` on the main queue already.
@MainActor
final class BrainMetalRenderer: NSObject, MTKViewDelegate {
    // MARK: Metal core

    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    /// Compiled at init via `MTLDevice.makeLibrary(source:)` — see
    /// BrainShaders.swift for source. Reused by both this renderer
    /// and the simulation (the kernel pipeline lives on the sim
    /// side).
    private let library: MTLLibrary
    private let particlePipeline: MTLRenderPipelineState
    private let fadePipeline: MTLRenderPipelineState
    private let compositePipeline: MTLRenderPipelineState

    // MARK: Frame state

    /// Trail accumulation texture, sized to the drawable. Rebuilt
    /// on resize. Fade + particle passes write here; composite
    /// pass samples from here.
    private var accumulation: MTLTexture?
    /// Per-frame render-uniform buffer. Single buffer is fine at
    /// 60 fps with the small struct we have; if 4e profiling shows
    /// upload contention, triple-buffer it.
    private let uniformBuffer: MTLBuffer
    /// 4-byte buffer holding the fade alpha for the current frame.
    private let fadeAlphaBuffer: MTLBuffer

    // MARK: Simulation + state machine

    /// GPU-backed physics. Owns the SoA MTLBuffers + compute
    /// pipeline + CPU rotation/attractor state.
    private let simulation: BrainGPUSimulation
    /// 700 ms eased state machine. The renderer reads
    /// `transition.currentProfile(nowMs:)` each frame to drive the
    /// simulation profile + render uniforms.
    private var transition: BrainTransition
    private var lastFrameTimeSec: Double = 0
    /// True once `seedAllParticles` has been called (deferred until
    /// the first frame so the drawable size is known).
    private var seeded = false

    // MARK: Inputs (set by the SwiftUI bridge)

    var preferredColorScheme: ColorScheme? {
        didSet { needsClear = true }
    }
    var brainState: BrainState {
        didSet {
            if brainState != oldValue {
                let nowMs = CACurrentMediaTime() * 1000
                transition.transition(to: brainState, nowMs: nowMs)
                applyFrameRate()
            }
        }
    }
    /// Phase 4h — Reduce Motion accommodation. When true, the
    /// MTKView display link is gated to ~10 fps (matches the TS
    /// version's `prefers-reduced-motion` cadence). Reading
    /// `accessibilityReduceMotion` from SwiftUI's environment is
    /// the source; `BrainMetalView`'s `updateNSView` pushes it in.
    var reduceMotion: Bool = false {
        didSet {
            if reduceMotion != oldValue { applyFrameRate() }
        }
    }
    /// Phase 4h — visibility gate. When true (window minimised /
    /// fully occluded by another window), `MTKView.isPaused` is
    /// set so the display link stops firing — kernel + render
    /// passes go to zero work. dt-on-resume is clamped by the
    /// simulation's existing `min(0.05, …)` so the integrator
    /// doesn't fast-forward by minutes.
    var isOccluded: Bool = false {
        didSet {
            if isOccluded != oldValue { applyVisibility() }
        }
    }

    // MARK: Internal flags

    private var needsClear = true
    /// Held weakly so the perf-control setters can mutate the
    /// view's `preferredFramesPerSecond` / `isPaused` without a
    /// retain cycle (MTKView retains the renderer as its delegate).
    private weak var weakView: MTKView?

    // MARK: Init

    init?(
        view: MTKView,
        initialState: BrainState,
        colorScheme: ColorScheme?
    ) {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else {
            return nil
        }
        self.device = device
        self.commandQueue = queue

        do {
            self.library = try device.makeLibrary(
                source: brainMetalShaderSource,
                options: nil
            )
        } catch {
            NSLog("[BrainMetalRenderer] shader compile failed: \(error)")
            return nil
        }

        view.colorPixelFormat = .bgra8Unorm
        view.device = device

        guard let particle = BrainMetalRenderer.makeParticlePipeline(
            device: device, library: library, format: .bgra8Unorm
        ),
        let fade = BrainMetalRenderer.makeFadePipeline(
            device: device, library: library, format: .bgra8Unorm
        ),
        let composite = BrainMetalRenderer.makeCompositePipeline(
            device: device, library: library, format: .bgra8Unorm
        ) else {
            return nil
        }
        self.particlePipeline = particle
        self.fadePipeline = fade
        self.compositePipeline = composite

        guard let ub = device.makeBuffer(
            length: MemoryLayout<BrainUniforms>.stride,
            options: [.storageModeShared]
        ) else { return nil }
        guard let fb = device.makeBuffer(
            length: MemoryLayout<Float>.stride,
            options: [.storageModeShared]
        ) else { return nil }
        self.uniformBuffer = ub
        self.fadeAlphaBuffer = fb

        guard let sim = BrainGPUSimulation(device: device, library: library) else {
            return nil
        }
        self.simulation = sim
        self.transition = BrainTransition(initialState: initialState)
        self.brainState = initialState
        self.preferredColorScheme = colorScheme

        super.init()
        view.delegate = self
        self.weakView = view
        view.preferredFramesPerSecond = 60
        if let layer = view.layer as? CAMetalLayer {
            // Opaque so the composite pass doesn't mix with window
            // background. NSView's `isOpaque` is read-only on macOS
            // — CAMetalLayer's flag is the toggle Metal honours.
            layer.isOpaque = true
        }
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    }

    // MARK: Perf controls (Phase 4h)

    /// Reset MTKView's display-link cadence based on the three
    /// signals: reduce-motion (10 fps cap, hard accessibility
    /// requirement), idle state (30 fps to save battery — matches
    /// the TS `prefers-reduced-motion`-adjacent throttle), or the
    /// default 60 fps. Call from setters of `reduceMotion` /
    /// `brainState` so the cadence tracks input changes.
    ///
    /// Priority: reduce-motion wins over idle (the user's setting
    /// is more important than the brain's mood). Both are below
    /// 60 fps so a busy state at reduce-motion still reads "calm
    /// motion", not "frozen".
    private func applyFrameRate() {
        guard let view = weakView else { return }
        let target: Int
        if reduceMotion {
            target = 10
        } else if brainState == .idle {
            target = 30
        } else {
            target = 60
        }
        if view.preferredFramesPerSecond != target {
            view.preferredFramesPerSecond = target
        }
    }

    /// Pause / resume the display link based on window visibility.
    /// `MTKView.isPaused = true` stops the underlying CADisplayLink
    /// — `draw(in:)` doesn't fire, the kernel doesn't run, the
    /// simulation freezes. Resume is instant (one frame of catch-
    /// up; physics doesn't fast-forward thanks to the dt clamp).
    private func applyVisibility() {
        guard let view = weakView else { return }
        view.isPaused = isOccluded
    }

    private static func makeParticlePipeline(
        device: MTLDevice, library: MTLLibrary, format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_particle_vs"),
              let fs = library.makeFunction(name: "brain_particle_fs") else { return nil }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        desc.colorAttachments[0].isBlendingEnabled = true
        desc.colorAttachments[0].rgbBlendOperation = .add
        desc.colorAttachments[0].alphaBlendOperation = .add
        desc.colorAttachments[0].sourceRGBBlendFactor = .one
        desc.colorAttachments[0].sourceAlphaBlendFactor = .one
        desc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        desc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        return try? device.makeRenderPipelineState(descriptor: desc)
    }

    private static func makeFadePipeline(
        device: MTLDevice, library: MTLLibrary, format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_full_vs"),
              let fs = library.makeFunction(name: "brain_fade_fs") else { return nil }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        desc.colorAttachments[0].isBlendingEnabled = true
        desc.colorAttachments[0].rgbBlendOperation = .add
        desc.colorAttachments[0].alphaBlendOperation = .add
        desc.colorAttachments[0].sourceRGBBlendFactor = .one
        desc.colorAttachments[0].sourceAlphaBlendFactor = .one
        desc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        desc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        return try? device.makeRenderPipelineState(descriptor: desc)
    }

    private static func makeCompositePipeline(
        device: MTLDevice, library: MTLLibrary, format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_full_vs"),
              let fs = library.makeFunction(name: "brain_composite_fs") else { return nil }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        desc.colorAttachments[0].isBlendingEnabled = false
        return try? device.makeRenderPipelineState(descriptor: desc)
    }

    // MARK: MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        rebuildAccumulation(width: Int(size.width), height: Int(size.height))
        needsClear = true
    }

    func draw(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let descriptor = view.currentRenderPassDescriptor,
              let buffer = commandQueue.makeCommandBuffer() else {
            return
        }

        let drawableW = Float(drawable.texture.width)
        let drawableH = Float(drawable.texture.height)
        let sphereRadius = min(drawableW, drawableH) / 3.0

        if !seeded {
            simulation.seedAllParticles(
                profile: BrainProfile.profile(for: brainState),
                sphereRadius: sphereRadius
            )
            seeded = true
        }

        if accumulation == nil
            || accumulation?.width != drawable.texture.width
            || accumulation?.height != drawable.texture.height {
            rebuildAccumulation(
                width: drawable.texture.width,
                height: drawable.texture.height
            )
            needsClear = true
        }
        guard let accumulation else { return }

        let nowSec = CACurrentMediaTime()
        let dt: Double = lastFrameTimeSec == 0
            ? 1.0 / 60.0
            : max(0, nowSec - lastFrameTimeSec)
        lastFrameTimeSec = nowSec
        let nowMs = nowSec * 1000

        let profile = transition.currentProfile(nowMs: nowMs)

        // ─── Compute pass: physics + projection ───
        let slice = simulation.step(
            commandBuffer: buffer,
            dt: dt,
            profile: profile,
            sphereRadius: sphereRadius,
            drawableSize: SIMD2<Float>(drawableW, drawableH)
        )

        // Render-time uniforms (palette, mode, dotR/dotA, redMix,
        // pulse — all the stuff the kernel doesn't need).
        uploadUniforms(
            profile: profile,
            viewportPx: SIMD2<Float>(drawableW, drawableH)
        )

        // ─── Pass 1: accumulation (fade + particles) ───
        let accDesc = MTLRenderPassDescriptor()
        accDesc.colorAttachments[0].texture = accumulation
        accDesc.colorAttachments[0].loadAction = needsClear ? .clear : .load
        accDesc.colorAttachments[0].storeAction = .store
        accDesc.colorAttachments[0].clearColor = MTLClearColor(
            red: 0, green: 0, blue: 0, alpha: 1
        )
        if let acc = buffer.makeRenderCommandEncoder(descriptor: accDesc) {
            // Fade: rgba(0, 0, 0, 1 - profile.trail). Higher trail
            // → smaller fade alpha → longer trails. Clamp at 0.99
            // (matches `effTrail = Math.min(0.99, p.trail)` in TS)
            // so a 1.0 slider doesn't freeze the trail forever.
            let effTrail = min(0.99, max(0, profile.trail))
            var fadeAlpha = Float(1.0 - effTrail)
            memcpy(
                fadeAlphaBuffer.contents(), &fadeAlpha,
                MemoryLayout<Float>.stride
            )
            acc.setRenderPipelineState(fadePipeline)
            acc.setFragmentBuffer(fadeAlphaBuffer, offset: 0, index: 0)
            acc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)

            // Particles. The kernel populated `instanceBuffer` in
            // the compute pass above; the vertex shader reads it
            // verbatim via instance_id.
            if slice.count > 0 {
                acc.setRenderPipelineState(particlePipeline)
                acc.setVertexBuffer(simulation.instanceBuffer, offset: 0, index: 0)
                acc.setVertexBuffer(uniformBuffer, offset: 0, index: 1)
                acc.setFragmentBuffer(uniformBuffer, offset: 0, index: 0)
                acc.drawPrimitives(
                    type: .triangle,
                    vertexStart: 0,
                    vertexCount: 6,
                    instanceCount: slice.count
                )
            }
            acc.endEncoding()
        }
        needsClear = false

        // ─── Pass 2: composite to drawable ───
        descriptor.colorAttachments[0].loadAction = .dontCare
        descriptor.colorAttachments[0].storeAction = .store
        if let comp = buffer.makeRenderCommandEncoder(descriptor: descriptor) {
            comp.setRenderPipelineState(compositePipeline)
            comp.setFragmentTexture(accumulation, index: 0)
            comp.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
            comp.endEncoding()
        }

        buffer.present(drawable)
        buffer.commit()
    }

    // MARK: Helpers

    private func rebuildAccumulation(width: Int, height: Int) {
        guard width > 0, height > 0 else { return }
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        desc.usage = [.renderTarget, .shaderRead]
        desc.storageMode = .private
        accumulation = device.makeTexture(descriptor: desc)
    }

    private func uploadUniforms(profile: BrainProfile, viewportPx: SIMD2<Float>) {
        let palette: Int32 = (preferredColorScheme == .light) ? 0 : 1
        let mode: Int32
        switch brainState {
        case .idle:  mode = 1
        case .error: mode = 2
        default:     mode = 0
        }
        var u = BrainUniforms(
            viewportPx: viewportPx,
            dotR: profile.dotR,
            dotA: profile.dotA,
            dim: profile.dim,
            chroma: profile.chroma,
            redMix: profile.redMix,
            dens: profile.dens,
            pulse: profile.pulse,
            palette: palette,
            mode: mode
        )
        memcpy(uniformBuffer.contents(), &u, MemoryLayout<BrainUniforms>.stride)
    }
}

// MARK: - SwiftUI bridge

/// SwiftUI bridge to MTKView. Holds the renderer alive across
/// updates so its device/queue/library don't churn. State, scheme,
/// reduce-motion, and the occlusion flag flow in via `updateNSView`.
/// The Coordinator owns the NSWindow occlusion observer so the
/// listener tracks the actual hosting window rather than a global
/// app-wide proxy.
struct BrainMetalView: NSViewRepresentable {
    let state: BrainState
    let colorScheme: ColorScheme?
    let reduceMotion: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.translatesAutoresizingMaskIntoConstraints = false
        let renderer = BrainMetalRenderer(
            view: view,
            initialState: state,
            colorScheme: colorScheme
        )
        renderer?.reduceMotion = reduceMotion
        context.coordinator.renderer = renderer
        // Window isn't attached yet at makeNSView time — bind the
        // occlusion observer in updateNSView (or asynchronously,
        // whichever fires first after layout). See Coordinator.
        return view
    }

    func updateNSView(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.brainState = state
        context.coordinator.renderer?.preferredColorScheme = colorScheme
        context.coordinator.renderer?.reduceMotion = reduceMotion
        // Late-binding for the window observer. SwiftUI calls
        // updateNSView after the view is in its hierarchy on at
        // least some passes; by the second call `view.window` is
        // populated. Coordinator.bind dedupes — calling it on
        // every update is a no-op once the right window is bound.
        context.coordinator.bind(window: view.window)
    }

    @MainActor
    final class Coordinator {
        var renderer: BrainMetalRenderer?
        /// The window we're observing for occlusion changes. Held
        /// weakly so closing the window deallocs without us having
        /// to nullify here too.
        private weak var observedWindow: NSWindow?
        /// NotificationCenter token for the occlusion observer. We
        /// hold it so we can `removeObserver` on rebind / deinit;
        /// without explicit removal, the observer survives until
        /// process exit (NotificationCenter retains it).
        private var occlusionToken: NSObjectProtocol?

        func bind(window: NSWindow?) {
            guard let window = window else { return }
            if observedWindow === window { return }
            // New window — drop the old observer (if any) before
            // attaching the new one.
            if let token = occlusionToken {
                NotificationCenter.default.removeObserver(token)
                occlusionToken = nil
            }
            observedWindow = window
            occlusionToken = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification,
                object: window,
                queue: .main
            ) { [weak self] notif in
                guard let win = notif.object as? NSWindow else { return }
                let occluded = !win.occlusionState.contains(.visible)
                // The observer block hops from .main queue back to
                // the main actor. The main actor IS the main queue
                // on macOS, but Swift 6 strict-concurrency wants an
                // explicit hop to silence the isolation warning.
                Task { @MainActor [weak self] in
                    self?.renderer?.isOccluded = occluded
                }
            }
            // Seed the initial state — a window that's already
            // occluded at bind-time would otherwise wait for the
            // next change to update.
            renderer?.isOccluded = !window.occlusionState.contains(.visible)
        }

        deinit {
            // Tokens are removed safely from any thread —
            // NotificationCenter is internally thread-safe.
            if let token = occlusionToken {
                NotificationCenter.default.removeObserver(token)
            }
        }
    }
}

// MARK: - Inline brain pane

/// Phase 4g — the brain in its production location. Promoted from
/// the standalone "Brain (preview)" Window scene (retired in
/// MARVINApp.swift, alongside the 2g.3 / 3d retirements) into the
/// top of the right HSplitView pane in the main window, mirroring
/// the web app's `side-top` panel placement above the chat.
///
/// State follows `bridge.isBusy` via `BrainState.defaultFor(busy:)`
/// — the same wiring 4f added to the preview. The state caption
/// below the brain mirrors the web's "STATE / <name>" indicator.
///
/// Match-not-improve: no FPS HUD, no manual picker, no follow
/// toggle. Those were dev affordances inside the preview window;
/// the production brain shows only what the WebView's <BrainLiquid>
/// shows.
///
/// The brain renders square at the smaller of (paneWidth,
/// paneHeight) so it stays circular regardless of how the user
/// resizes the right pane vertically. Padding leaves room for the
/// state caption.
struct BrainPaneView: View {
    @Environment(MarvinBridge.self) private var bridge
    /// Phase 4h — System Settings → Accessibility → Display →
    /// Reduce Motion. SwiftUI tracks the current value and re-
    /// invalidates body when the user toggles the system setting,
    /// so the renderer's frame-rate cap updates without a relaunch.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var state: BrainState {
        BrainState.defaultFor(busy: bridge.isBusy)
    }

    var body: some View {
        VStack(spacing: 8) {
            BrainMetalView(
                state: state,
                colorScheme: bridge.preferredColorScheme,
                reduceMotion: reduceMotion
            )
            // Square aspect — keeps the visible sphere circular
            // when the pane is taller than wide (or vice-versa).
            // The renderer's projection already centres at the
            // drawable midpoint (4e fix), so this just constrains
            // the layout box.
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // State caption — mirror of the web app's "STATE /
            // <label>" indicator under the brain. The state name
            // comes verbatim from the enum's rawValue
            // (idle/thinking/tool/writing/error).
            VStack(spacing: 1) {
                Text("STATE")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .tracking(2.5)
                    .foregroundStyle(.tertiary)
                Text(state.rawValue)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 8)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

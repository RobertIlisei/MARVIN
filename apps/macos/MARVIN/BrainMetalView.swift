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

// MARK: - Frame-time HUD model

/// Rolling FPS / CPU-frame metrics surfaced into the preview header
/// so 4e's DoD ("60 fps at N=12 000 verified … via a frame-time HUD"
/// per ADR-0019 §3) is observable inline rather than via Instruments.
///
/// Why @Observable + @MainActor: SwiftUI views read these directly
/// in `body`; mutations happen inside MTKView's `draw(in:)` which
/// also runs on the main queue. Marking the type @MainActor keeps
/// Swift 6 strict-concurrency happy without scattering DispatchQueue
/// hops.
@Observable
@MainActor
final class BrainPerfMetrics {
    /// Rolling-average FPS over the last `windowSize` frames.
    var fps: Double = 0
    /// Last frame's wall-clock CPU work (ms) inside `draw(in:)` —
    /// instance-buffer prep, encoder setup, per-frame uniforms.
    /// Excludes GPU execution itself (which runs after `commit()`
    /// returns). 4e expects this to be ≪ 16.7 ms on N=12 000.
    var cpuFrameMs: Double = 0

    /// Number of recent frame deltas to average. 30 ≈ 0.5 s at
    /// 60 fps — long enough to smooth instantaneous jitter, short
    /// enough that a real perf regression shows up in a heartbeat.
    private let windowSize = 30
    private var deltas: [Double] = []

    /// Record one frame's wall-clock delta and CPU draw time.
    /// Call inside `draw(in:)` after the commit returns.
    func record(deltaSec: Double, cpuMs: Double) {
        if deltaSec > 0 {
            deltas.append(deltaSec)
            if deltas.count > windowSize {
                deltas.removeFirst()
            }
            let avg = deltas.reduce(0, +) / Double(deltas.count)
            fps = avg > 0 ? 1.0 / avg : 0
        }
        cpuFrameMs = cpuMs
    }
}

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
            }
        }
    }
    /// Optional metrics sink. Renderer pushes per-frame samples in;
    /// the preview header observes the published fields.
    weak var metrics: BrainPerfMetrics?

    // MARK: Internal flags

    private var needsClear = true

    // MARK: Init

    init?(
        view: MTKView,
        initialState: BrainState,
        colorScheme: ColorScheme?,
        metrics: BrainPerfMetrics?
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
        self.metrics = metrics

        super.init()
        view.delegate = self
        view.preferredFramesPerSecond = 60
        if let layer = view.layer as? CAMetalLayer {
            // Opaque so the composite pass doesn't mix with window
            // background. NSView's `isOpaque` is read-only on macOS
            // — CAMetalLayer's flag is the toggle Metal honours.
            layer.isOpaque = true
        }
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
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
        let cpuStart = CACurrentMediaTime()

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
        let dt: Double
        let frameDelta: Double
        if lastFrameTimeSec == 0 {
            dt = 1.0 / 60.0
            frameDelta = dt
        } else {
            dt = max(0, nowSec - lastFrameTimeSec)
            frameDelta = dt
        }
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

        let cpuMs = (CACurrentMediaTime() - cpuStart) * 1000
        metrics?.record(deltaSec: frameDelta, cpuMs: cpuMs)
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
/// updates so its device/queue/library don't churn. State + scheme
/// + metrics flow in via `updateNSView`.
struct BrainMetalView: NSViewRepresentable {
    let state: BrainState
    let colorScheme: ColorScheme?
    let metrics: BrainPerfMetrics

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.translatesAutoresizingMaskIntoConstraints = false
        let renderer = BrainMetalRenderer(
            view: view,
            initialState: state,
            colorScheme: colorScheme,
            metrics: metrics
        )
        context.coordinator.renderer = renderer
        return view
    }

    func updateNSView(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.brainState = state
        context.coordinator.renderer?.preferredColorScheme = colorScheme
        // metrics is a class — same instance across updates; nothing
        // to push here unless we ever swap it out.
    }

    @MainActor
    final class Coordinator {
        var renderer: BrainMetalRenderer?
    }
}

// MARK: - Preview window

/// Phase 4f dev surface. Inherits 4d's state picker + 4e's FPS HUD,
/// and adds a "Follow MARVIN" toggle that drives the brain state
/// from `bridge.isBusy` via `BrainState.defaultFor(busy:)`. With
/// the toggle on (the default), the picker shows the bridge-driven
/// state read-only — flipping the toggle off promotes the picker
/// back to a manual override for verifying individual profiles.
///
/// The 700 ms eased transition between profiles already lives in
/// the renderer (`BrainTransition.transition(to:nowMs:)`); both
/// bridge-driven and manual-picker paths feed through the same
/// state-setter so the easing applies uniformly.
///
/// Theme: `bridge.preferredColorScheme` flows into BrainMetalView's
/// `colorScheme` argument, then to the renderer (which sets
/// `needsClear = true` so the next frame doesn't bleed the previous
/// palette through the trail-accumulation texture). A dark→light
/// flip looks instant in the preview window because the next draw
/// renders against a fresh black accumulation.
///
/// Resize: MTKView's auto-resize path fires
/// `mtkView(_:drawableSizeWillChange:)` once per drawable size
/// change. The renderer rebuilds the accumulation texture and
/// flags `needsClear`. On macOS, layout-driven resize coalesces
/// inside MTKView before reaching the delegate — there's no
/// per-cursor-pixel callback to debounce. 4g revisits this when
/// the MTKView promotes into the HSplitView (where rapid splitter
/// drags are the realistic worst case); the preview window's own
/// border drag is already smooth without a manual throttle.
///
/// Retired in 4g once the native renderer reaches parity with the
/// WebView's <BrainLiquid>.
struct BrainPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    /// Manual-override state — only consulted when "Follow MARVIN"
    /// is off. Default `.thinking` to match the bridge-driven
    /// initial value most users will see (busy → thinking).
    @State private var manualState: BrainState = .thinking
    /// Whether to take state from `bridge.isBusy` (true) or the
    /// manual picker (false). Default true so the preview reflects
    /// real session activity by default.
    @State private var followBridge: Bool = true
    /// Owned by the view so the metrics outlive the renderer's
    /// init/deinit churn (NSViewRepresentable can rebuild the
    /// MTKView's coordinator across SwiftUI updates).
    @State private var metrics = BrainPerfMetrics()

    /// The state actually fed to the renderer. The picker reads
    /// from this both in follow + manual modes — so even in
    /// follow mode the segmented control highlights what the
    /// brain is currently rendering.
    private var effectiveState: BrainState {
        followBridge ? BrainState.defaultFor(busy: bridge.isBusy) : manualState
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            BrainMetalView(
                state: effectiveState,
                colorScheme: bridge.preferredColorScheme,
                metrics: metrics
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 360, idealWidth: 480, minHeight: 360, idealHeight: 480)
        .preferredColorScheme(bridge.preferredColorScheme)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "brain.head.profile")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text("Brain — Phase 4 preview")
                    .font(.callout.weight(.semibold))
                Text(followBridge ? "follows MARVIN (4f)" : "manual override (4f)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            perfHUD
            Toggle(isOn: $followBridge) {
                Text("Follow")
                    .font(.caption2)
            }
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .help("Drive state from bridge.isBusy. Off = manual picker.")
            Picker("State", selection: pickerBinding) {
                ForEach(BrainState.allCases, id: \.self) { s in
                    Text(s.rawValue).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 280)
            .disabled(followBridge)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Picker selection binding. In follow mode it reads
    /// `effectiveState` (so the highlighted segment tracks the
    /// bridge-driven value) and discards writes — the picker is
    /// disabled anyway. In manual mode it routes through
    /// `manualState`.
    private var pickerBinding: Binding<BrainState> {
        Binding(
            get: { effectiveState },
            set: { newValue in
                if !followBridge {
                    manualState = newValue
                }
            }
        )
    }

    /// Inline FPS / frame-time readout. The colour signals at-a-
    /// glance health: green ≥58 fps, yellow ≥45 fps, red below.
    /// Same thresholds we'd flag in a perf review — well above
    /// 30 fps reads "fine"; under 45 fps reads "investigate".
    private var perfHUD: some View {
        HStack(spacing: 6) {
            Text("\(Int(metrics.fps.rounded())) fps")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(fpsTint)
            Text(String(format: "%.1f ms", metrics.cpuFrameMs))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }

    private var fpsTint: Color {
        let fps = metrics.fps
        if fps >= 58 { return .green }
        if fps >= 45 { return .yellow }
        return .red
    }
}

// BrainMetalView — Phase 4d. NSViewRepresentable wrapping MTKView,
// with the full particle render pipeline driven by 4b's CPU
// simulation:
//
//   per frame:
//     1. simulation.step(dt)      — advances the BrainSimulation
//                                    against the lerped BrainProfile
//     2. upload instance buffer   — projected positions, depths,
//                                    hues, leader bits, pulse boosts
//     3. accumulation pass        — fade quad (rgba(0,0,0, 1-trail))
//                                    + instanced particle quads
//     4. composite pass           — sample accumulation into the
//                                    drawable
//
// 4e moves step (1) into a Metal compute kernel; 4f wires the
// bridge's preferredColorScheme + isBusy through into the state
// machine + palette uniform; 4g promotes the MTKView from this
// preview window into the work-pane empty state of the main window.
//
// ## Why a runtime-compiled MTLLibrary
//
// See the file-level comment in BrainShaders.swift. tldr: SPM 5.10's
// .metal handling ships a Bundle.module the install script doesn't
// know how to copy, and the runtime compile is a one-time ~50 ms
// cost we pay on first window-open. Both Xcode and SPM builds Just
// Work without bundling extra resources.
//
// ## Why one accumulation texture, not ping-pong
//
// ADR-0019 §5 picked single-accumulation as the default for the same
// reason the canvas2d original uses one canvas: the destination-out
// fade rect over a single texture is a one-pass GPU op that mirrors
// the TS draw step's structure and gives us correct trail decay
// without a swap chain. If TBDR-on-Apple-Silicon shows the dest
// blend as a perf cliff in 4e profiling, we drop down to ping-pong;
// 4d hasn't measured that yet.
//
// ## Why CPU still runs the physics in 4d
//
// ADR-0019 §3 has 4d as "GPU particle render (CPU-driven)" — we
// validate the render shape end-to-end with the known-correct 4b
// simulation before paying the compute-kernel port cost. 4e moves
// physics to a kernel; 4d's bottleneck is intentionally the CPU
// integrator. A 60 fps render with N=12 000 isn't yet the gate —
// that's 4e.

import MetalKit
import SwiftUI

// MARK: - Renderer

/// MTKView delegate that owns the full 4d pipeline. Marked
/// `@MainActor` because MTKView dispatches `draw(in:)` /
/// `mtkView(_:drawableSizeWillChange:)` on the main queue already;
/// the explicit annotation keeps Swift 6 strict-concurrency from
/// flagging the cross-isolation hops we don't actually do.
@MainActor
final class BrainMetalRenderer: NSObject, MTKViewDelegate {
    // MARK: Metal core

    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    /// Compiled at first init via `MTLDevice.makeLibrary(source:)` —
    /// see BrainShaders.swift for the source.
    private let library: MTLLibrary
    /// Particle pipeline — instanced quads with pre-multiplied
    /// source-over blending into the accumulation texture.
    private let particlePipeline: MTLRenderPipelineState
    /// Fade pipeline — fullscreen black quad with pre-multiplied
    /// source-over blending. Drives the trail decay.
    private let fadePipeline: MTLRenderPipelineState
    /// Composite pipeline — fullscreen blit from accumulation
    /// texture to drawable. No blending; replaces the drawable's
    /// content each frame.
    private let compositePipeline: MTLRenderPipelineState

    // MARK: Frame state

    /// Trail accumulation texture, sized to the drawable. Rebuilt
    /// in `mtkView(_:drawableSizeWillChange:)`. The fade + particle
    /// passes write here; the composite pass samples from here.
    private var accumulation: MTLTexture?
    /// Single shared instance buffer of `maxN` ParticleInstances.
    /// `storageModeShared` so we can memcpy each frame from CPU
    /// without a separate blit. 24 bytes × 12 000 = 288 KB — fits
    /// the L2 budget on every supported Apple Silicon GPU and the
    /// Intel Metal-capable Macs covered by the macOS 14 floor.
    private let instanceBuffer: MTLBuffer
    /// Per-frame uniforms. Rewritten each draw — single buffer is
    /// fine at 60 fps; if 4e's compute kernel pushes contention,
    /// triple-buffer it.
    private let uniformBuffer: MTLBuffer
    /// 4-byte buffer holding the fade alpha for the current frame.
    private let fadeAlphaBuffer: MTLBuffer

    // MARK: Simulation + state machine

    /// CPU physics. Owns the SoA particle arrays the 4b port writes.
    private let simulation: BrainSimulation
    /// 700 ms eased state machine. The renderer reads
    /// `transition.currentProfile(nowMs:)` each frame to drive the
    /// simulation's profile + uniform fields.
    private var transition: BrainTransition
    /// CACurrentMediaTime() at the previous frame, in seconds. Used
    /// to compute dt and to pass milliseconds into the transition.
    private var lastFrameTimeSec: Double = 0
    /// True once `seedAllParticles` has been called. We defer the
    /// initial seed until the first `draw(in:)` so we know the
    /// drawable size — sphereRadius depends on it.
    private var seeded = false

    // MARK: Inputs (set by the SwiftUI bridge)

    /// SwiftUI light/dark hint forwarded from the bridge. The
    /// fragment shader reads `palette` from the uniform; this is
    /// the source.
    var preferredColorScheme: ColorScheme? {
        didSet { needsClear = true }
    }
    /// Behavioural state the brain should be in. Setting this
    /// schedules a 700 ms transition to the new profile (no-op if
    /// already in that state).
    var brainState: BrainState {
        didSet {
            if brainState != oldValue {
                let nowMs = CACurrentMediaTime() * 1000
                transition.transition(to: brainState, nowMs: nowMs)
            }
        }
    }

    // MARK: Internal flags

    /// Set when something invalidates the accumulation texture's
    /// contents (theme flip, resize). The next frame's pass uses
    /// `loadAction = .clear` instead of `.load`.
    private var needsClear = true

    // MARK: Init

    init?(view: MTKView, initialState: BrainState, colorScheme: ColorScheme?) {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else {
            // No Metal-capable GPU — caller falls back to the
            // WebView brain. macOS 14 minimum (ADR-0016 §Resolved)
            // means every supported machine has Metal, so this
            // branch is the "ran in a headless test runner" case
            // rather than a real user fallback.
            return nil
        }
        self.device = device
        self.commandQueue = queue

        // Compile the shader source. `MTLLibrary` errors when the
        // source has a syntax error — surfacing a precise message
        // here is better than a silent black brain.
        do {
            self.library = try device.makeLibrary(
                source: brainMetalShaderSource,
                options: nil
            )
        } catch {
            NSLog("[BrainMetalRenderer] shader compile failed: \(error)")
            return nil
        }

        // Drawable format. BGRA8Unorm matches MTKView's default and
        // matches the accumulation texture so composite is identity.
        view.colorPixelFormat = .bgra8Unorm
        view.device = device

        // Build the three pipelines. All write BGRA8Unorm; particle
        // + fade enable pre-multiplied source-over blending,
        // composite is opaque replace.
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

        // Allocate the per-frame buffers. All shared so memcpy is
        // free; sizes are fixed for the renderer's lifetime.
        let instanceBytes = MemoryLayout<ParticleInstance>.stride * BrainSimulation.maxN
        guard let ib = device.makeBuffer(length: instanceBytes, options: [.storageModeShared]) else {
            return nil
        }
        guard let ub = device.makeBuffer(length: MemoryLayout<BrainUniforms>.stride, options: [.storageModeShared]) else {
            return nil
        }
        guard let fb = device.makeBuffer(length: MemoryLayout<Float>.stride, options: [.storageModeShared]) else {
            return nil
        }
        self.instanceBuffer = ib
        self.uniformBuffer = ub
        self.fadeAlphaBuffer = fb

        self.simulation = BrainSimulation()
        self.transition = BrainTransition(initialState: initialState)
        self.brainState = initialState
        self.preferredColorScheme = colorScheme

        super.init()
        view.delegate = self
        // 60 fps — MTKView caps to display refresh, so on ProMotion
        // the loop runs at 120 fps with the same per-frame work.
        view.preferredFramesPerSecond = 60
        // The drawable IS the brain — opaque so the composite pass
        // doesn't need to mix with the window background. NSView's
        // `isOpaque` is read-only on macOS; the underlying
        // CAMetalLayer's `isOpaque` is the toggle Metal actually
        // honours. Default for an MTKView is already opaque (BGRA
        // pixel format with no transparent attachments) — set it
        // explicitly for clarity.
        if let layer = view.layer as? CAMetalLayer {
            layer.isOpaque = true
        }
        // Phase 4c clear-color isn't used at 4d (the composite pass
        // writes every drawable pixel) but keep a sensible value
        // for the first frame before composite has a chance to run.
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    }

    private static func makeParticlePipeline(
        device: MTLDevice,
        library: MTLLibrary,
        format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_particle_vs"),
              let fs = library.makeFunction(name: "brain_particle_fs") else {
            return nil
        }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        // Pre-multiplied source-over blending. See BrainShaders.swift
        // for why pre-multiplied — the fragment writes color * alpha.
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
        device: MTLDevice,
        library: MTLLibrary,
        format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_full_vs"),
              let fs = library.makeFunction(name: "brain_fade_fs") else {
            return nil
        }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        // Same pre-multiplied source-over as the particle pass —
        // the fade quad's color * alpha = (0,0,0,fadeAlpha) → after
        // blending, dst.rgb *= (1 - fadeAlpha), which is exactly
        // the trail decay the TS canvas's destination-out gives us.
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
        device: MTLDevice,
        library: MTLLibrary,
        format: MTLPixelFormat
    ) -> MTLRenderPipelineState? {
        guard let vs = library.makeFunction(name: "brain_full_vs"),
              let fs = library.makeFunction(name: "brain_composite_fs") else {
            return nil
        }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = fs
        desc.colorAttachments[0].pixelFormat = format
        // No blending — composite writes every drawable pixel with
        // the accumulation texture's content directly.
        desc.colorAttachments[0].isBlendingEnabled = false
        return try? device.makeRenderPipelineState(descriptor: desc)
    }

    // MARK: MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        // Rebuild the accumulation texture at the new size. We
        // also flag needsClear so the next frame's accumulation
        // pass starts from a known (black) baseline rather than
        // sampling stale content from the previous size's texture.
        rebuildAccumulation(width: Int(size.width), height: Int(size.height))
        needsClear = true
        // Resize doesn't reseed particles — they keep their world-
        // space positions and re-project against the new viewport
        // on the next frame.
    }

    func draw(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let descriptor = view.currentRenderPassDescriptor,
              let buffer = commandQueue.makeCommandBuffer() else {
            return
        }

        let drawableW = Float(drawable.texture.width)
        let drawableH = Float(drawable.texture.height)
        // Sphere radius — the TS uses `R = size / 2` with size = the
        // CSS layout size (BEFORE RENDER_SCALE 1.5×). Here the
        // drawable IS the renderSize, so divide by 3 to recover the
        // visible-radius of size/2. This keeps the sphere visually
        // centred with the same proportional padding as the lab
        // standalone.
        let sphereRadius = min(drawableW, drawableH) / 3.0

        // Lazy seed once we know the drawable size.
        if !seeded {
            simulation.seedAllParticles(
                profile: BrainProfile.profile(for: brainState),
                sphereRadius: sphereRadius
            )
            seeded = true
        }

        // Ensure the accumulation texture exists for this drawable
        // size. drawableSizeWillChange usually fires first, but a
        // resize that lands on the exact same pixel size won't
        // re-trigger; this guard covers cold-start.
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

        // dt — clamp the same way the simulation does internally
        // (`min(0.05, ...)`). A long pause shouldn't fast-forward.
        let nowSec = CACurrentMediaTime()
        let dt: Double
        if lastFrameTimeSec == 0 {
            dt = 1.0 / 60.0
        } else {
            dt = max(0, nowSec - lastFrameTimeSec)
        }
        lastFrameTimeSec = nowSec
        let nowMs = nowSec * 1000

        // Drive the state machine. The transition handle interpolates
        // between profiles over 700 ms; outside a transition it
        // returns the target profile verbatim.
        let profile = transition.currentProfile(nowMs: nowMs)

        // Step the CPU simulation against the lerped profile.
        let slice = simulation.step(
            dt: dt,
            profile: profile,
            sphereRadius: sphereRadius,
            renderSize: min(drawableW, drawableH)
        )

        // Upload instance data + uniforms.
        uploadInstances(count: slice.count, profile: profile)
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
            // (matches the TS `effTrail = Math.min(0.99, p.trail)`)
            // so a slider at 1.0 doesn't freeze the trail forever.
            let effTrail = min(0.99, max(0, profile.trail))
            var fadeAlpha = Float(1.0 - effTrail)
            memcpy(fadeAlphaBuffer.contents(), &fadeAlpha, MemoryLayout<Float>.stride)
            acc.setRenderPipelineState(fadePipeline)
            acc.setFragmentBuffer(fadeAlphaBuffer, offset: 0, index: 0)
            acc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)

            // Particles.
            if slice.count > 0 {
                acc.setRenderPipelineState(particlePipeline)
                acc.setVertexBuffer(instanceBuffer, offset: 0, index: 0)
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
        // We render INTO this texture and SAMPLE FROM it in the
        // composite pass — needs both usage flags. `.private` so it
        // lives on the GPU only; we never read it CPU-side.
        desc.usage = [.renderTarget, .shaderRead]
        desc.storageMode = .private
        accumulation = device.makeTexture(descriptor: desc)
    }

    /// Pack the simulation's SoA arrays into a contiguous AoS
    /// instance buffer for the GPU. The vertex shader reads
    /// `instances[iid]` — we pay one struct copy per particle per
    /// frame (~290 KB at N=12 000) which is well below the
    /// memcpy-bandwidth ceiling on every supported machine.
    /// 4e moves the simulation buffers to GPU-shared storage so
    /// this packing call retires.
    private func uploadInstances(count: Int, profile: BrainProfile) {
        guard count > 0 else { return }
        let ptr = instanceBuffer.contents().bindMemory(
            to: ParticleInstance.self,
            capacity: BrainSimulation.maxN
        )
        // Read the simulation's published arrays directly. They're
        // `private(set)` so the renderer can read but the integrator
        // owns writes. Same lifetime as the renderer (both alloc'd
        // once on init).
        for i in 0..<count {
            ptr[i] = ParticleInstance(
                screenX: simulation.screenX[i],
                screenY: simulation.screenY[i],
                depth: simulation.screenDepth[i],
                hue: simulation.hues[i],
                leader: Float(simulation.leaders[i]),
                pulseBoost: simulation.pulseBoosts[i]
            )
        }
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
/// flow in via `updateNSView`.
struct BrainMetalView: NSViewRepresentable {
    let state: BrainState
    let colorScheme: ColorScheme?

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
        context.coordinator.renderer = renderer
        return view
    }

    func updateNSView(_ view: MTKView, context: Context) {
        // Push the latest state + scheme onto the renderer; the next
        // frame picks them up. The renderer's `brainState` setter
        // handles the transition lerp internally; no need to do
        // anything fancier here.
        context.coordinator.renderer?.brainState = state
        context.coordinator.renderer?.preferredColorScheme = colorScheme
    }

    @MainActor
    final class Coordinator {
        var renderer: BrainMetalRenderer?
    }
}

// MARK: - Preview window

/// Phase 4d dev surface. A standalone Window scene hosting the
/// MTKView so we can iterate on the render pipeline without
/// disturbing the main window's WebView brain. The preview ships a
/// state picker so all five profiles can be visually verified
/// against the lab standalone — that's the 4d DoD per ADR-0019 §3
/// ("five profiles render visibly correct particle clouds in the
/// preview window; trails decay; theme switches change the
/// palette"). Retired in 4g once the native renderer reaches parity
/// with the WebView's <BrainLiquid> and the work-pane empty state
/// promotes it inline.
struct BrainPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    /// Local state picker so 4d can verify all five profiles even
    /// though the main app's `bridge.isBusy` only resolves to
    /// idle/thinking. 4f wires bridge.isBusy through and this
    /// picker becomes a debug-only override.
    @State private var state: BrainState = .thinking

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            BrainMetalView(
                state: state,
                colorScheme: bridge.preferredColorScheme
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
                Text("particles + trails (4d)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Picker("State", selection: $state) {
                ForEach(BrainState.allCases, id: \.self) { s in
                    Text(s.rawValue).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 280)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

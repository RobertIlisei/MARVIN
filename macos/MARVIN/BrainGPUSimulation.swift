// BrainGPUSimulation — Phase 4e replacement for the CPU 4b port.
//
// Owns the Metal buffers backing the per-particle SoA state and
// dispatches the `brain_step_kernel` per frame. The kernel writes
// into the same `instances` buffer the vertex shader reads, so
// 4d's render passes stay unchanged — only the source of the
// instance data moves from CPU memcpy to GPU compute.
//
// ## Why CPU still drives time + rotation + attractors
//
// Three small serial inputs that the kernel consumes via uniforms.
// Computing them on the GPU would either need a second tiny kernel
// (more dispatch overhead than the trig itself) or burning every
// thread's first iterations on redundant work. The CPU branch is
// trivially cheap (≤ 8 attractors × ~10 trig calls + a single
// per-frame rotation update), and packing them into a uniform
// buffer is the cheapest GPU-bind path.
//
// ## Why .storageModeShared on the SoA buffers
//
// `.shared` lets us seed positions CPU-side at init (the only
// time the CPU writes the SoA) without a blit encoder, and lets
// future debug HUDs peek at any field directly. Apple Silicon
// reports identical bandwidth for shared vs private at this access
// pattern (sequential read/write per thread). On Intel macs the
// shared cost is +/-10% vs private; the perf gate (60 fps at
// N=12 000) is well within budget on every supported machine.
//
// ## Determinism: we don't aim for it
//
// The kernel uses a Wang-hash RNG seeded by `(iid, frameSeed)`. A
// CPU port using `Float.random` is non-deterministic too; the
// 4b/4e DoD is "same statistical signature", not bit-exact parity.
// Cross-machine reproducibility would buy snapshot-style tests but
// at the cost of plumbing a seeded RNG through every respawn site.

import Metal
import MetalKit
import simd

/// One-shot output bundle the renderer reads each frame. Mirrors
/// the 4b `BrainFrameSlice` so the renderer's draw loop didn't
/// have to change shape across the 4b→4e cutover.
struct BrainFrameSlice {
    let count: Int
    /// `n / (DG * DG)` — 4d/4e's renderer doesn't read this yet
    /// (density boost lands in 4f), but BrainSimulation published
    /// it and the renderer's draw signature kept the field for
    /// continuity.
    let meanDensity: Float
}

@MainActor
final class BrainGPUSimulation {
    /// Allocation ceiling. Same value the 4b port used; matches
    /// the maximum `BrainProfile.n` (currently `thinking` at 12 000).
    static let maxN = 12_000

    /// Attractor cap. Matches `MAX_ATT` in the TS.
    static let maxAttractors = 8

    /// Density-grid resolution. Mirror of `DG = 24` in the TS;
    /// referenced even at 4e (no kernel binning yet) so the
    /// uniforms layout doesn't churn between 4e and 4f.
    static let densityGridSize = 24

    // MARK: - GPU buffers

    /// World-space positions (x/y/z), velocities, ages, lives,
    /// hues, leaders, pulseBoosts. SoA — one buffer per Float32
    /// field, length `maxN`. The kernel reads + writes most of
    /// these every frame; CPU only touches them at seed time.
    private let positionsXBuf: MTLBuffer
    private let positionsYBuf: MTLBuffer
    private let positionsZBuf: MTLBuffer
    private let velocitiesXBuf: MTLBuffer
    private let velocitiesYBuf: MTLBuffer
    private let velocitiesZBuf: MTLBuffer
    private let agesBuf: MTLBuffer
    private let livesBuf: MTLBuffer
    private let huesBuf: MTLBuffer
    private let leadersBuf: MTLBuffer
    private let pulseBoostsBuf: MTLBuffer

    /// Per-particle ParticleInstance written by the kernel each
    /// frame, then read by the vertex shader. Lives across frames
    /// (cheap) — its contents are replaced wholesale by the kernel.
    let instanceBuffer: MTLBuffer

    /// 8 × float4 (xyz + pulse). CPU updates each frame, kernel
    /// reads. 128 bytes — fits a uniform binding cleanly.
    private let attractorsBuffer: MTLBuffer

    /// BrainKernelUniforms for the kernel. Updated CPU each frame.
    private let kernelUniformsBuffer: MTLBuffer

    /// Compute pipeline state for `brain_step_kernel`.
    private let kernelPipeline: MTLComputePipelineState

    // MARK: - CPU state

    /// Per-attractor phase / period / seed. Drives the Lissajous
    /// motion and the 0.08-rise / 4-decay synapse-pulse envelope.
    /// Same shape as BrainSimulation — only the per-particle work
    /// moves to GPU.
    private var attractorPhase: [Float]
    private var attractorPeriod: [Float]
    private var attractorSeed: [Float]

    /// Y-axis rotation accumulator. Driven by `profile.rot * dt *
    /// 60` to match the TS expression — `60` is the assumed
    /// reference frame rate baked into the lab's slider semantics.
    private(set) var rotationY: Float = 0
    /// X-axis rotation. Hand-tuned constant + sine wobble — matches
    /// the TS so the brain's slow nod cadence stays the same.
    private(set) var rotationX: Float = -0.18
    /// Total simulated seconds since `init` (or the last reset).
    private(set) var elapsedSec: Double = 0
    /// Previous frame's particle count. The kernel uses this to
    /// detect newly-active indices when n grows mid-lerp.
    private var prevN: Int = 0
    /// Per-frame seed advanced each step. The kernel folds it into
    /// `wangHash(iid * 2654435761 + frameSeed)` so each frame's
    /// RNG stream is uncorrelated with the last.
    private var frameSeed: UInt32 = 0xC0FFEE_42

    // MARK: - Init

    init?(device: MTLDevice, library: MTLLibrary) {
        let n = BrainGPUSimulation.maxN

        // SoA float buffers — `.storageModeShared` lets us seed
        // positions CPU-side and (later) read state for debug.
        let f32Bytes = n * MemoryLayout<Float>.stride
        guard
            let bx = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let by = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let bz = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let vx = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let vy = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let vz = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let ag = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let li = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let hu = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let le = device.makeBuffer(length: f32Bytes, options: [.storageModeShared]),
            let pb = device.makeBuffer(length: f32Bytes, options: [.storageModeShared])
        else {
            return nil
        }
        self.positionsXBuf = bx
        self.positionsYBuf = by
        self.positionsZBuf = bz
        self.velocitiesXBuf = vx
        self.velocitiesYBuf = vy
        self.velocitiesZBuf = vz
        self.agesBuf = ag
        self.livesBuf = li
        self.huesBuf = hu
        self.leadersBuf = le
        self.pulseBoostsBuf = pb

        let instanceBytes = n * MemoryLayout<ParticleInstance>.stride
        guard let inst = device.makeBuffer(length: instanceBytes, options: [.storageModeShared]) else {
            return nil
        }
        self.instanceBuffer = inst

        let attBytes = BrainGPUSimulation.maxAttractors * MemoryLayout<SIMD4<Float>>.stride
        guard let att = device.makeBuffer(length: attBytes, options: [.storageModeShared]) else {
            return nil
        }
        self.attractorsBuffer = att

        guard let unif = device.makeBuffer(
            length: MemoryLayout<BrainKernelUniforms>.stride,
            options: [.storageModeShared]
        ) else {
            return nil
        }
        self.kernelUniformsBuffer = unif

        // Compile the compute pipeline. Errors surface inline because
        // a silent fall-through to a frozen brain is the worst
        // possible debug signal.
        guard let kfn = library.makeFunction(name: "brain_step_kernel") else {
            NSLog("[BrainGPUSimulation] missing brain_step_kernel — shader compile must have failed silently")
            return nil
        }
        do {
            self.kernelPipeline = try device.makeComputePipelineState(function: kfn)
        } catch {
            NSLog("[BrainGPUSimulation] compute pipeline failed: \(error)")
            return nil
        }

        // CPU attractor state — same Lissajous seed/period/phase
        // distribution BrainSimulation used so the visual cadence
        // matches.
        let a = BrainGPUSimulation.maxAttractors
        self.attractorPhase = (0..<a).map { _ in Float.random(in: 0..<3) }
        self.attractorPeriod = (0..<a).map { _ in 2.2 + Float.random(in: 0..<2.8) }
        self.attractorSeed = (0..<a).map { _ in Float.random(in: 0..<1000) }
    }

    // MARK: - Cold-start seed

    /// Place every particle at a valid sphere position before the
    /// first kernel dispatch. Mirrors BrainSimulation.seedAllParticles
    /// — same uniform-direction distribution, same life range
    /// initialisation, same leader probability draw.
    ///
    /// Must run after the drawable size is known (sphereRadius
    /// depends on it). The renderer calls this lazily on the first
    /// `draw(in:)` from a non-zero drawable.
    ///
    /// Phase 5f — when `spark` is true, the active head of the SoA
    /// (the first `profile.n` slots) is reseeded clustered tightly
    /// at the centre with outward radial velocity, so the launch
    /// animation reads as a literal spark rather than "60 dots
    /// already distributed on a sphere shell". The remaining slots
    /// (i ≥ profile.n) still seed onto the shell so the kernel's
    /// n-growth respawn path has valid neighbours to interpolate
    /// from when the boot → idle lerp ramps n upward.
    func seedAllParticles(
        profile: BrainProfile,
        sphereRadius: Float,
        spark: Bool = false
    ) {
        let posX = positionsXBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let posY = positionsYBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let posZ = positionsZBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let velX = velocitiesXBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let velY = velocitiesYBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let velZ = velocitiesZBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let age = agesBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let life = livesBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let hue = huesBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let lead = leadersBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)
        let pulse = pulseBoostsBuf.contents().bindMemory(to: Float.self, capacity: BrainGPUSimulation.maxN)

        let activeN = max(0, min(BrainGPUSimulation.maxN, profile.n))
        // Burst speed: enough to clear ~80% of the sphere radius
        // inside the boot → idle transition window (~1.8 s) so the
        // spark is visibly expanding while the rest of the dots
        // fade in around it.
        let burstSpeed = sphereRadius * 0.45

        for i in 0..<BrainGPUSimulation.maxN {
            let u = Float.random(in: 0..<1)
            let v = Float.random(in: 0..<1)
            let theta = 2 * Float.pi * u
            let phi = acos(2 * v - 1)
            let dirX = sin(phi) * cos(theta)
            let dirY = sin(phi) * sin(theta)
            let dirZ = cos(phi)

            if spark && i < activeN {
                // Tight central cluster — radius ≤ 6% of sphere.
                let r = sphereRadius * Float.random(in: 0..<0.06)
                posX[i] = r * dirX
                posY[i] = r * dirY
                posZ[i] = r * dirZ
                velX[i] = dirX * burstSpeed
                velY[i] = dirY * burstSpeed
                velZ[i] = dirZ * burstSpeed
            } else {
                // Default sphere-shell distribution for the inactive
                // tail (and for non-spark seeds).
                let r = sphereRadius * (0.55 + Float.random(in: 0..<0.45))
                posX[i] = r * dirX
                posY[i] = r * dirY
                posZ[i] = r * dirZ
                velX[i] = 0
                velY[i] = 0
                velZ[i] = 0
            }
            age[i] = 0
            life[i] = profile.lmin + Float.random(in: 0..<profile.lrange)
            hue[i] = Float.random(in: 0..<1)
            lead[i] = Float.random(in: 0..<1) < profile.leaders ? 1 : 0
            pulse[i] = 0
        }
        prevN = profile.n
    }

    // MARK: - Step

    /// Per-frame work split between the main actor (time / rotation
    /// / attractors / uniform packing) and a GPU compute pass
    /// (per-particle integrator + projection). Encodes the kernel
    /// into the supplied command buffer; the caller is responsible
    /// for committing.
    ///
    /// The instance buffer is ready for the renderer's vertex
    /// shader after the kernel completes — Metal's automatic hazard
    /// tracking inserts the necessary compute→render barrier when
    /// both encoders run on the same command buffer.
    @discardableResult
    func step(
        commandBuffer: MTLCommandBuffer,
        dt: Double,
        profile: BrainProfile,
        sphereRadius: Float,
        drawableSize: SIMD2<Float>
    ) -> BrainFrameSlice {
        // Same dt clamp the CPU port did. A long pause (tab hidden,
        // window occluded) shouldn't fast-forward physics by seconds
        // and explode the integrator.
        let dtF = Float(min(0.05, max(0, dt)))
        elapsedSec += Double(dtF)
        let t = Float(elapsedSec)

        // Rotation update — same expression as the TS.
        rotationY += profile.rot * dtF * 60
        rotationX = -0.18 + sin(t * 0.25) * 0.06

        // Attractor update — Lissajous motion + pulse phase. Eight
        // attractors max, all serial work on the main actor.
        let nAtt = min(BrainGPUSimulation.maxAttractors, max(0, profile.attractors))
        let attPtr = attractorsBuffer.contents().bindMemory(
            to: SIMD4<Float>.self,
            capacity: BrainGPUSimulation.maxAttractors
        )
        for a in 0..<nAtt {
            let s = attractorSeed[a]
            let jitter: Float = profile.jitter > 0
                ? sin(t * 7 + s * 3) * profile.jitter
                : 0
            let ax = sin(t * 0.11 + s) * sphereRadius * 0.55 + jitter * sphereRadius
            let ay = sin(t * 0.17 + s * 1.3) * sphereRadius * 0.45 + jitter * sphereRadius * 0.7
            let az = cos(t * 0.13 + s * 0.7) * sphereRadius * 0.55 + jitter * sphereRadius * 0.8
            attractorPhase[a] += dtF * profile.pulseRate
            let ph = attractorPhase[a].truncatingRemainder(dividingBy: attractorPeriod[a])
                / attractorPeriod[a]
            let pulse: Float = ph < 0.08
                ? ph / 0.08
                : max(0, exp(-(ph - 0.08) * 4))
            attPtr[a] = SIMD4<Float>(ax, ay, az, pulse)
        }
        // Zero unused attractor slots so a profile that drops the
        // attractor count doesn't leave the kernel reading stale
        // positions.
        for a in nAtt..<BrainGPUSimulation.maxAttractors {
            attPtr[a] = SIMD4<Float>(0, 0, 0, 0)
        }

        // Pack kernel uniforms.
        let cosY = cos(rotationY)
        let sinY = sin(rotationY)
        let cosX = cos(rotationX)
        let sinX = sin(rotationX)
        let sw = profile.swirl * dtF * 0.4
        let cosSw = cos(sw)
        let sinSw = sin(sw)
        let renderSide = min(drawableSize.x, drawableSize.y)
        let dgSize = Int32(BrainGPUSimulation.densityGridSize)
        var u = BrainKernelUniforms(
            dt: dtF,
            time: t,
            sphereRadius: sphereRadius,
            halfRender: renderSide / 2,
            centerX: drawableSize.x / 2,
            centerY: drawableSize.y / 2,
            invCellSize: Float(BrainGPUSimulation.densityGridSize) / renderSide,
            cosY: cosY,
            sinY: sinY,
            cosX: cosX,
            sinX: sinX,
            cosSw: cosSw,
            sinSw: sinSw,
            damp: profile.damp,
            flowMag: profile.flowMag,
            shellPull: profile.shellPull,
            nfreq: profile.nfreq,
            neps: profile.neps,
            lmin: profile.lmin,
            lrange: profile.lrange,
            synapse: profile.synapse,
            coh: profile.coh,
            turb: profile.turb,
            leadersFrac: profile.leaders,
            n: Int32(profile.n),
            nAtt: Int32(nAtt),
            prevN: Int32(prevN),
            dgSize: dgSize,
            frameSeed: frameSeed
        )
        memcpy(kernelUniformsBuffer.contents(), &u, MemoryLayout<BrainKernelUniforms>.stride)

        // Encode the compute dispatch. 256 threads per group is the
        // standard "fits in a SIMD-group on every Apple GPU" choice;
        // total threadgroups = ceil(N / 256). For N=12 000 that's
        // 47 groups, well above the SIMD-coverage threshold.
        if let enc = commandBuffer.makeComputeCommandEncoder() {
            enc.setComputePipelineState(kernelPipeline)
            enc.setBuffer(positionsXBuf,        offset: 0, index: 0)
            enc.setBuffer(positionsYBuf,        offset: 0, index: 1)
            enc.setBuffer(positionsZBuf,        offset: 0, index: 2)
            enc.setBuffer(velocitiesXBuf,       offset: 0, index: 3)
            enc.setBuffer(velocitiesYBuf,       offset: 0, index: 4)
            enc.setBuffer(velocitiesZBuf,       offset: 0, index: 5)
            enc.setBuffer(agesBuf,              offset: 0, index: 6)
            enc.setBuffer(livesBuf,             offset: 0, index: 7)
            enc.setBuffer(huesBuf,              offset: 0, index: 8)
            enc.setBuffer(leadersBuf,           offset: 0, index: 9)
            enc.setBuffer(pulseBoostsBuf,       offset: 0, index: 10)
            enc.setBuffer(instanceBuffer,       offset: 0, index: 11)
            enc.setBuffer(attractorsBuffer,     offset: 0, index: 12)
            enc.setBuffer(kernelUniformsBuffer, offset: 0, index: 13)

            let threadsPerGroup = MTLSize(width: 256, height: 1, depth: 1)
            let totalThreads = MTLSize(width: profile.n, height: 1, depth: 1)
            // dispatchThreads (vs dispatchThreadgroups) lets Metal
            // size the grid exactly; we don't need to round up to a
            // group multiple ourselves. Available since macOS 10.14.
            enc.dispatchThreads(totalThreads, threadsPerThreadgroup: threadsPerGroup)
            enc.endEncoding()
        }

        prevN = profile.n
        frameSeed = frameSeed &+ 0x9E3779B9 // golden-ratio constant — well-distributed step

        let meanDens = Float(profile.n)
            / Float(BrainGPUSimulation.densityGridSize * BrainGPUSimulation.densityGridSize)
        return BrainFrameSlice(count: profile.n, meanDensity: meanDens)
    }
}

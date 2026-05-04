// BrainSimulation — Phase 4b CPU port of the BrainLiquid physics.
//
// Source: apps/web/src/components/brain/brain-liquid.tsx, the
// `step()` function inside `BrainLiquidImpl` (lines ~531-650). We
// port the per-frame integrator without the rendering — the output
// is the particle arrays (positions, projected screen coords,
// alphas, leader flags, density grid). 4d wires these into a
// Metal pipeline; 4e moves the per-frame work into a compute
// kernel.
//
// ## Why structure-of-arrays
//
// The TS source uses 14 typed arrays (`Float32Array(MAX_N)` etc.),
// keeping each per-particle field flat in memory. That layout maps
// cleanly to Metal buffers and to SIMD vectorisation in Accelerate.
// We mirror the SoA shape in Swift so 4e's compute kernel can
// adopt the same buffers without restructuring; 4b's CPU integrator
// is the staging ground.
//
// ## Determinism
//
// The simulation is deliberately non-deterministic — particle
// respawn uses Float.random, just like the TS Math.random calls.
// 4b's DoD per ADR-0019 §3 is "same statistical signature" (mean
// radius, pulse cadence, leader distribution), not bit-exact
// parity. Reproducible runs would let us snapshot-test against the
// TS output, but the cost (seeded RNG plumbed through every
// respawn site) outweighs the benefit at the integrator's scale.

import Foundation

/// One-shot output bundle handed to the renderer each frame. The
/// caller owns the inner buffers (they live on `BrainSimulation`)
/// and reads them as a slice of length `count` — entries beyond
/// `count` are stale from the previous frame's `n` and must NOT
/// be sampled.
struct BrainFrameSlice {
    /// Active particle count for this frame. The renderer iterates
    /// `0..<count`, never `0..<maxN`.
    let count: Int
    /// Mean particles per density cell — drives the density boost
    /// in the shader (4d) so dense regions glow brighter.
    let meanDensity: Float
}

@MainActor
final class BrainSimulation {
    /// Allocation ceiling. Must be ≥ max(BrainProfile.n) across all
    /// profiles. `thinking` is currently the ceiling at 12 000.
    /// Bumping costs ~14 × MAX_N × 4 bytes = ~672 KB at 12 000;
    /// per-frame cost scales with the active profile's n, not maxN.
    static let maxN = 12_000

    /// Attractor cap. Matches `MAX_ATT` in the TS.
    static let maxAttractors = 8

    /// Density-grid resolution. Matches `DG = 24` in the TS — 24×24
    /// cells over the full canvas. 576 cells, very cheap.
    static let densityGridSize = 24

    // MARK: - Particle state (SoA)

    /// World-space positions (x, y, z) in pixels relative to the
    /// sphere centre. Allocated to maxN; only `0..<n` carry valid
    /// data after each `step`.
    private(set) var positionsX: [Float]
    private(set) var positionsY: [Float]
    private(set) var positionsZ: [Float]

    /// World-space velocities. Damped each frame, advanced by curl
    /// flow + attractor pull + shell pull.
    private var velocitiesX: [Float]
    private var velocitiesY: [Float]
    private var velocitiesZ: [Float]

    /// Per-particle lifecycle. `age` is seconds since spawn; once
    /// it exceeds `life` we respawn at a fresh sphere position.
    private var ages: [Float]
    private var lives: [Float]

    /// 0..1 hue seed used by the renderer to pick a palette index.
    /// Phase 4d's shader maps this through the NEBULA table; the
    /// simulation just keeps it stable across the particle's life.
    private(set) var hues: [Float]

    /// 0/1 leader flag — leader particles render at full alpha, the
    /// rest at `profile.dim`. Set on spawn from `profile.leaders`.
    private(set) var leaders: [UInt8]

    /// Projected screen-space position + depth (0..1, 0 = back).
    /// Computed by `step` after the integrator runs; the renderer
    /// reads these directly.
    private(set) var screenX: [Float]
    private(set) var screenY: [Float]
    private(set) var screenDepth: [Float]

    /// Per-particle pulse boost (decays exponentially each frame
    /// toward the nearest attractor's pulse). Drives the chromatic
    /// red-mix and the alpha boost during synapse flashes.
    private(set) var pulseBoosts: [Float]

    // MARK: - Attractor state

    private var attractorX: [Float]
    private var attractorY: [Float]
    private var attractorZ: [Float]
    private var attractorPhase: [Float]
    private var attractorPeriod: [Float]
    private var attractorSeed: [Float]
    /// Per-attractor pulse value 0..1. The `step` function refills
    /// these every frame from the phase/period/seed arrays.
    private(set) var attractorPulse: [Float]

    // MARK: - Density grid

    /// 24×24 grid of particle counts in projected screen space.
    /// Renderer reads cell (gx, gy) at index `gy * DG + gx`.
    private(set) var densityGrid: [Int]

    // MARK: - Per-frame state

    /// Y-axis rotation accumulator. Driven by `profile.rot * dt * 60`
    /// to match the TS expression — `60` is the assumed reference
    /// frame rate baked into the lab's slider semantics.
    private(set) var rotationY: Float = 0

    /// X-axis rotation. Hand-tuned constant + sine wobble — same
    /// formula as the TS to keep the brain's slow nod identical.
    private(set) var rotationX: Float = -0.18

    /// Total simulated seconds since `init` (or the last reset).
    /// Used as the time argument to curl-noise and attractor
    /// motion. Independent from wall-clock so a paused sim resumes
    /// at the same noise phase.
    private(set) var elapsedSec: Double = 0

    /// Previous frame's particle count. When `profile.n` grows
    /// (idle→thinking lerps 8000→12000), the new indices need
    /// fresh sphere positions; otherwise they'd pop in from
    /// stale coords.
    private var prevN: Int = 0

    // MARK: - Init

    init() {
        let n = BrainSimulation.maxN
        let a = BrainSimulation.maxAttractors
        let g = BrainSimulation.densityGridSize * BrainSimulation.densityGridSize

        positionsX = [Float](repeating: 0, count: n)
        positionsY = [Float](repeating: 0, count: n)
        positionsZ = [Float](repeating: 0, count: n)
        velocitiesX = [Float](repeating: 0, count: n)
        velocitiesY = [Float](repeating: 0, count: n)
        velocitiesZ = [Float](repeating: 0, count: n)
        ages = [Float](repeating: 0, count: n)
        lives = [Float](repeating: 1, count: n)
        hues = [Float](repeating: 0, count: n)
        leaders = [UInt8](repeating: 0, count: n)
        screenX = [Float](repeating: 0, count: n)
        screenY = [Float](repeating: 0, count: n)
        screenDepth = [Float](repeating: 0, count: n)
        pulseBoosts = [Float](repeating: 0, count: n)

        attractorX = [Float](repeating: 0, count: a)
        attractorY = [Float](repeating: 0, count: a)
        attractorZ = [Float](repeating: 0, count: a)
        attractorPhase = (0..<a).map { _ in Float.random(in: 0..<3) }
        attractorPeriod = (0..<a).map { _ in 2.2 + Float.random(in: 0..<2.8) }
        attractorSeed = (0..<a).map { _ in Float.random(in: 0..<1000) }
        attractorPulse = [Float](repeating: 0, count: a)

        densityGrid = [Int](repeating: 0, count: g)
    }

    /// Seed every particle to a valid sphere position. Called once
    /// on init when a profile is known, and again whenever the
    /// profile changes such that previous spawn lives no longer
    /// match (the integrator handles per-particle respawn during
    /// the lerp; this helper is for the initial cold-start mass
    /// respawn).
    func seedAllParticles(profile: BrainProfile, sphereRadius: Float) {
        for i in 0..<BrainSimulation.maxN {
            respawn(at: i, profile: profile, sphereRadius: sphereRadius)
        }
        prevN = profile.n
    }

    // MARK: - Step

    /// Advance the simulation by `dt` seconds against the supplied
    /// (already-lerped) profile. After the call returns, the
    /// renderer reads `positionsX/Y/Z`, `screenX/Y`, `screenDepth`,
    /// `pulseBoosts`, `hues`, `leaders`, `densityGrid`, and the
    /// returned `BrainFrameSlice` for the active count + meanDensity.
    ///
    /// `renderSize` is the canvas pixel size INCLUDING the
    /// RENDER_SCALE oversize (1.5× the layout `size`). The
    /// projection writes `screenX`/`screenY` in this coordinate
    /// space; the renderer can blit verbatim.
    /// `sphereRadius` is `size * 0.5` — the visible sphere stays
    /// at the layout-relative size even though the render canvas
    /// is larger (matches the lab standalone's look).
    @discardableResult
    func step(
        dt: Double,
        profile: BrainProfile,
        sphereRadius: Float,
        renderSize: Float
    ) -> BrainFrameSlice {
        // Clamp dt the same way the TS does (`Math.min(0.05, …)`).
        // A long pause (tab hidden, system sleep) shouldn't fast-
        // forward physics by seconds and explode the integrator.
        let dtF = Float(min(0.05, max(0, dt)))
        elapsedSec += Double(dtF)
        let t = Float(elapsedSec)

        // Respawn newly-active particles when `n` grows.
        let n = profile.n
        if n > prevN {
            for i in prevN..<n {
                respawn(at: i, profile: profile, sphereRadius: sphereRadius)
            }
        }
        prevN = n

        // Rotation update — same expression as the TS so the slow
        // nod cadence matches frame-for-frame.
        rotationY += profile.rot * dtF * 60
        rotationX = -0.18 + sin(t * 0.25) * 0.06

        let shellR = sphereRadius * 0.95

        // Attractor update — Lissajous-style motion + pulse phase.
        let nAtt = min(BrainSimulation.maxAttractors, max(0, profile.attractors))
        for a in 0..<nAtt {
            let s = attractorSeed[a]
            let jitter: Float
            if profile.jitter > 0 {
                jitter = sin(t * 7 + s * 3) * profile.jitter
            } else {
                jitter = 0
            }
            attractorX[a] = sin(t * 0.11 + s) * sphereRadius * 0.55 + jitter * sphereRadius
            attractorY[a] = sin(t * 0.17 + s * 1.3) * sphereRadius * 0.45 + jitter * sphereRadius * 0.7
            attractorZ[a] = cos(t * 0.13 + s * 0.7) * sphereRadius * 0.55 + jitter * sphereRadius * 0.8
            attractorPhase[a] += dtF * profile.pulseRate
            let ph = (attractorPhase[a].truncatingRemainder(dividingBy: attractorPeriod[a]))
                / attractorPeriod[a]
            attractorPulse[a] = ph < 0.08
                ? ph / 0.08
                : max(0, exp(-(ph - 0.08) * 4))
        }

        // Per-particle integrator. We rely on Swift's bounds-checked
        // array access; the JS version is unchecked. Measured cost
        // is dominated by the curl-noise calls (12 sin + 12 cos per
        // particle); the bounds check is a noise-floor add.
        for i in 0..<n {
            // Curl flow — matches TS curlFlow signature.
            let flow = curlFlow(
                x: positionsX[i], y: positionsY[i], z: positionsZ[i],
                t: t, profile: profile
            )
            velocitiesX[i] = velocitiesX[i] * profile.damp + flow.x * profile.flowMag * dtF
            velocitiesY[i] = velocitiesY[i] * profile.damp + flow.y * profile.flowMag * dtF
            velocitiesZ[i] = velocitiesZ[i] * profile.damp + flow.z * profile.flowMag * dtF

            // Attractor pull — find nearest, apply 1/d-decayed pull
            // toward it, derive a pulse boost from its current
            // synapse phase scaled by closeness.
            var nearPulse: Float = 0
            if nAtt > 0, profile.synapse > 0 {
                var minD2 = Float.infinity
                var minA = 0
                for a in 0..<nAtt {
                    let dx = attractorX[a] - positionsX[i]
                    let dy = attractorY[a] - positionsY[i]
                    let dz = attractorZ[a] - positionsZ[i]
                    let d2 = dx * dx + dy * dy + dz * dz
                    if d2 < minD2 {
                        minD2 = d2
                        minA = a
                    }
                }
                let d = max(0.0001, sqrt(minD2))
                let pullF = (profile.synapse * 40) / (1 + d * 0.02)
                velocitiesX[i] += ((attractorX[minA] - positionsX[i]) / d) * pullF * dtF
                velocitiesY[i] += ((attractorY[minA] - positionsY[i]) / d) * pullF * dtF
                velocitiesZ[i] += ((attractorZ[minA] - positionsZ[i]) / d) * pullF * dtF
                let closeness = max(0, 1 - d / (sphereRadius * 0.6))
                nearPulse = attractorPulse[minA] * closeness
            }
            // Pulse boost decays exponentially toward zero, but
            // takes the max of decayed-prev and fresh-near so a
            // freshly-pulsed attractor lights up the whole region
            // immediately rather than waiting for the next decay
            // step.
            pulseBoosts[i] = max(pulseBoosts[i] * exp(-dtF * 3), nearPulse)

            // Shell pull — soft attraction toward the sphere
            // surface. Particles inside get pushed out; particles
            // outside get pulled in.
            let r2 = positionsX[i] * positionsX[i]
                + positionsY[i] * positionsY[i]
                + positionsZ[i] * positionsZ[i]
            let r = max(0.0001, sqrt(r2))
            let shellForce = -(r - shellR) * profile.shellPull
            velocitiesX[i] += (positionsX[i] / r) * shellForce * dtF * 3
            velocitiesY[i] += (positionsY[i] / r) * shellForce * dtF * 3
            velocitiesZ[i] += (positionsZ[i] / r) * shellForce * dtF * 3

            // Swirl — incremental Y-axis rotation around the cluster.
            let sw = profile.swirl * dtF * 0.4
            let cosSw = cos(sw)
            let sinSw = sin(sw)
            let nx = positionsX[i] * cosSw - positionsZ[i] * sinSw
            let nz = positionsX[i] * sinSw + positionsZ[i] * cosSw
            positionsX[i] = nx
            positionsZ[i] = nz

            // Integrate.
            positionsX[i] += velocitiesX[i] * dtF * 15
            positionsY[i] += velocitiesY[i] * dtF * 15
            positionsZ[i] += velocitiesZ[i] * dtF * 15

            // Lifecycle.
            ages[i] += dtF
            if ages[i] > lives[i] {
                respawn(at: i, profile: profile, sphereRadius: sphereRadius)
            }
        }

        // Project to screen + depth. Same formulas as the TS:
        //   xr = x cosY + z sinY
        //   zr = -x sinY + z cosY
        //   yr = y cosX - zr sinX
        //   zr = y sinX + zr cosX
        //   persp = 1 + zr / (R*3)
        let cosY = cos(rotationY)
        let sinY = sin(rotationY)
        let cosX = cos(rotationX)
        let sinX = sin(rotationX)
        let cx = renderSize / 2
        let cy = renderSize / 2
        for i in 0..<n {
            let xr = positionsX[i] * cosY + positionsZ[i] * sinY
            var zr = -positionsX[i] * sinY + positionsZ[i] * cosY
            let yr = positionsY[i] * cosX - zr * sinX
            zr = positionsY[i] * sinX + zr * cosX
            let persp = 1 + zr / (sphereRadius * 3)
            screenX[i] = cx + xr * persp
            screenY[i] = cy + yr * persp
            screenDepth[i] = (zr + sphereRadius) / (2 * sphereRadius)
        }

        // Density grid — count projected particles per 24×24 cell
        // over the full render canvas. Used by the renderer to
        // boost crowded regions.
        for cellIdx in densityGrid.indices { densityGrid[cellIdx] = 0 }
        let cellSz = renderSize / Float(BrainSimulation.densityGridSize)
        for i in 0..<n {
            let gx = Int(screenX[i] / cellSz)
            let gy = Int(screenY[i] / cellSz)
            if gx >= 0,
               gx < BrainSimulation.densityGridSize,
               gy >= 0,
               gy < BrainSimulation.densityGridSize {
                densityGrid[gy * BrainSimulation.densityGridSize + gx] += 1
            }
        }
        let meanDens = Float(n)
            / Float(BrainSimulation.densityGridSize * BrainSimulation.densityGridSize)

        return BrainFrameSlice(count: n, meanDensity: meanDens)
    }

    // MARK: - Particle respawn

    /// Place particle `i` at a uniformly-random direction on the
    /// sphere with a radius in `[0.55, 1.0] * sphereRadius`. Resets
    /// velocity, age, and seeds a fresh hue + leader bit. Same
    /// distribution as the TS `respawn(i, p)`.
    private func respawn(
        at i: Int,
        profile: BrainProfile,
        sphereRadius: Float
    ) {
        let u = Float.random(in: 0..<1)
        let v = Float.random(in: 0..<1)
        let theta = 2 * Float.pi * u
        let phi = acos(2 * v - 1)
        let r = sphereRadius * (0.55 + Float.random(in: 0..<0.45))
        positionsX[i] = r * sin(phi) * cos(theta)
        positionsY[i] = r * sin(phi) * sin(theta)
        positionsZ[i] = r * cos(phi)
        velocitiesX[i] = 0
        velocitiesY[i] = 0
        velocitiesZ[i] = 0
        ages[i] = 0
        lives[i] = profile.lmin + Float.random(in: 0..<profile.lrange)
        hues[i] = Float.random(in: 0..<1)
        leaders[i] = Float.random(in: 0..<1) < profile.leaders ? 1 : 0
    }

    // MARK: - Curl noise

    /// Sum-of-sinusoids "noise" function. Not true Perlin / simplex
    /// noise — just three sin·cos products that produce a
    /// reasonably noise-like field cheap enough to call 18× per
    /// particle per frame. Identical formulation to the TS source.
    @inline(__always)
    private func noise(
        _ x: Float, _ y: Float, _ z: Float,
        seed: Float, nfreq: Float
    ) -> Float {
        let f = nfreq
        return sin(x * f + seed) * cos(y * f * 0.9 + seed * 1.7)
            + sin(y * f * 1.1 + seed * 2.1) * cos(z * f + seed * 0.9)
            + sin(z * f * 0.95 + seed * 1.3) * cos(x * f * 1.05 + seed * 2.3)
    }

    /// Curl of two layered noise fields — the high-frequency layer
    /// (`f2 = coh * 3.5`) blends in via `profile.turb`. Returns the
    /// 3D flow vector; the integrator scales by `flowMag * dt`.
    /// Mirror of `curlFlow` in the TS, which uses six closures
    /// over the noise function — Swift doesn't pay for closures
    /// here either, so the shape stays a faithful translation.
    private func curlFlow(
        x: Float, y: Float, z: Float,
        t: Float, profile: BrainProfile
    ) -> (x: Float, y: Float, z: Float) {
        let e = profile.neps
        let ts = t * 0.5

        // Layer 1 — coherence-frequency noise.
        let f1 = profile.coh
        let s11: Float = 11 + ts
        let s12: Float = 53 + ts * 0.9
        let s13: Float = 97 + ts * 1.1
        @inline(__always) func a1(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f1, qq * f1, 0, seed: s11, nfreq: profile.nfreq)
        }
        @inline(__always) func a2(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f1, qq * f1, 0, seed: s12, nfreq: profile.nfreq)
        }
        @inline(__always) func a3(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f1, qq * f1, 0, seed: s13, nfreq: profile.nfreq)
        }
        let cx1 = (a3(x, y + e) - a3(x, y - e)) / (2 * e)
            - (a2(x, z + e) - a2(x, z - e)) / (2 * e)
        let cy1 = (a1(y, z + e) - a1(y, z - e)) / (2 * e)
            - (a3(x + e, y) - a3(x - e, y)) / (2 * e)
        let cz1 = (a2(x + e, z) - a2(x - e, z)) / (2 * e)
            - (a1(x, y + e) - a1(x, y - e)) / (2 * e)

        // Layer 2 — high-frequency turbulence. Offset seeds keep
        // the two layers visually independent.
        let f2 = profile.coh * 3.5
        let s21: Float = 211 + ts * 1.7
        let s22: Float = 313 + ts * 1.5
        let s23: Float = 419 + ts * 1.9
        @inline(__always) func b1(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f2, qq * f2, 0, seed: s21, nfreq: profile.nfreq)
        }
        @inline(__always) func b2(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f2, qq * f2, 0, seed: s22, nfreq: profile.nfreq)
        }
        @inline(__always) func b3(_ pp: Float, _ qq: Float) -> Float {
            noise(pp * f2, qq * f2, 0, seed: s23, nfreq: profile.nfreq)
        }
        let cx2 = (b3(x, y + e) - b3(x, y - e)) / (2 * e)
            - (b2(x, z + e) - b2(x, z - e)) / (2 * e)
        let cy2 = (b1(y, z + e) - b1(y, z - e)) / (2 * e)
            - (b3(x + e, y) - b3(x - e, y)) / (2 * e)
        let cz2 = (b2(x + e, z) - b2(x - e, z)) / (2 * e)
            - (b1(x, y + e) - b1(x, y - e)) / (2 * e)

        let mix = profile.turb
        return (
            x: cx1 * (1 - mix * 0.5) + cx2 * mix * 0.6,
            y: cy1 * (1 - mix * 0.5) + cy2 * mix * 0.6,
            z: cz1 * (1 - mix * 0.5) + cz2 * mix * 0.6
        )
    }
}

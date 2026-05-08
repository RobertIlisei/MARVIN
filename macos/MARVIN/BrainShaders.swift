// BrainShaders — Phase 4d. Metal shader source + the matching Swift
// uniform / instance structs the renderer fills.
//
// ## Why ship the .metal source as a Swift string
//
// SPM 5.10 *can* compile `.metal` files, but it ships them through
// `Bundle.module` — which means the install script
// (`bin/marvin install-macos-app`'s SPM fallback path) would have to
// learn how to find and copy that bundle into
// `Contents/Resources/`, then the runtime would need to locate it
// via Bundle lookup. Three new failure modes for what's effectively
// a ~150-line shader.
//
// The runtime alternative — `MTLDevice.makeLibrary(source:options:)`
// — is the standard Metal-sample path when there's no Xcode target.
// Adds ~50 ms one-time compile cost on first window-open; negligible
// against the cold-start cost of MTKView itself. Both Xcode and SPM
// builds Just Work without bundling extra resources. 4e (compute
// kernel) keeps this same shape — the kernel source goes into the
// same string, the same `makeLibrary` call resolves all entry points.
//
// ## Why pre-multiplied alpha output
//
// The fragment shader writes `color * alpha` and outputs `alpha` as
// the alpha channel — pre-multiplied. The render-pass blend state is
// `srcRGB * 1 + dstRGB * (1 - srcA)`, the classic pre-multiplied
// source-over. Two reasons: (1) particles + fade quads compose
// correctly without per-output gamma fudging, (2) it matches the
// trail-accumulation strategy ADR-0019 §5 picked (single accumulation
// texture, `rgba(0,0,0, 1-trail)` fade per frame).
//
// ## Why Swift mirrors instead of bridging headers
//
// The shader uses three small POD structs (ParticleInstance,
// BrainUniforms, plus a single Float for the fade alpha). Hand-
// mirroring them in Swift is shorter than wiring a bridging header,
// and the compiler enforces the layout match at struct-of-Floats
// granularity. Field order is documented inline; if a field gets
// added on one side and not the other, the renderer's frame goes
// visibly garbage and the discrepancy is one diff away.

import Foundation
import simd

/// Per-particle data uploaded each frame. Layout MUST match
/// `ParticleInstance` in the shader source (24 bytes, 6 × Float32,
/// natural alignment). The renderer writes a contiguous array of
/// these into a single MTLBuffer; the GPU reads them via
/// `instance_id`.
///
/// Field order matches the shader struct exactly. Don't reorder
/// without updating both sides. Don't add fields without bumping
/// the buffer's per-instance stride accordingly.
struct ParticleInstance {
    /// Pixel coordinates in the drawable's coordinate space. The
    /// CPU simulation has already projected (rotation + perspective);
    /// the vertex shader just adds the quad corner offset.
    var screenX: Float
    var screenY: Float
    /// 0..1 depth from the simulation's projection. 0 = back of
    /// sphere, 1 = front. Drives alpha modulation in the fragment.
    var depth: Float
    /// 0..1 hue seed. Maps through the dark-theme NEBULA table or
    /// the light-theme cool gradient in the fragment shader.
    var hue: Float
    /// 0/1 leader bit. Leaders render at full alpha + larger radius;
    /// non-leaders are scaled by `BrainUniforms.dim` and 0.7×
    /// radius. Stored as Float for trivial GPU branch-less use.
    var leader: Float
    /// 0..1 synapse pulse strength. Boosts alpha + injects red mix
    /// when the nearest attractor is mid-pulse.
    var pulseBoost: Float
}

/// Per-frame uniforms for the compute kernel. Layout MUST match
/// `BrainKernelUniforms` in the shader source: 24 × Float32 + 4 ×
/// Int32 + 1 × UInt32 = 116 bytes, no padding (every field is 4
/// bytes, so natural alignment is 4 throughout). Field order is
/// documented inline; if it drifts, the kernel reads garbage and
/// the brain visibly explodes — fast feedback, but worth a comment.
///
/// Time, rotation, and attractor evolution all happen CPU-side
/// (small serial work on the main actor); the kernel is per-particle
/// only. ADR-0019 §3 4e leaves "8 attractors via a small uniform
/// array" as the chosen path — the alternative (attractors as
/// another buffer) buys nothing at this size.
struct BrainKernelUniforms {
    /// Frame delta in seconds. CPU-clamped to `min(0.05, ...)` —
    /// the kernel doesn't re-clamp, so don't pass values above
    /// that or the integrator destabilises.
    var dt: Float
    /// Total simulated seconds (`elapsedSec`). Used as the time
    /// argument to curl noise + attractor motion. Independent of
    /// wall-clock so a paused sim resumes at the same noise phase.
    var time: Float
    /// Visible-sphere radius in pixels. `min(drawableW, drawableH)
    /// / 3` — matches the lab standalone's `R = size / 2` after
    /// accounting for RENDER_SCALE 1.5×.
    var sphereRadius: Float
    /// `min(drawableW, drawableH) / 2`. Sets the half-extent of the
    /// projected coordinate frame the density grid spans (4f wires
    /// the grid into the kernel; at 4e it's unused but kept in
    /// uniforms so the layout doesn't churn).
    var halfRender: Float
    /// `drawableW / 2` — projection center X. The kernel writes
    /// `sx = centerX + xr * persp` so the brain renders centred
    /// even when the drawable is non-square.
    var centerX: Float
    /// `drawableH / 2` — projection center Y. See `centerX`.
    var centerY: Float
    /// `dgSize / min(w, h)` — pre-divided so the kernel binning
    /// step is `gx = int((sx - margin) * invCellSize)`. Unused at
    /// 4e (no density grid yet); kept in layout for 4f.
    var invCellSize: Float
    /// Precomputed `cos(rotationY)`, `sin(rotationY)` etc. Doing
    /// the trig CPU-side once per frame avoids 12 000 redundant
    /// transcendental calls in the kernel.
    var cosY: Float
    var sinY: Float
    var cosX: Float
    var sinX: Float
    /// Swirl rotation matrix entries. `cosSw = cos(profile.swirl *
    /// dt * 0.4)`. Applied once per particle as a tiny in-place
    /// Y-axis rotation around the cluster.
    var cosSw: Float
    var sinSw: Float
    // Profile knobs needed by the integrator. Subset of
    // BrainProfile — only fields the kernel reads. Render-time
    // knobs (dotR, dotA, chroma, redMix, …) live in BrainUniforms.
    var damp: Float
    var flowMag: Float
    var shellPull: Float
    var nfreq: Float
    var neps: Float
    /// `profile.lmin` — minimum life seconds at respawn.
    var lmin: Float
    /// `profile.lrange` — additional random life range. lives ∈
    /// [lmin, lmin + lrange).
    var lrange: Float
    var synapse: Float
    var coh: Float
    var turb: Float
    /// `profile.leaders` — fraction of particles spawned as
    /// leaders. The kernel does `rand01() < leadersFrac ? 1 : 0`
    /// per respawn.
    var leadersFrac: Float
    /// Active particle count for this frame (`profile.n`). The
    /// kernel early-exits for `iid >= n`.
    var n: Int32
    /// Active attractor count (`profile.attractors`, capped at 8).
    var nAtt: Int32
    /// Previous frame's `n`. Particles in `[prevN, n)` get a fresh
    /// respawn at the start of the kernel — covers a profile-lerp
    /// that grows the active count (e.g. idle→thinking 8000→12000).
    var prevN: Int32
    /// Density-grid resolution. Unused at 4e (kernel doesn't bin).
    /// Kept so 4f can wire it without restructuring uniforms.
    var dgSize: Int32
    /// Per-frame seed for the kernel's Wang-hash RNG. Combined with
    /// `iid` so each particle sees a unique stream that's also
    /// different across frames. CPU advances this each step.
    var frameSeed: UInt32
}

/// Per-frame uniforms for the render passes. Layout MUST match
/// `BrainUniforms` in the shader (32 bytes, 7 × Float32 + 2 × Int32
/// with viewport packed as float2 first). Driven by the lerped
/// BrainProfile + theme.
struct BrainUniforms {
    /// Drawable size in pixels. The vertex shader divides by this
    /// to convert pixel-space positions to NDC.
    var viewportPx: SIMD2<Float>
    /// Base particle radius in pixels. From `profile.dotR`.
    var dotR: Float
    /// Base alpha (0..1). From `profile.dotA`.
    var dotA: Float
    /// Non-leader alpha multiplier. From `profile.dim`.
    var dim: Float
    /// Chromatic aberration strength. Wired but unused at 4d (ghost
    /// passes are 4f cleanup, see comment in BrainMetalRenderer).
    var chroma: Float
    /// 0..1 red-mix knob. From `profile.redMix`. Scales the synapse
    /// red-tint applied to particles near a pulsing attractor.
    var redMix: Float
    /// Density boost (CPU computes per-frame mean density and bin
    /// counts; the shader applies the boost). 4e moves this into the
    /// shader; for 4d we keep the boost CPU-side and pass it as a
    /// scalar — avoids needing a density-grid texture binding now.
    /// Currently passed as 0 placeholder (renderer applies via the
    /// per-instance pulseBoost when integrating the boost in 4e).
    var dens: Float
    /// Synapse pulse multiplier. From `profile.pulse`.
    var pulse: Float
    /// 0 = light theme, 1 = dark theme. Selects the fragment branch
    /// (NEBULA table on dark, hsl-style gradient on light).
    var palette: Int32
    /// 0 = normal (thinking/tool/writing), 1 = idle, 2 = error.
    /// Mirrors the TS `isIdle` / `isError` switch in the draw loop.
    var mode: Int32
}

/// Metal shader source for Phase 4d. Hosted as a Swift string so
/// `MTLDevice.makeLibrary(source:options:)` compiles at first
/// renderer init without needing a `.metallib` shipped in the
/// bundle (see file-level comment).
///
/// Three pipelines are defined here:
///
/// - `brain_particle_*` — instanced quads, six vertices per quad,
///   one quad per active particle. Reads `ParticleInstance` array
///   + `BrainUniforms`.
/// - `brain_full_*` + `brain_fade_fs` — fullscreen fade pass.
///   Writes `(0, 0, 0, fadeAlpha)` over the accumulation texture.
///   Drives the trail decay each frame (lower `trail` profile → more
///   fade).
/// - `brain_full_*` + `brain_composite_fs` — fullscreen composite
///   that samples the accumulation texture into the drawable.
///
/// All three share `brain_full_vs` for the fullscreen quad VS
/// (deduplicated; both fade + composite use the same NDC corners).
let brainMetalShaderSource = """
#include <metal_stdlib>
using namespace metal;

// Six-stop dark-theme nebula palette. Verbatim from
// brain-liquid.tsx's NEBULA constant — RGB 0..255 normalised to
// 0..1 here. Refresh by re-extracting the lab; the Swift/Metal copy
// stays line-aligned with the TS source the same way BrainProfile
// stays aligned with PROFILES.
constant float3 NEBULA[6] = {
    float3( 64.0/255.0,  96.0/255.0, 160.0/255.0),
    float3( 96.0/255.0, 128.0/255.0, 192.0/255.0),
    float3(128.0/255.0, 160.0/255.0, 224.0/255.0),
    float3(160.0/255.0, 192.0/255.0, 224.0/255.0),
    float3(192.0/255.0, 224.0/255.0, 240.0/255.0),
    float3(224.0/255.0, 232.0/255.0, 248.0/255.0),
};

// Six-vertex quad — two triangles. Used by both the per-particle
// vertex shader (corners = local quad UV) and the fullscreen passes
// (corners = NDC).
constant float2 kQuad[6] = {
    float2(-1.0, -1.0), float2( 1.0, -1.0), float2(-1.0,  1.0),
    float2( 1.0, -1.0), float2( 1.0,  1.0), float2(-1.0,  1.0),
};

struct ParticleInstance {
    float screenX;
    float screenY;
    float depth;
    float hue;
    float leader;
    float pulseBoost;
};

struct BrainUniforms {
    float2 viewportPx;
    float dotR;
    float dotA;
    float dim;
    float chroma;
    float redMix;
    float dens;
    float pulse;
    int palette;
    int mode;
};

// Pixel → NDC, with the Y axis flipped so the simulation's "screen
// Y grows downward" matches Metal's clip space. CPU side already
// projects in pixel space (cx, cy + xr*persp etc.); we just fold
// the flip + scale here.
inline float2 px_to_ndc(float2 px, float2 viewport) {
    float2 ndc = (px / viewport) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    return ndc;
}

// ─────────────────────────────────────────────────────────────────
// Particle pipeline — instanced quads, one per particle.
// ─────────────────────────────────────────────────────────────────

struct ParticleVOut {
    float4 position [[position]];
    float2 quadUV;
    float depth;
    float hue;
    float leader;
    float pulseBoost;
};

vertex ParticleVOut brain_particle_vs(
    uint vid [[vertex_id]],
    uint iid [[instance_id]],
    constant ParticleInstance* particles [[buffer(0)]],
    constant BrainUniforms& u [[buffer(1)]]
) {
    ParticleInstance p = particles[iid];
    float2 corner = kQuad[vid];
    // Leader vs follower radius — matches the TS draw step's
    // `dr = p.dotR * (lead ? 1 : 0.7) * (1 + pB * 0.4)`.
    float r = u.dotR
        * (p.leader > 0.5 ? 1.0 : 0.7)
        * (1.0 + p.pulseBoost * 0.4);
    float2 worldPx = float2(p.screenX, p.screenY) + corner * r;

    ParticleVOut o;
    o.position = float4(px_to_ndc(worldPx, u.viewportPx), 0.0, 1.0);
    o.quadUV = corner;
    o.depth = p.depth;
    o.hue = p.hue;
    o.leader = p.leader;
    o.pulseBoost = p.pulseBoost;
    return o;
}

fragment float4 brain_particle_fs(
    ParticleVOut in [[stage_in]],
    constant BrainUniforms& u [[buffer(0)]]
) {
    // Soft circular falloff — the canvas FillRect square becomes a
    // round-ish dot once we discard fragments outside r=1. The
    // multiplier `1 - r2` is a quick parabolic falloff; cheaper
    // than a Gaussian and visually indistinguishable at <8 px.
    float r2 = dot(in.quadUV, in.quadUV);
    if (r2 > 1.0) discard_fragment();
    float falloff = 1.0 - r2;

    float leadK = (in.leader > 0.5) ? 1.0 : u.dim;
    float pBoost = 1.0 + in.pulseBoost * u.pulse;
    // Same composite alpha formula as the TS draw step
    // (densBoost is folded into pulseBoost on the CPU side at 4d;
    // the shader sees a combined boost — 4e splits them apart with
    // a real density-grid texture binding).
    float a = u.dotA * (0.5 + in.depth * 0.6) * leadK * pBoost * falloff;
    a = clamp(a, 0.0, 1.0);

    float redK = in.pulseBoost * u.redMix;
    bool isDark = (u.palette == 1);

    float3 color;
    if (u.mode == 2) {
        // error — angry red, slightly dimmer on dark to avoid
        // saturating the bloom.
        if (isDark) {
            color = float3(
                1.0,
                (90.0 + 40.0 * (1.0 - redK)) / 255.0,
                (90.0 + 40.0 * (1.0 - redK)) / 255.0
            );
            a *= 0.7;
        } else {
            color = float3(160.0/255.0, 20.0/255.0, 20.0/255.0);
        }
    } else if (u.mode == 1) {
        // idle — calm cool white on dark, dark grey on light.
        if (isDark) {
            color = float3(220.0/255.0, 230.0/255.0, 255.0/255.0);
            a *= 0.7;
        } else {
            color = float3(40.0/255.0, 48.0/255.0, 64.0/255.0);
        }
    } else {
        // normal — thinking / tool / writing.
        if (isDark) {
            // Sample the 6-stop NEBULA table by t01 = hue*0.6 + d*0.4.
            // Matches the TS `idx = floor(t01 * NEBULA.length)`.
            float t01 = clamp(in.hue * 0.6 + in.depth * 0.4, 0.0, 0.999);
            int idx = int(floor(t01 * 6.0));
            float3 base = NEBULA[idx];
            if (redK > 0.0) {
                base = float3(
                    base.r + (1.0 - base.r) * redK,
                    base.g + (80.0/255.0 - base.g) * redK,
                    base.b + (100.0/255.0 - base.b) * redK
                );
            }
            color = base;
            a = min(1.0, a * 1.2);
        } else {
            // Light theme: the TS uses HSL with hue=212+18*hue,
            // sat=22+16*hue%, lit=40+(1-d)*8%. We approximate with
            // a cool blue-grey gradient since the bulk of the look
            // is the chroma + saturation interplay; perceived
            // colour matches at the 4d gate. 4f tightens this if
            // the light-theme pass shows visible drift.
            float h = in.hue;
            float d01 = in.depth;
            float3 cool = mix(
                float3(0.30, 0.34, 0.42),
                float3(0.50, 0.54, 0.62),
                h
            );
            cool *= (0.85 + d01 * 0.15);
            if (redK > 0.05) {
                cool = float3(
                    (120.0 + 80.0 * redK) / 255.0,
                    ( 40.0 + 30.0 * (1.0 - redK)) / 255.0,
                    ( 60.0 + 40.0 * (1.0 - redK)) / 255.0
                );
            }
            color = cool;
        }
    }

    // Pre-multiplied alpha output. The blend state is
    //   srcRGB*1 + dstRGB*(1-srcA)  (rgb)
    //   srcA*1   + dstA*(1-srcA)    (alpha)
    // i.e. classic pre-multiplied source-over.
    return float4(color * a, a);
}

// ─────────────────────────────────────────────────────────────────
// Fullscreen pipeline — used by both fade + composite.
// ─────────────────────────────────────────────────────────────────

struct FullVOut {
    float4 position [[position]];
    float2 uv;
};

vertex FullVOut brain_full_vs(uint vid [[vertex_id]]) {
    FullVOut o;
    float2 corner = kQuad[vid];
    o.position = float4(corner, 0.0, 1.0);
    // UV in 0..1 with origin top-left. Matches MTLTexture's UV
    // convention so the composite reads non-flipped.
    o.uv = corner * 0.5 + 0.5;
    return o;
}

// Fade pass — blends the accumulation toward the window background
// (not black). fadeParams = float4(bgR*a, bgG*a, bgB*a, a) where a
// is (1 - trail). With pre-multiplied source-over blending the
// accumulation converges to the background colour each frame:
//   dstRGB = bgRGB*a + dstRGB*(1-a)  →  bgRGB after many frames.
// Drives the trail decay each frame: profile.trail near 1.0 → small
// a → long trails; trail near 0 → a ≈ 1 → instant fade to bg.
fragment float4 brain_fade_fs(
    FullVOut in [[stage_in]],
    constant float4& fadeParams [[buffer(0)]]
) {
    return fadeParams;
}

// Composite pass — sample the accumulation texture into the
// drawable. Linear filter so a pixel-doubled (RENDER_SCALE) source
// reads cleanly into the MTKView's drawable. 4f wires the drawable
// scale through the renderSize calc; for 4d the textures are 1:1.
fragment float4 brain_composite_fs(
    FullVOut in [[stage_in]],
    texture2d<float> tex [[texture(0)]]
) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return tex.sample(s, in.uv);
}

// ─────────────────────────────────────────────────────────────────
// Phase 4e — compute kernel for the per-frame physics.
//
// Mirror of BrainSimulation.step's per-particle work in MSL. The
// CPU still drives time (elapsedSec), rotation accumulators, and
// the eight attractors (Lissajous + pulse phase) — those are
// trivial serial work and packing them into a uniform/attractor
// buffer is cheaper than dispatching another kernel for them.
//
// Buffer bindings:
//   0..2  — posX/Y/Z   (rw, SoA, length maxN)
//   3..5  — velX/Y/Z   (rw, SoA, length maxN)
//   6,7   — ages/lives (rw, length maxN)
//   8,9   — hues/leaders (rw — written on respawn, length maxN)
//   10    — pulseBoosts (rw, length maxN)
//   11    — instances  (w only, length maxN — read by vertex
//                       shader's brain_particle_vs)
//   12    — attractors (r, float4[8] — xyz + pulse)
//   13    — uniforms   (r, BrainKernelUniforms)
//
// The render passes that follow this kernel (fade + particle +
// composite) read `instances`. Metal's automatic hazard tracking
// inserts the compute→render barrier when both encoders run on the
// same command buffer (default behaviour for buffers we make
// without `hazardTrackingMode = .untracked`).
//
// ─────────────────────────────────────────────────────────────────

constant int kDG = 24;

struct BrainKernelUniforms {
    float dt;
    float time;
    float sphereRadius;
    float halfRender;
    float centerX;
    float centerY;
    float invCellSize;
    float cosY;
    float sinY;
    float cosX;
    float sinX;
    float cosSw;
    float sinSw;
    float damp;
    float flowMag;
    float shellPull;
    float nfreq;
    float neps;
    float lmin;
    float lrange;
    float synapse;
    float coh;
    float turb;
    float leadersFrac;
    int n;
    int nAtt;
    int prevN;
    int dgSize;
    uint frameSeed;
};

// Wang hash — fast, low-quality but uniform-enough for spawn
// positions + life jitter + leader bit. Same family the GPU
// particle-system literature uses; the visual signature matches
// the CPU port's `Float.random` to within "you can't tell which
// is which side-by-side" (the 4e DoD doesn't require bit-exact
// reproduction, see ADR-0019 §3).
inline uint wangHash(uint x) {
    x = (x ^ 61u) ^ (x >> 16);
    x *= 9u;
    x ^= x >> 4;
    x *= 0x27d4eb2du;
    x ^= x >> 15;
    return x;
}

// Pull a 0..1 float from the rolling RNG state. Mutates state so
// successive calls produce uncorrelated values.
inline float rand01(thread uint& state) {
    state = wangHash(state);
    return float(state) * (1.0f / 4294967296.0f);
}

// Sum-of-sinusoids "noise" function. Verbatim from
// BrainSimulation.swift — three sin·cos products, cheap, called 18×
// per particle per frame inside curlFlow. Not Perlin/simplex; the
// fingerprint is the lab's, not a textbook noise.
inline float brainNoise(float x, float y, float z, float seed, float nfreq) {
    float f = nfreq;
    return sin(x * f + seed) * cos(y * f * 0.9f + seed * 1.7f)
         + sin(y * f * 1.1f + seed * 2.1f) * cos(z * f + seed * 0.9f)
         + sin(z * f * 0.95f + seed * 1.3f) * cos(x * f * 1.05f + seed * 2.3f);
}

// Planar 2D-evaluated noise — the third coordinate is always 0,
// the first two are scaled by the layer's frequency. Mirrors the
// `a1`/`a2`/`a3` (and `b1`/`b2`/`b3`) closures in the Swift port.
inline float brainPlanar(float pp, float qq, float f, float seed, float nfreq) {
    return brainNoise(pp * f, qq * f, 0.0f, seed, nfreq);
}

// Curl of two layered planar noise fields. The high-frequency layer
// (`f2 = coh * 3.5`) blends in via `turb`. Same shape as
// BrainSimulation.swift's `curlFlow`. The cross-component derivative
// pairs are written out in full because Metal doesn't have a
// closure or tuple-returning compound that's any cheaper than the
// flat math here.
inline float3 brainCurlFlow(
    float3 p, float t,
    float coh, float turb, float neps, float nfreq
) {
    float e = neps;
    float ts = t * 0.5f;

    // Layer 1.
    float f1 = coh;
    float s11 = 11.0f + ts;
    float s12 = 53.0f + ts * 0.9f;
    float s13 = 97.0f + ts * 1.1f;
    float cx1 = (brainPlanar(p.x,     p.y + e, f1, s13, nfreq) - brainPlanar(p.x,     p.y - e, f1, s13, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x,     p.z + e, f1, s12, nfreq) - brainPlanar(p.x,     p.z - e, f1, s12, nfreq)) / (2.0f * e);
    float cy1 = (brainPlanar(p.y,     p.z + e, f1, s11, nfreq) - brainPlanar(p.y,     p.z - e, f1, s11, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x + e, p.y,     f1, s13, nfreq) - brainPlanar(p.x - e, p.y,     f1, s13, nfreq)) / (2.0f * e);
    float cz1 = (brainPlanar(p.x + e, p.z,     f1, s12, nfreq) - brainPlanar(p.x - e, p.z,     f1, s12, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x,     p.y + e, f1, s11, nfreq) - brainPlanar(p.x,     p.y - e, f1, s11, nfreq)) / (2.0f * e);

    // Layer 2 — high-frequency turbulence.
    float f2 = coh * 3.5f;
    float s21 = 211.0f + ts * 1.7f;
    float s22 = 313.0f + ts * 1.5f;
    float s23 = 419.0f + ts * 1.9f;
    float cx2 = (brainPlanar(p.x,     p.y + e, f2, s23, nfreq) - brainPlanar(p.x,     p.y - e, f2, s23, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x,     p.z + e, f2, s22, nfreq) - brainPlanar(p.x,     p.z - e, f2, s22, nfreq)) / (2.0f * e);
    float cy2 = (brainPlanar(p.y,     p.z + e, f2, s21, nfreq) - brainPlanar(p.y,     p.z - e, f2, s21, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x + e, p.y,     f2, s23, nfreq) - brainPlanar(p.x - e, p.y,     f2, s23, nfreq)) / (2.0f * e);
    float cz2 = (brainPlanar(p.x + e, p.z,     f2, s22, nfreq) - brainPlanar(p.x - e, p.z,     f2, s22, nfreq)) / (2.0f * e)
              - (brainPlanar(p.x,     p.y + e, f2, s21, nfreq) - brainPlanar(p.x,     p.y - e, f2, s21, nfreq)) / (2.0f * e);

    float mix = turb;
    return float3(
        cx1 * (1.0f - mix * 0.5f) + cx2 * mix * 0.6f,
        cy1 * (1.0f - mix * 0.5f) + cy2 * mix * 0.6f,
        cz1 * (1.0f - mix * 0.5f) + cz2 * mix * 0.6f
    );
}

// Place particle `i` at a uniformly-random direction on the sphere
// with radius in [0.55, 1.0] × sphereRadius. Same distribution as
// BrainSimulation.respawn, just driven by a Wang-hash thread-local
// RNG instead of Float.random.
inline void brainRespawn(
    uint i, thread uint& rng,
    float sphereRadius,
    float lmin, float lrange,
    float leadersFrac,
    device float* posX, device float* posY, device float* posZ,
    device float* velX, device float* velY, device float* velZ,
    device float* ages, device float* lives,
    device float* hues, device float* leaders
) {
    float u = rand01(rng);
    float v = rand01(rng);
    float theta = 2.0f * M_PI_F * u;
    float phi = acos(2.0f * v - 1.0f);
    float r = sphereRadius * (0.55f + rand01(rng) * 0.45f);
    posX[i] = r * sin(phi) * cos(theta);
    posY[i] = r * sin(phi) * sin(theta);
    posZ[i] = r * cos(phi);
    velX[i] = 0.0f;
    velY[i] = 0.0f;
    velZ[i] = 0.0f;
    ages[i] = 0.0f;
    lives[i] = lmin + rand01(rng) * lrange;
    hues[i] = rand01(rng);
    leaders[i] = (rand01(rng) < leadersFrac) ? 1.0f : 0.0f;
}

kernel void brain_step_kernel(
    uint iid                                 [[thread_position_in_grid]],
    device float* posX                       [[buffer(0)]],
    device float* posY                       [[buffer(1)]],
    device float* posZ                       [[buffer(2)]],
    device float* velX                       [[buffer(3)]],
    device float* velY                       [[buffer(4)]],
    device float* velZ                       [[buffer(5)]],
    device float* ages                       [[buffer(6)]],
    device float* lives                      [[buffer(7)]],
    device float* hues                       [[buffer(8)]],
    device float* leaders                    [[buffer(9)]],
    device float* pulseBoosts                [[buffer(10)]],
    device ParticleInstance* instances       [[buffer(11)]],
    constant float4* attractors              [[buffer(12)]],
    constant BrainKernelUniforms& u          [[buffer(13)]]
) {
    if (iid >= uint(u.n)) {
        return;
    }

    // Per-particle RNG. Multiply by a large odd 32-bit constant so
    // adjacent threads see well-separated seed streams; XOR with
    // the per-frame seed so each frame's stream is uncorrelated
    // with the last.
    uint rng = wangHash(iid * 2654435761u + u.frameSeed);

    // Newly-active particle when n grew this frame (e.g. profile
    // lerp idle→thinking 8000→12000). One-shot fresh respawn.
    if (iid >= uint(u.prevN)) {
        brainRespawn(iid, rng, u.sphereRadius, u.lmin, u.lrange, u.leadersFrac,
                     posX, posY, posZ, velX, velY, velZ, ages, lives, hues, leaders);
    }

    float3 pos = float3(posX[iid], posY[iid], posZ[iid]);
    float3 vel = float3(velX[iid], velY[iid], velZ[iid]);

    // Curl flow.
    float3 flow = brainCurlFlow(pos, u.time, u.coh, u.turb, u.neps, u.nfreq);
    vel = vel * u.damp + flow * u.flowMag * u.dt;

    // Attractor pull + per-particle pulse boost.
    float nearPulse = 0.0f;
    if (u.nAtt > 0 && u.synapse > 0.0f) {
        float minD2 = INFINITY;
        int minA = 0;
        for (int a = 0; a < u.nAtt; a++) {
            float3 ap = attractors[a].xyz;
            float3 d = ap - pos;
            float d2 = dot(d, d);
            if (d2 < minD2) {
                minD2 = d2;
                minA = a;
            }
        }
        float d = max(0.0001f, sqrt(minD2));
        float pullF = (u.synapse * 40.0f) / (1.0f + d * 0.02f);
        float3 toA = (attractors[minA].xyz - pos) / d;
        vel += toA * pullF * u.dt;
        float closeness = max(0.0f, 1.0f - d / (u.sphereRadius * 0.6f));
        nearPulse = attractors[minA].w * closeness;
    }
    pulseBoosts[iid] = max(pulseBoosts[iid] * exp(-u.dt * 3.0f), nearPulse);

    // Shell pull — soft attraction toward the sphere surface.
    float r2 = dot(pos, pos);
    float r = max(0.0001f, sqrt(r2));
    float shellR = u.sphereRadius * 0.95f;
    float shellForce = -(r - shellR) * u.shellPull;
    vel += (pos / r) * shellForce * u.dt * 3.0f;

    // Swirl — incremental Y-axis rotation around the cluster.
    float nx = pos.x * u.cosSw - pos.z * u.sinSw;
    float nz = pos.x * u.sinSw + pos.z * u.cosSw;
    pos = float3(nx, pos.y, nz);

    // Integrate.
    pos += vel * u.dt * 15.0f;

    // Lifecycle.
    ages[iid] += u.dt;
    bool respawned = false;
    if (ages[iid] > lives[iid]) {
        brainRespawn(iid, rng, u.sphereRadius, u.lmin, u.lrange, u.leadersFrac,
                     posX, posY, posZ, velX, velY, velZ, ages, lives, hues, leaders);
        // Reload the freshly-spawned position for projection.
        pos = float3(posX[iid], posY[iid], posZ[iid]);
        respawned = true;
    }
    if (!respawned) {
        posX[iid] = pos.x;
        posY[iid] = pos.y;
        posZ[iid] = pos.z;
        velX[iid] = vel.x;
        velY[iid] = vel.y;
        velZ[iid] = vel.z;
    }

    // Project to screen + depth. Same composition as
    // BrainSimulation: rotate by Y, then by X, then perspective.
    float xr  =  pos.x * u.cosY + pos.z * u.sinY;
    float zr0 = -pos.x * u.sinY + pos.z * u.cosY;
    float yr  =  pos.y * u.cosX - zr0 * u.sinX;
    float zr  =  pos.y * u.sinX + zr0 * u.cosX;
    float persp = 1.0f + zr / (u.sphereRadius * 3.0f);

    // Centre at the drawable midpoint, not at half-renderSize —
    // fixes the off-centre projection visible at 4d when the
    // preview window is non-square.
    float sx = u.centerX + xr * persp;
    float sy = u.centerY + yr * persp;
    float sd = (zr + u.sphereRadius) / (2.0f * u.sphereRadius);

    // Write the instance the renderer reads. We do NOT atomic-bin
    // density here (deferred to 4f per the BrainKernelUniforms
    // comment on `dgSize`).
    ParticleInstance ins;
    ins.screenX = sx;
    ins.screenY = sy;
    ins.depth = sd;
    ins.hue = hues[iid];
    ins.leader = leaders[iid];
    ins.pulseBoost = pulseBoosts[iid];
    instances[iid] = ins;
}
"""

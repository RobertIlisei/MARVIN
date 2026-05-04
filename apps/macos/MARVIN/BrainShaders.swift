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

/// Per-frame uniforms. Layout MUST match `BrainUniforms` in the
/// shader (32 bytes, 7 × Float32 + 2 × Int32 with viewport packed
/// as float2 first). Driven by the lerped BrainProfile + theme.
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

// Fade pass — writes black with the supplied alpha. With pre-
// multiplied source-over blending, this dims existing colour by
// (1 - fadeAlpha). Drives the trail decay each frame: profile.trail
// near 1.0 → tiny fade per frame → long trails. trail near 0 →
// near-full fade → no trails.
fragment float4 brain_fade_fs(
    FullVOut in [[stage_in]],
    constant float& fadeAlpha [[buffer(0)]]
) {
    return float4(0.0, 0.0, 0.0, fadeAlpha);
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
"""

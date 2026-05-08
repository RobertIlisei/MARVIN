// BrainProfile — Phase 4a foundation. Swift mirror of the TypeScript
// `Profile` struct + `PROFILES` table from
// sidecar/src/components/brain/brain-liquid.tsx, plus the lerp +
// easing primitives the per-frame loop depends on.
//
// Source of truth: the `Brain Lab _standalone_.html` the design team
// ships. To re-sync after a lab update, the procedure is unchanged
// from the TS port — drive the standalone via Playwright, click each
// state pill, read every `input[type="range"]` into the table below.
// The standalone wins on every conflict; native Swift and TypeScript
// targets are both downstream of the same lab numbers.
//
// ## Why mirror, not share
//
// We considered emitting a JSON file from the TS source and reading
// it from Swift. Two reasons we didn't:
//
//   1. The Profile struct is 25 numeric fields; round-tripping
//      through JSON adds a parser + a build step + a "did the
//      shapes drift?" failure mode for what's effectively a
//      compile-time constant.
//   2. The `idle` state in MARVIN deliberately deviates from the
//      lab's idle preset (slowed motion knobs; see the comment on
//      that case below). A shared JSON file would make that override
//      either invisible (drift waits to bite) or duplicated. Keeping
//      both targets responsible for the same hand-edit is safer.
//
// When the lab updates: edit both files. Diff them against each
// other before merging — drift between them IS the bug.

import Foundation

/// MARVIN's coarse UI state — drives the brain's behavioural profile.
/// Mirror of `MarvinUiState` in sidecar/src/components/chat/types.ts.
/// `cancelling` is in the TS union for symmetry with the chat state
/// machine but doesn't get its own profile; it falls through to
/// `idle` (matching the TS `PROFILES[state] ?? PROFILES.idle`
/// lookup).
enum BrainState: String, CaseIterable {
    case boot
    case idle
    case thinking
    case tool
    case writing
    case error

    /// Map a coarse busy/idle bridge signal to a default state.
    /// Phase 4f wires bridge.isBusy through this; the resulting
    /// state can still be overridden when the chat layer learns
    /// finer-grained context (e.g. `tool` vs `thinking`).
    static func defaultFor(busy: Bool) -> BrainState {
        busy ? .thinking : .idle
    }
}

/// Per-state tuning extracted from the Brain Lab standalone.
/// 25 fields — every numeric knob the lab exposes plus four
/// MARVIN-specific extras (pulseRate / redMix / rot / jitter).
/// Refresh procedure: see the file-level comment.
struct BrainProfile: Equatable {
    var n: Int
    var flowMag: Float
    var damp: Float
    var swirl: Float
    var shellPull: Float
    var nfreq: Float
    var neps: Float
    var lmin: Float
    var lrange: Float
    var dotR: Float
    var dotA: Float
    var chroma: Float
    var trail: Float
    var turb: Float
    var coh: Float
    var leaders: Float
    var dim: Float
    var attractors: Int
    var synapse: Float
    var pulse: Float
    var dens: Float
    var pulseRate: Float
    var redMix: Float
    var rot: Float
    var jitter: Float
}

extension BrainProfile {
    /// The five canonical profiles. Numbers verbatim from the TS
    /// `PROFILES` dict. Field order also matches so a side-by-side
    /// diff between this file and brain-liquid.tsx is line-for-line
    /// when the lab refresh runs.
    ///
    /// Phase 5f adds one extra MARVIN-only profile — `boot` — which
    /// has no TS counterpart (the web brain doesn't run a launch
    /// animation). A small cluster of bright, fast particles that
    /// reads as a "spark" before the brain settles into idle: ~50
    /// large luminous dots with strong outward velocity + heavy
    /// trail blur. The transition `boot → idle` runs 1.8 s instead
    /// of the default 700 ms so the lerp on `n` (50 → 8000) reads
    /// as dots gradually populating around the spark.
    static let table: [BrainState: BrainProfile] = [
        .boot: BrainProfile(
            n: 60, flowMag: 480, damp: 0.88, swirl: 1.6, shellPull: 0.0,
            nfreq: 0.45, neps: 1.8, lmin: 1.5, lrange: 2.5, dotR: 3.6, dotA: 1.0,
            chroma: 8.0, trail: 0.94, turb: 0.45, coh: 0.05, leaders: 0.85, dim: 0.05,
            attractors: 1, synapse: 0.0, pulse: 2.5, dens: 0.4, pulseRate: 1.6,
            redMix: 0.10, rot: 0.0015, jitter: 0.20
        ),
        // `idle` deliberately deviates from the lab's idle preset
        // (which still carries an active-brainstorm energy:
        // flowMag=180, swirl=0.6, turb=0.3, rot=0.0015). User
        // feedback was that MARVIN's idle shouldn't read as
        // "thinking quietly" — it should read as actually resting.
        // So motion knobs are slowed; visual knobs (N, chroma,
        // dotR, dotA, halo, palette, trail) stay lab-faithful so
        // the brain still LOOKS the same, just calmer.
        //
        // If you re-extract the lab via Playwright, do NOT
        // overwrite this block — the slowdown is intentional. Only
        // the four other states (thinking, tool, writing, error)
        // are mirror-aligned. The TS file carries the same warning
        // on the same case.
        .idle: BrainProfile(
            n: 8000, flowMag: 70, damp: 0.97, swirl: 0.22, shellPull: 1.2,
            nfreq: 0.16, neps: 1.4, lmin: 5.5, lrange: 7.0, dotR: 1.0, dotA: 0.55,
            chroma: 2.0, trail: 0.86, turb: 0.10, coh: 0.16, leaders: 0.18, dim: 0.18,
            attractors: 2, synapse: 0.8, pulse: 0.6, dens: 0.7, pulseRate: 0.4,
            redMix: 0.05, rot: 0.0007, jitter: 0
        ),
        .thinking: BrainProfile(
            n: 12000, flowMag: 370, damp: 0.93, swirl: 1.75, shellPull: 1.4,
            nfreq: 0.41, neps: 1.95, lmin: 3.7, lrange: 3.0, dotR: 0.95, dotA: 0.20,
            chroma: 5.0, trail: 0.55, turb: 0.3, coh: 0.14, leaders: 0.7, dim: 0.46,
            attractors: 8, synapse: 1.2, pulse: 2.0, dens: 2.0, pulseRate: 0.9,
            redMix: 0.25, rot: 0.0025, jitter: 0
        ),
        .tool: BrainProfile(
            n: 10000, flowMag: 20, damp: 0.5, swirl: 0.4, shellPull: 0.0,
            nfreq: 0.6, neps: 1.65, lmin: 2.5, lrange: 4.0, dotR: 1.0, dotA: 0.6,
            chroma: 3.5, trail: 0.72, turb: 0.46, coh: 0.18, leaders: 0.32, dim: 0.22,
            attractors: 8, synapse: 3.0, pulse: 1.4, dens: 1.0, pulseRate: 1.2,
            redMix: 0.3, rot: 0.0035, jitter: 0
        ),
        .writing: BrainProfile(
            n: 10000, flowMag: 430, damp: 0.63, swirl: 1.5, shellPull: 1.3,
            nfreq: 0.38, neps: 1.8, lmin: 4.5, lrange: 5.0, dotR: 1.05, dotA: 0.30,
            chroma: 5.0, trail: 0.76, turb: 0.22, coh: 0.11, leaders: 0.3, dim: 0.48,
            attractors: 5, synapse: 3.0, pulse: 2.0, dens: 2.0, pulseRate: 1.7,
            redMix: 0.45, rot: 0.008, jitter: 0
        ),
        .error: BrainProfile(
            n: 8000, flowMag: 370, damp: 0.94, swirl: 1.75, shellPull: 0.65,
            nfreq: 0.41, neps: 1.4, lmin: 0.5, lrange: 10.0, dotR: 1.05, dotA: 0.9,
            chroma: 5.0, trail: 0.69, turb: 0.3, coh: 0.25, leaders: 0.12, dim: 0.26,
            attractors: 3, synapse: 3.0, pulse: 2.0, dens: 1.0, pulseRate: 2.2,
            redMix: 0.85, rot: 0.002, jitter: 0.15
        ),
    ]

    /// Lookup helper that mirrors the TS `PROFILES[state] ??
    /// PROFILES.idle` fallback. Used by the state machine when a
    /// transition starts and the destination state is one we
    /// haven't profiled (e.g. `cancelling` → falls back to idle).
    static func profile(for state: BrainState) -> BrainProfile {
        table[state] ?? table[.idle]!
    }
}

// MARK: - Easing + lerp

/// Smoothstep cubic. Matches `easeInOutCubic` in brain-liquid.tsx
/// — 0→1 with zero derivative at both ends, so a transition starts
/// gently, accelerates through the middle, and settles softly into
/// the target rather than snapping.
func easeInOutCubic(_ raw: Float) -> Float {
    if raw <= 0 { return 0 }
    if raw >= 1 { return 1 }
    return raw < 0.5
        ? 4 * raw * raw * raw
        : 1 - pow(-2 * raw + 2, 3) / 2
}

/// Per-frame transition lerp. Returns the interpolated profile
/// `t` of the way from `a` to `b`. Integer fields (`n`,
/// `attractors`) are rounded so the per-frame loop can use them
/// as array indices without per-step rounding noise.
///
/// Mirror of `lerpProfile` in brain-liquid.tsx, which iterates the
/// `PROFILE_KEYS` array and rounds the same two fields. Swift's
/// statically-typed mirror is more verbose but compiles to the
/// same set of float multiplies + add + truncate.
func lerpProfile(_ a: BrainProfile, _ b: BrainProfile, t: Float) -> BrainProfile {
    func lf(_ va: Float, _ vb: Float) -> Float { va + (vb - va) * t }
    func li(_ va: Int, _ vb: Int) -> Int {
        Int((Float(va) + (Float(vb) - Float(va)) * t).rounded())
    }
    return BrainProfile(
        n: li(a.n, b.n),
        flowMag: lf(a.flowMag, b.flowMag),
        damp: lf(a.damp, b.damp),
        swirl: lf(a.swirl, b.swirl),
        shellPull: lf(a.shellPull, b.shellPull),
        nfreq: lf(a.nfreq, b.nfreq),
        neps: lf(a.neps, b.neps),
        lmin: lf(a.lmin, b.lmin),
        lrange: lf(a.lrange, b.lrange),
        dotR: lf(a.dotR, b.dotR),
        dotA: lf(a.dotA, b.dotA),
        chroma: lf(a.chroma, b.chroma),
        trail: lf(a.trail, b.trail),
        turb: lf(a.turb, b.turb),
        coh: lf(a.coh, b.coh),
        leaders: lf(a.leaders, b.leaders),
        dim: lf(a.dim, b.dim),
        attractors: li(a.attractors, b.attractors),
        synapse: lf(a.synapse, b.synapse),
        pulse: lf(a.pulse, b.pulse),
        dens: lf(a.dens, b.dens),
        pulseRate: lf(a.pulseRate, b.pulseRate),
        redMix: lf(a.redMix, b.redMix),
        rot: lf(a.rot, b.rot),
        jitter: lf(a.jitter, b.jitter)
    )
}

// MARK: - Transition state machine

/// One running transition between two profiles. The renderer asks
/// `currentProfile(now:)` each frame; before any transition has
/// started the function returns the seed target. Mirrors the
/// `fromProfileRef` / `toProfileRef` / `transitionStartRef` trio
/// + `profile()` getter inside `BrainLiquidImpl` — packaged as a
/// struct so the call site is testable without a SwiftUI view.
struct BrainTransition {
    /// Default 1200 ms transition. Deliberately longer than the TS
    /// `TRANSITION_MS` (700 ms) — user feedback was that the native
    /// brain "snaps" between states. Combined with the linear
    /// (un-eased) ramp below, the result is a steady, perceptually-
    /// smooth fade rather than a back-loaded burst. The TS still
    /// runs 700 ms with `easeInOutCubic`; if you re-sync from the
    /// lab don't overwrite either of these — the divergence is
    /// intentional. ADR-0022-adjacent.
    static let defaultDurationMs: Double = 1200

    var current: BrainState
    var from: BrainProfile
    var to: BrainProfile
    /// Wall-clock millisecond mark when the current transition
    /// started. `0` means "no transition has fired yet" — the
    /// renderer should snap to `to` and return.
    var startedAtMs: Double
    /// Phase 5f — per-transition duration override. Most transitions
    /// run at 700 ms (matches the TS). The launch animation
    /// (`boot → idle`) runs longer (~1.8 s) so the lerp on `n` reads
    /// as dots gradually populating; a 700 ms ramp from 60 to 8000
    /// particles looks like a teleport, not a fade-in.
    var durationMs: Double

    init(initialState: BrainState) {
        let p = BrainProfile.profile(for: initialState)
        self.current = initialState
        self.from = p
        self.to = p
        self.startedAtMs = 0
        self.durationMs = Self.defaultDurationMs
    }

    /// Begin a transition into `next`. No-op when `next` matches
    /// the current state — saves a redundant re-lerp on a flicker
    /// that ends where it started. Otherwise the renderer's
    /// `currentProfile` smooths the next `durationMs` (700 ms by
    /// default; longer on launch when boot → idle).
    mutating func transition(
        to next: BrainState,
        nowMs: Double,
        durationMs: Double = BrainTransition.defaultDurationMs
    ) {
        if next == current { return }
        // Capture the in-flight profile so a transition that fires
        // mid-lerp continues from where the brain is on screen,
        // not from `current`'s settled profile. Without this a
        // rapid idle→thinking→tool sequence would visibly snap.
        let inflight = currentProfile(nowMs: nowMs)
        from = inflight
        to = BrainProfile.profile(for: next)
        startedAtMs = nowMs
        self.durationMs = durationMs
        current = next
    }

    /// The interpolated profile to render right now. Once the
    /// transition has fully elapsed, returns `to` verbatim (and
    /// the call is a no-op until the next `transition`).
    ///
    /// Linear ramp — no easing curve. The TS counterpart uses
    /// `easeInOutCubic` which front-loads change into the middle of
    /// the window; user feedback was that this reads as snappy on
    /// the native brain (the cubic's mid-burst is most of the
    /// visible change, with the ends feeling like a hold). Linear
    /// over the longer 1200 ms window above gives a steady,
    /// smoothly-paced transition. The TS retains its cubic ease for
    /// parity with the lab.
    func currentProfile(nowMs: Double) -> BrainProfile {
        if startedAtMs == 0 { return to }
        let raw = Float((nowMs - startedAtMs) / durationMs)
        if raw >= 1 { return to }
        let t = max(0, min(1, raw))
        return lerpProfile(from, to, t: t)
    }
}

// @ts-nocheck — ported canvas physics engine. Uses Float32/Uint8/Int32
// typed arrays with rigorously bounded indexing (0 <= i < N <= MAX_N),
// so every lookup is defined at runtime. Under `noUncheckedIndexedAccess`
// this would require ~100 `!` assertions on every px[i]/sx[i]/leader[i]
// read, which is pure noise. Scoping the opt-out here keeps the rest of
// the tree fully strict.
"use client";

import { memo, useEffect, useRef } from "react";

import { isResizing } from "@/lib/panel-resize-signal";

import type { MarvinUiState } from "../chat/types";

/**
 * BrainLiquid — canvas particle-field brain. Curl-noise flow, roaming
 * attractors with synapse pulses, density boost, per-state behaviour
 * profiles, and theme-aware painting (nebula iridescent on dark,
 * desaturated slate-ink on light).
 *
 * Drop-in replacement for the old SVG-based MarvinBrain: same `state` +
 * `size` props, no other wiring needed. Self-observes `<html data-theme>`
 * so the paint loop picks up theme changes without a remount.
 *
 * Source of truth: the `Brain Lab` standalone HTML the design team ships.
 * To re-sync after a lab update, drive the standalone via Playwright,
 * cycle the state pills, and read every `input[type="range"]` value into
 * the PROFILES table below. Standalone wins on every conflict.
 */
interface Profile {
  N: number;
  flowMag: number;
  damp: number;
  swirl: number;
  shellPull: number;
  nfreq: number;
  neps: number;
  lmin: number;
  lrange: number;
  dotR: number;
  dotA: number;
  chroma: number;
  trail: number;
  turb: number;
  coh: number;
  leaders: number;
  dim: number;
  attractors: number;
  synapse: number;
  pulse: number;
  dens: number;
  pulseRate: number;
  redMix: number;
  rot: number;
  jitter: number;
}

// Per-state tuning extracted from the Brain Lab standalone (the upstream
// design source). Every value is mirror-aligned to the standalone's
// sliders; pulseRate / redMix / rot / jitter are MARVIN-specific knobs
// the standalone doesn't expose, so they keep their pre-existing values.
//
// Refresh procedure: drive `Brain Lab _standalone_.html` via Playwright,
// click each state pill, read all `input[type="range"]` values. The
// standalone is the source of truth — when these drift from the lab, the
// lab wins.
const PROFILES: Record<MarvinUiState, Profile> = {
  // `idle` deliberately deviates from the lab's idle preset (which
  // still carries an active-brainstorm energy: flowMag=180, swirl=0.6,
  // turb=0.3, rot=0.0015). User feedback was that MARVIN's idle
  // shouldn't read as "thinking quietly" — it should read as actually
  // resting. So motion knobs are slowed; visual knobs (N, chroma,
  // dotR, dotA, halo, palette, trail) are kept lab-faithful so the
  // brain still LOOKS the same, just calmer.
  //
  // If you re-extract the lab via Playwright, do NOT overwrite this
  // block — the slowdown is intentional. Only the four other states
  // (thinking, tool, writing, error) are mirror-aligned.
  idle: {
    N: 8000, flowMag: 70, damp: 0.97, swirl: 0.22, shellPull: 1.2,
    nfreq: 0.16, neps: 1.4, lmin: 5.5, lrange: 7.0, dotR: 1.0, dotA: 0.55,
    chroma: 2.0, trail: 0.86, turb: 0.10, coh: 0.16, leaders: 0.18, dim: 0.18,
    attractors: 2, synapse: 0.8, pulse: 0.6, dens: 0.7, pulseRate: 0.4,
    redMix: 0.05, rot: 0.0007, jitter: 0,
  },
  thinking: {
    N: 12000, flowMag: 370, damp: 0.93, swirl: 1.75, shellPull: 1.4,
    nfreq: 0.41, neps: 1.95, lmin: 3.7, lrange: 3.0, dotR: 0.95, dotA: 0.20,
    chroma: 5.0, trail: 0.55, turb: 0.3, coh: 0.14, leaders: 0.7, dim: 0.46,
    attractors: 8, synapse: 1.2, pulse: 2.0, dens: 2.0, pulseRate: 0.9,
    redMix: 0.25, rot: 0.0025, jitter: 0,
  },
  tool: {
    N: 10000, flowMag: 20, damp: 0.5, swirl: 0.4, shellPull: 0.0,
    nfreq: 0.6, neps: 1.65, lmin: 2.5, lrange: 4.0, dotR: 1.0, dotA: 0.6,
    chroma: 3.5, trail: 0.72, turb: 0.46, coh: 0.18, leaders: 0.32, dim: 0.22,
    attractors: 8, synapse: 3.0, pulse: 1.4, dens: 1.0, pulseRate: 1.2,
    redMix: 0.3, rot: 0.0035, jitter: 0,
  },
  writing: {
    N: 10000, flowMag: 430, damp: 0.63, swirl: 1.5, shellPull: 1.3,
    nfreq: 0.38, neps: 1.8, lmin: 4.5, lrange: 5.0, dotR: 1.05, dotA: 0.30,
    chroma: 5.0, trail: 0.76, turb: 0.22, coh: 0.11, leaders: 0.3, dim: 0.48,
    attractors: 5, synapse: 3.0, pulse: 2.0, dens: 2.0, pulseRate: 1.7,
    redMix: 0.45, rot: 0.008, jitter: 0,
  },
  error: {
    N: 8000, flowMag: 370, damp: 0.94, swirl: 1.75, shellPull: 0.65,
    nfreq: 0.41, neps: 1.4, lmin: 0.5, lrange: 10.0, dotR: 1.05, dotA: 0.9,
    chroma: 5.0, trail: 0.69, turb: 0.3, coh: 0.25, leaders: 0.12, dim: 0.26,
    attractors: 3, synapse: 3.0, pulse: 2.0, dens: 1.0, pulseRate: 2.2,
    redMix: 0.85, rot: 0.002, jitter: 0.15,
  },
};

// Smoothstep cubic — used to ease parameter transitions when the
// state changes. 0→1 with zero derivative at both ends, so the
// transition starts gently, accelerates through the middle, and
// settles softly into the new profile rather than snapping.
function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// Lerp every numeric field of a Profile. N is rounded so per-frame
// loops can use it as an integer index. Every other field is a
// plain float lerp.
const PROFILE_KEYS = [
  "N", "flowMag", "damp", "swirl", "shellPull",
  "nfreq", "neps", "lmin", "lrange", "dotR", "dotA",
  "chroma", "trail", "turb", "coh", "leaders", "dim",
  "attractors", "synapse", "pulse", "dens", "pulseRate",
  "redMix", "rot", "jitter",
] as const satisfies readonly (keyof Profile)[];

function lerpProfile(a: Profile, b: Profile, t: number): Profile {
  const out = {} as Profile;
  for (const k of PROFILE_KEYS) {
    const va = a[k];
    const vb = b[k];
    const lerped = va + (vb - va) * t;
    out[k] = (k === "N" || k === "attractors" ? Math.round(lerped) : lerped);
  }
  return out;
}

// How long state→state transitions take. ~700 ms feels naturally
// soft without dragging — long enough that flow / chroma / trail
// shifts are visible, short enough that a stalled "thinking" state
// settles before the user notices.
const TRANSITION_MS = 700;

// Default cycle for `autoCycle`. `error` is included so the landing
// hero shows the brain's full vocabulary; it's brief so it doesn't
// read as a real failure to a user passing through.
const CYCLE: ReadonlyArray<{ state: MarvinUiState; holdMs: number }> = [
  { state: "idle",     holdMs: 6000 },
  { state: "thinking", holdMs: 4500 },
  { state: "tool",     holdMs: 3500 },
  { state: "writing",  holdMs: 4500 },
  { state: "error",    holdMs: 1800 },
];

// How much larger the canvas is than the layout `size` prop. The
// perspective projection can push particles to ~1.33×R from center;
// at R = size * 0.5 that's ~0.67×size on the diagonal — beyond the
// canvas's 0.5×size side. Without extra render area, particles bunch
// up at the rectangular boundary and reveal the canvas as a square.
// 1.5 gives the projection a comfortable margin on every side and
// is what makes the brain feel like it sits ON the page rather than
// inside a contained rectangle. Cost: ~2.25× pixel count for the
// trail-dim fillRect (a single cheap GPU op); per-particle work is
// unchanged.
const RENDER_SCALE = 1.5;

// Nebula palette (dark-theme iridescent tint).
const NEBULA: Array<[number, number, number]> = [
  [64, 96, 160],
  [96, 128, 192],
  [128, 160, 224],
  [160, 192, 224],
  [192, 224, 240],
  [224, 232, 248],
];

function BrainLiquidImpl({
  size = 280,
  state = "idle",
  autoCycle = false,
}: {
  size?: number;
  state?: MarvinUiState;
  /**
   * If true, the brain ignores the `state` prop and rotates through
   * the `CYCLE` table on its own — used by the landing-page hero so
   * the brain has presence even when there's no real MARVIN session
   * driving it. Each state still uses the standalone-derived
   * profile; transitions between them are smoothed via the lerp
   * machinery below.
   */
  autoCycle?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The state we are TARGETING (most recently set, by prop or cycle).
  // `stateRef.current` always matches; the rendered profile lerps
  // toward `PROFILES[targetStateRef.current]`.
  const targetStateRef = useRef<MarvinUiState>(state);
  const stateRef = useRef<MarvinUiState>(state);
  // Snapshots used to interpolate between the previous fully-settled
  // (or in-flight) profile and the new target. `transitionStartRef`
  // stores the timestamp when the most recent target change kicked
  // off — `easeInOutCubic((now - start) / TRANSITION_MS)` is the
  // mix factor each frame.
  const fromProfileRef = useRef<Profile>(PROFILES[state] ?? PROFILES.idle);
  const toProfileRef = useRef<Profile>(PROFILES[state] ?? PROFILES.idle);
  const currentProfileRef = useRef<Profile>(PROFILES[state] ?? PROFILES.idle);
  const transitionStartRef = useRef<number>(0);
  const themeRef = useRef<"dark" | "light">("light");

  // Internal helper: kick off a transition from whatever the brain
  // is rendering RIGHT NOW (currentProfileRef) toward the new state.
  // Snapshotting the in-flight profile (not the previous target)
  // means rapid state changes blend smoothly instead of snapping
  // back to whatever the previous "from" was.
  const beginTransition = (next: MarvinUiState) => {
    if (next === stateRef.current && next === targetStateRef.current) return;
    fromProfileRef.current = { ...currentProfileRef.current };
    toProfileRef.current = PROFILES[next] ?? PROFILES.idle;
    transitionStartRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    targetStateRef.current = next;
    stateRef.current = next;
  };

  // Prop-driven state changes (skipped when autoCycle owns the brain).
  useEffect(() => {
    if (autoCycle) return;
    beginTransition(state);
    // beginTransition is referentially stable enough — only refs are touched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, autoCycle]);

  // Auto-cycle the state through `CYCLE` for the landing hero. Skips
  // the interval entirely when `autoCycle` is false, so MARVIN's
  // real-state brain (project page) is unaffected. Hold times come
  // from CYCLE; the lerp smooths the actual visual change.
  useEffect(() => {
    if (!autoCycle) return;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const advance = () => {
      const step = CYCLE[i] ?? CYCLE[0];
      if (step) beginTransition(step.state);
      i = (i + 1) % CYCLE.length;
      timer = setTimeout(advance, step?.holdMs ?? 4000);
    };
    advance();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCycle]);

  useEffect(() => {
    const update = () => {
      themeRef.current =
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "dark"
          : "light";
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Render canvas larger than the layout `size` so the perspective
    // projection (`persp = 1 + zr/(R*3)` → up to ~1.33×R from center)
    // doesn't get clipped at the canvas rectangle. With R = size*0.5,
    // projected positions reach ~0.67×size from center; the layout
    // canvas extends only 0.5×size on the sides, so particles bunch
    // up at the rectangular boundary and reveal the square. The
    // standalone hides this by being 700px in the lab — we replicate
    // by oversizing the canvas, keeping the sphere at the same
    // *absolute* pixel size, and centering it via negative offsets.
    // The wrapper still measures `size` for layout.
    const renderSize = size * RENDER_SCALE;
    canvas.style.width = `${renderSize}px`;
    canvas.style.height = `${renderSize}px`;
    canvas.width = renderSize * dpr;
    canvas.height = renderSize * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Lerped profile getter. Each frame asks for the *interpolated*
    // current profile rather than snapping to the new state immediately.
    // beginTransition() (above) sets fromProfileRef + toProfileRef +
    // transitionStartRef when state changes; here we mix between them
    // by `easeInOutCubic((now - start) / TRANSITION_MS)`. Once t
    // reaches 1 the function returns the target verbatim.
    const profile = (): Profile => {
      const start = transitionStartRef.current;
      if (start === 0) {
        // No transition has ever fired — render the seed target.
        currentProfileRef.current = toProfileRef.current;
        return currentProfileRef.current;
      }
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const raw = (now - start) / TRANSITION_MS;
      if (raw >= 1) {
        currentProfileRef.current = toProfileRef.current;
        return currentProfileRef.current;
      }
      const t = easeInOutCubic(Math.max(0, raw));
      currentProfileRef.current = lerpProfile(
        fromProfileRef.current,
        toProfileRef.current,
        t,
      );
      return currentProfileRef.current;
    };

    // Allocate for max N across any state so we never reallocate. Must be
    // >= max(PROFILES[*].N) — `thinking` is currently the ceiling at
    // 12000. Bumping this is cheap (≈14 typed-array allocations of
    // MAX_N × 4 bytes = ~672 KB at 12000); the per-frame cost scales
    // linearly with the *active* profile's N, not MAX_N.
    const MAX_N = 12000;
    const px = new Float32Array(MAX_N);
    const py = new Float32Array(MAX_N);
    const pz = new Float32Array(MAX_N);
    const vx = new Float32Array(MAX_N);
    const vy = new Float32Array(MAX_N);
    const vz = new Float32Array(MAX_N);
    const age = new Float32Array(MAX_N);
    const life = new Float32Array(MAX_N);
    const hue = new Float32Array(MAX_N);
    const leader = new Uint8Array(MAX_N);
    const sx = new Float32Array(MAX_N);
    const sy = new Float32Array(MAX_N);
    const sd = new Float32Array(MAX_N);
    const pulseBoost = new Float32Array(MAX_N);

    const cx = renderSize / 2;
    const cy = renderSize / 2;
    // Sphere radius stays at `size * 0.5` in absolute pixels — the
    // visible sphere keeps the standalone's `radius % = 0.5` look
    // even though the canvas is RENDER_SCALE larger. The extra
    // canvas area is "escape room" for projected particles.
    const R = size * 0.5;

    function respawn(i: number, p: Profile) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = R * (0.55 + Math.random() * 0.45);
      px[i] = r * Math.sin(phi) * Math.cos(theta);
      py[i] = r * Math.sin(phi) * Math.sin(theta);
      pz[i] = r * Math.cos(phi);
      vx[i] = 0;
      vy[i] = 0;
      vz[i] = 0;
      age[i] = 0;
      life[i] = p.lmin + Math.random() * p.lrange;
      hue[i] = Math.random();
      leader[i] = Math.random() < p.leaders ? 1 : 0;
    }
    {
      const p0 = profile();
      for (let i = 0; i < MAX_N; i++) respawn(i, p0);
    }

    // Curl noise — sums of sinusoidal noise, differenced to form curl.
    function noise(
      x: number,
      y: number,
      z: number,
      seed: number,
      nfreq: number,
    ): number {
      const f = nfreq;
      return (
        Math.sin(x * f + seed) * Math.cos(y * f * 0.9 + seed * 1.7) +
        Math.sin(y * f * 1.1 + seed * 2.1) * Math.cos(z * f + seed * 0.9) +
        Math.sin(z * f * 0.95 + seed * 1.3) *
          Math.cos(x * f * 1.05 + seed * 2.3)
      );
    }
    const flowOut: [number, number, number] = [0, 0, 0];
    function curlFlow(
      x: number,
      y: number,
      z: number,
      t: number,
      p: Profile,
      out: [number, number, number],
    ) {
      const e = p.neps;
      const ts = t * 0.5;
      const f1 = p.coh;
      const A1a = (pp: number, qq: number) =>
        noise(pp * f1, qq * f1, 0, 11 + ts, p.nfreq);
      const A2a = (pp: number, qq: number) =>
        noise(pp * f1, qq * f1, 0, 53 + ts * 0.9, p.nfreq);
      const A3a = (pp: number, qq: number) =>
        noise(pp * f1, qq * f1, 0, 97 + ts * 1.1, p.nfreq);
      const cx1 =
        (A3a(x, y + e) - A3a(x, y - e)) / (2 * e) -
        (A2a(x, z + e) - A2a(x, z - e)) / (2 * e);
      const cy1 =
        (A1a(y, z + e) - A1a(y, z - e)) / (2 * e) -
        (A3a(x + e, y) - A3a(x - e, y)) / (2 * e);
      const cz1 =
        (A2a(x + e, z) - A2a(x - e, z)) / (2 * e) -
        (A1a(x, y + e) - A1a(x, y - e)) / (2 * e);
      const f2 = p.coh * 3.5;
      const A1b = (pp: number, qq: number) =>
        noise(pp * f2, qq * f2, 0, 211 + ts * 1.7, p.nfreq);
      const A2b = (pp: number, qq: number) =>
        noise(pp * f2, qq * f2, 0, 313 + ts * 1.5, p.nfreq);
      const A3b = (pp: number, qq: number) =>
        noise(pp * f2, qq * f2, 0, 419 + ts * 1.9, p.nfreq);
      const cx2 =
        (A3b(x, y + e) - A3b(x, y - e)) / (2 * e) -
        (A2b(x, z + e) - A2b(x, z - e)) / (2 * e);
      const cy2 =
        (A1b(y, z + e) - A1b(y, z - e)) / (2 * e) -
        (A3b(x + e, y) - A3b(x - e, y)) / (2 * e);
      const cz2 =
        (A2b(x + e, z) - A2b(x - e, z)) / (2 * e) -
        (A1b(x, y + e) - A1b(x, y - e)) / (2 * e);
      const mix = p.turb;
      out[0] = cx1 * (1 - mix * 0.5) + cx2 * mix * 0.6;
      out[1] = cy1 * (1 - mix * 0.5) + cy2 * mix * 0.6;
      out[2] = cz1 * (1 - mix * 0.5) + cz2 * mix * 0.6;
    }

    // Attractors — moving focal points that particles are gently pulled
    // towards; pulse periodically to produce synapse-like flashes.
    const MAX_ATT = 8;
    const attX = new Float32Array(MAX_ATT);
    const attY = new Float32Array(MAX_ATT);
    const attZ = new Float32Array(MAX_ATT);
    const attPhase = new Float32Array(MAX_ATT);
    const attPeriod = new Float32Array(MAX_ATT);
    const attSeed = new Float32Array(MAX_ATT);
    const attPulse = new Float32Array(MAX_ATT);
    for (let i = 0; i < MAX_ATT; i++) {
      attPhase[i] = Math.random() * 3;
      attPeriod[i] = 2.2 + Math.random() * 2.8;
      attSeed[i] = Math.random() * 1000;
    }

    const DG = 24;
    const dgrid = new Int32Array(DG * DG);

    let rotY = 0;
    let rotX = -0.18;
    let last = performance.now();
    let t = 0;
    let raf = 0;
    // Tracks the previous frame's particle count so we can respawn
    // newly-active indices when N grows mid-transition. Without this,
    // particles 8000–11999 would pop in from stale positions when
    // idle (N=8000) lerps up to thinking (N=12000).
    let prevN = 0;
    // A3 perf: when MARVIN is idle, render at ~30 fps instead of the
    // native ~60 fps. The 4,500-particle idle profile costs real CPU
    // on a MacBook battery; halving the frame rate roughly halves
    // that cost while preserving the "breathing" feel. Active states
    // (thinking / tool / writing) stay at full 60 fps because the
    // motion is information-bearing — slowing them would read as lag.
    // Time-based gate (not frame-count) so the throttle adapts to
    // monitor refresh rates ≠ 60 Hz (ProMotion, 120 Hz, 144 Hz).
    const IDLE_FRAME_MS = 33;
    // Reduced-motion accommodation. When the user has
    // `prefers-reduced-motion: reduce` set, slow every state down to
    // ~10 fps instead of skipping the brain entirely — particle count
    // (N) is part of MARVIN's identity and stays at the profile's
    // setting per user feedback. The cost we trade off is responsiveness
    // of the per-state animation, which reduced-motion users have
    // explicitly opted out of anyway. Audit finding #17.
    const REDUCED_FRAME_MS = 100;
    let lastRendered = 0;

    // Visibility + reduced-motion gates. RAF is technically already
    // throttled by the browser when a tab is hidden, but Chromium can
    // still render to compositor layers and chew CPU on backgrounded
    // canvases; explicitly cancelling the loop on hide is the safe
    // path. Resume when the tab returns.
    let running = typeof document !== "undefined" ? !document.hidden : true;
    const reducedMotionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reducedMotion = reducedMotionQuery?.matches ?? false;

    const onVisibility = () => {
      const next = !document.hidden;
      if (next === running) return;
      running = next;
      if (running) {
        // Reset the dt-baseline so we don't fast-forward physics by
        // however long the tab was hidden.
        last = performance.now();
        raf = requestAnimationFrame(step);
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    const onReducedMotionChange = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
    };
    reducedMotionQuery?.addEventListener?.("change", onReducedMotionChange);

    function step(now: number) {
      if (!running) {
        // The visibilitychange handler will reschedule. Bail without
        // queuing a self-rAF — otherwise we'd silently consume CPU on
        // a hidden tab.
        return;
      }
      // While the user is dragging a PanelResizeHandle, skip the paint
      // and just reschedule. The drag handler in react-resizable-panels
      // does heavy synchronous layout work; competing with it for the
      // main thread makes both the drag and the brain feel laggy.
      // `isResizing()` flips back to false ~120 ms after the last
      // layout pulse, so the brain catches up smoothly.
      if (isResizing()) {
        raf = requestAnimationFrame(step);
        return;
      }
      const frameMs = reducedMotion
        ? REDUCED_FRAME_MS
        : stateRef.current === "idle"
          ? IDLE_FRAME_MS
          : 0;
      if (frameMs > 0 && now - lastRendered < frameMs) {
        raf = requestAnimationFrame(step);
        return;
      }
      lastRendered = now;

      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;

      const p = profile();
      const N = p.N;
      // Respawn freshly-active particles so transitions that GROW N
      // (idle→thinking: 8000→12000) bring particles in from valid
      // sphere positions instead of the stale coords left over from
      // the last time those indices were active.
      if (N > prevN) {
        for (let i = prevN; i < N; i++) respawn(i, p);
      }
      prevN = N;

      rotY += p.rot * dt * 60;
      rotX = -0.18 + Math.sin(t * 0.25) * 0.06;

      const shellR = R * 0.95;
      const nAtt = Math.min(MAX_ATT, p.attractors | 0);
      for (let a = 0; a < nAtt; a++) {
        const s = attSeed[a];
        const jitter = p.jitter ? Math.sin(t * 7 + s * 3) * p.jitter : 0;
        attX[a] = Math.sin(t * 0.11 + s) * R * 0.55 + jitter * R;
        attY[a] = Math.sin(t * 0.17 + s * 1.3) * R * 0.45 + jitter * R * 0.7;
        attZ[a] = Math.cos(t * 0.13 + s * 0.7) * R * 0.55 + jitter * R * 0.8;
        attPhase[a] += dt * p.pulseRate;
        const ph = (attPhase[a] % attPeriod[a]) / attPeriod[a];
        attPulse[a] =
          ph < 0.08 ? ph / 0.08 : Math.max(0, Math.exp(-(ph - 0.08) * 4));
      }

      for (let i = 0; i < N; i++) {
        curlFlow(px[i], py[i], pz[i], t, p, flowOut);
        vx[i] = vx[i] * p.damp + flowOut[0] * p.flowMag * dt;
        vy[i] = vy[i] * p.damp + flowOut[1] * p.flowMag * dt;
        vz[i] = vz[i] * p.damp + flowOut[2] * p.flowMag * dt;

        let nearPulse = 0;
        if (nAtt > 0 && p.synapse > 0) {
          let minD2 = Infinity;
          let minA = 0;
          for (let a = 0; a < nAtt; a++) {
            const dx = attX[a] - px[i];
            const dy = attY[a] - py[i];
            const dz = attZ[a] - pz[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < minD2) {
              minD2 = d2;
              minA = a;
            }
          }
          const d = Math.sqrt(minD2) || 0.0001;
          const pullF = (p.synapse * 40) / (1 + d * 0.02);
          vx[i] += ((attX[minA] - px[i]) / d) * pullF * dt;
          vy[i] += ((attY[minA] - py[i]) / d) * pullF * dt;
          vz[i] += ((attZ[minA] - pz[i]) / d) * pullF * dt;
          const closeness = Math.max(0, 1 - d / (R * 0.6));
          nearPulse = attPulse[minA] * closeness;
        }
        pulseBoost[i] = Math.max(
          pulseBoost[i] * Math.exp(-dt * 3),
          nearPulse,
        );

        const r2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
        const r = Math.sqrt(r2) || 0.0001;
        const shellForce = -(r - shellR) * p.shellPull;
        vx[i] += (px[i] / r) * shellForce * dt * 3;
        vy[i] += (py[i] / r) * shellForce * dt * 3;
        vz[i] += (pz[i] / r) * shellForce * dt * 3;

        const sw = p.swirl * dt * 0.4;
        const nx = px[i] * Math.cos(sw) - pz[i] * Math.sin(sw);
        const nz = px[i] * Math.sin(sw) + pz[i] * Math.cos(sw);
        px[i] = nx;
        pz[i] = nz;

        px[i] += vx[i] * dt * 15;
        py[i] += vy[i] * dt * 15;
        pz[i] += vz[i] * dt * 15;

        age[i] += dt;
        if (age[i] > life[i]) respawn(i, p);
      }

      // Trail fade via destination-out so the canvas background (CSS)
      // remains transparent and the page bg shows through. The
      // rectangle is the FULL canvas (renderSize), not the layout
      // size — anything else would leave un-faded residue in the
      // overflow band.
      const effTrail = Math.min(0.99, p.trail);
      if (effTrail <= 0) {
        ctx.clearRect(0, 0, renderSize, renderSize);
      } else {
        const fade = 1 - effTrail;
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = `rgba(0,0,0,${fade})`;
        ctx.fillRect(0, 0, renderSize, renderSize);
        ctx.globalCompositeOperation = "source-over";
      }

      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);
      for (let i = 0; i < N; i++) {
        const xr = px[i] * cosY + pz[i] * sinY;
        let zr = -px[i] * sinY + pz[i] * cosY;
        const yr = py[i] * cosX - zr * sinX;
        zr = py[i] * sinX + zr * cosX;
        const persp = 1 + zr / (R * 3);
        sx[i] = cx + xr * persp;
        sy[i] = cy + yr * persp;
        sd[i] = (zr + R) / (2 * R);
      }

      dgrid.fill(0);
      // Density grid spans the full canvas (renderSize), not the
      // layout size — the projected sx/sy can exceed `size` when
      // particles project past the inner sphere.
      const cellSz = renderSize / DG;
      for (let i = 0; i < N; i++) {
        const gx = (sx[i] / cellSz) | 0;
        const gy = (sy[i] / cellSz) | 0;
        if (gx >= 0 && gx < DG && gy >= 0 && gy < DG) {
          dgrid[gy * DG + gx]++;
        }
      }
      const meanDens = N / (DG * DG);

      ctx.globalCompositeOperation = "source-over";
      const curState = stateRef.current;
      const isError = curState === "error";
      const isIdle = curState === "idle";
      const isDark = themeRef.current === "dark";
      for (let i = 0; i < N; i++) {
        const d = sd[i];
        const lead = leader[i];
        const leadK = lead ? 1 : p.dim;
        const gx = (sx[i] / cellSz) | 0;
        const gy = (sy[i] / cellSz) | 0;
        let densBoost = 1;
        if (gx >= 0 && gx < DG && gy >= 0 && gy < DG) {
          const cc = dgrid[gy * DG + gx];
          densBoost =
            1 +
            p.dens *
              Math.min(2, Math.max(0, cc / meanDens - 0.7) * 0.6);
        }
        const pB = pulseBoost[i];
        const pBoost = 1 + pB * p.pulse;
        const a = Math.min(
          1,
          p.dotA * (0.5 + d * 0.6) * leadK * densBoost * pBoost,
        );
        const dr = p.dotR * (lead ? 1 : 0.7) * (1 + pB * 0.4);
        const redK = pB * p.redMix;

        if (isError) {
          if (isDark) {
            const rr = 255;
            const gg = 90 + 40 * (1 - redK);
            const bb = 90 + 40 * (1 - redK);
            ctx.fillStyle = `rgba(${rr | 0}, ${gg | 0}, ${bb | 0}, ${a * 0.7})`;
          } else {
            ctx.fillStyle = `rgba(160, 20, 20, ${a})`;
          }
        } else if (isIdle) {
          if (isDark) {
            ctx.fillStyle = `rgba(220, 230, 255, ${a * 0.7})`;
          } else {
            ctx.fillStyle = `rgba(40, 48, 64, ${a})`;
          }
        } else {
          if (isDark) {
            const t01 = Math.max(
              0,
              Math.min(0.999, hue[i] * 0.6 + d * 0.4),
            );
            const idx = Math.floor(t01 * NEBULA.length);
            const base = NEBULA[idx];
            let r = base[0];
            let g = base[1];
            let b = base[2];
            if (redK > 0) {
              r = r + (255 - r) * redK;
              g = g + (80 - g) * redK;
              b = b + (100 - b) * redK;
            }
            ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${Math.min(1, a * 1.2)})`;
          } else {
            if (redK > 0.05) {
              const rr = 120 + 80 * redK;
              const gg = 40 + 30 * (1 - redK);
              const bb = 60 + 40 * (1 - redK);
              ctx.fillStyle = `rgba(${rr | 0}, ${gg | 0}, ${bb | 0}, ${a})`;
            } else {
              const h = 212 + hue[i] * 18;
              const s2 = 22 + hue[i] * 16;
              const l = 40 + (1 - d) * 8;
              ctx.fillStyle = `hsla(${h}, ${s2}%, ${l}%, ${a})`;
            }
          }
        }
        ctx.fillRect(sx[i] - dr, sy[i] - dr, dr * 2, dr * 2);
      }

      // Chromatic aberration ghosts — only on dark where 'lighter' blend
      // reads legibly. Skipped on light (would produce ugly artifacts).
      if (isDark && !isError && p.chroma > 0) {
        const off = p.chroma;
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < N; i += 3) {
          if (!leader[i]) continue;
          const a = p.dotA * (0.5 + sd[i] * 0.6);
          ctx.fillStyle = `rgba(200, 40, 60, ${a * 0.25})`;
          ctx.fillRect(
            sx[i] - off - p.dotR,
            sy[i] - p.dotR,
            p.dotR * 2,
            p.dotR * 2,
          );
        }
        for (let i = 0; i < N; i += 3) {
          if (!leader[i]) continue;
          const a = p.dotA * (0.5 + sd[i] * 0.6);
          ctx.fillStyle = `rgba(40, 200, 220, ${a * 0.2})`;
          ctx.fillRect(
            sx[i] + off - p.dotR,
            sy[i] - p.dotR,
            p.dotR * 2,
            p.dotR * 2,
          );
        }
        ctx.globalCompositeOperation = "source-over";
      }

      raf = requestAnimationFrame(step);
    }
    if (running) raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      reducedMotionQuery?.removeEventListener?.("change", onReducedMotionChange);
    };
  }, [size]);

  // The wrapper takes `renderSize` for layout — that's the actual
  // visible footprint of the canvas, including the projection
  // overflow band. Earlier this wrapper measured `size` and the
  // canvas overflowed via negative offsets, which caused siblings
  // (like the project-side state label) to render INSIDE the
  // overflow zone and overlap the brain. Wrapper = renderSize means
  // siblings position correctly with no overlap.
  //
  // Caller contract: `size` is the visible-sphere diameter; the
  // layout block is `size * RENDER_SCALE` (= renderSize) on each
  // side. Halo is sized to the visible sphere (centered inset
  // matching `size`, not the wrapper).
  const renderSize = size * RENDER_SCALE;
  const haloInset = (renderSize - size) / 2;

  return (
    <div
      data-marvin-brain
      style={{
        position: "relative",
        width: renderSize,
        height: renderSize,
      }}
    >
      {/* Halo — global iridescent CSS glow behind the canvas. Mirror of
          the standalone's `halo` div: conic-gradient (purple → cyan →
          mauve → gold), 32px blur, opacity 0.15, scaled to 0.9 of the
          visible sphere. Sized to `size` (the sphere area), centered
          inside the larger wrapper via inset. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: haloInset,
          left: haloInset,
          width: size,
          height: size,
          borderRadius: "50%",
          pointerEvents: "none",
          background:
            "conic-gradient(from 0deg, " +
            "oklch(0.86 0.11 280 / 0.25), " +
            "oklch(0.87 0.10 200 / 0.25), " +
            "oklch(0.86 0.10 340 / 0.25), " +
            "oklch(0.88 0.09 60 / 0.25), " +
            "oklch(0.86 0.11 280 / 0.25))",
          filter: "blur(32px)",
          opacity: 0.15,
          transform: "scale(0.9)",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          width: renderSize,
          height: renderSize,
          display: "block",
          position: "absolute",
          inset: 0,
          // Soft radial mask sized to the OVERSIZE canvas. Geometry:
          //   - sphere is at canvas center, radius = size * 0.5
          //     (= 0.5 / RENDER_SCALE of renderSize ≈ 0.333)
          //   - perspective projection reaches ~1.33×R from center
          //     ≈ 0.444 of renderSize on the axis, ~0.628 of the
          //     gradient's farthest-corner (which is √2/2 of the
          //     canvas side ≈ 70.7% of renderSize)
          //   - canvas corners sit at 100% of the gradient
          //
          // Mask: solid through the sphere body and the projection
          // overflow, fade gently to transparent at the corners so
          // trail-dim residue never reveals a rectangle. Particles
          // never reach the corner zone in practice — the fade is
          // there only to swallow stragglers and keep the page bg
          // visually continuous.
          maskImage:
            "radial-gradient(circle at center, black 75%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(circle at center, black 75%, transparent 100%)",
        }}
      />
    </div>
  );
}

/**
 * Memoized export. Without this, every parent re-render (page.tsx
 * fires one per chat token, panel resize tick, hover / focus event
 * etc.) re-invokes BrainLiquidImpl's render function. The render
 * itself is cheap — the useEffect doesn't re-run on stable props —
 * but the function call + JSX construction + reconciler diff still
 * adds up. Worse, in dev mode with React Strict Mode it doubles.
 *
 * Stable props (`size`, `state`, `autoCycle`) make the default
 * shallow-compare the right contract.
 */
export const BrainLiquid = memo(BrainLiquidImpl);

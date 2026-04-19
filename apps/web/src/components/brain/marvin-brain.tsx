"use client";

/**
 * MARVIN brain — dense animated neural silhouette.
 *
 * Visual states: idle / thinking / tool / writing / error.
 * Each state tunes: firing ratio, particles per edge, halo rings, escape
 * sparks, dust drift, node breathing, and global pace.
 *
 * Rendering strategy (performance):
 *  - Single <g> gets a CSS `filter: drop-shadow()` (GPU-composited) instead
 *    of per-particle <feGaussianBlur> (CPU-bound, was the lag source).
 *  - `offset-path` CSS animations for synapse travel — cheap on compositor.
 *  - Nodes use pure opacity+scale keyframes — no layout thrash.
 *  - Particle count capped via `maxParticles` even when firing is high.
 *
 * Topology: 45 nodes in 6 clusters (frontal / crown / occipital / hub /
 * temporal / bridges), 95 edges. Deterministic per state so the network
 * is visually stable across re-renders but distinct across states.
 */

import { useMemo } from "react";

export type MarvinState = "idle" | "thinking" | "tool" | "writing" | "error";

interface Node {
  id: string;
  x: number;
  y: number;
  /** 1-3; larger = more prominent */
  weight?: number;
}

interface Edge {
  id: string;
  from: string;
  to: string;
}

/*
 * Node layout inside the silhouette. Viewbox is 0 0 480 520.
 * Six clusters — frontal (right forehead), crown (top), occipital (left/back),
 * central hub (deep middle), temporal (lower), bridges (connectors).
 */
const NODES: Node[] = [
  // Frontal
  { id: "f1", x: 380, y: 82, weight: 2 },
  { id: "f2", x: 405, y: 118, weight: 3 },
  { id: "f3", x: 388, y: 152, weight: 2 },
  { id: "f4", x: 412, y: 192, weight: 3 },
  { id: "f5", x: 368, y: 112, weight: 2 },
  { id: "f6", x: 352, y: 142, weight: 2 },
  { id: "f7", x: 342, y: 88, weight: 3 },
  { id: "f8", x: 395, y: 222, weight: 2 },
  { id: "f9", x: 358, y: 186, weight: 3 },
  // Crown
  { id: "c1", x: 262, y: 66, weight: 2 },
  { id: "c2", x: 288, y: 86, weight: 3 },
  { id: "c3", x: 312, y: 106, weight: 2 },
  { id: "c4", x: 246, y: 102, weight: 3 },
  { id: "c5", x: 282, y: 130, weight: 2 },
  { id: "c6", x: 222, y: 76, weight: 2 },
  { id: "c7", x: 252, y: 144, weight: 3 },
  { id: "c8", x: 302, y: 152, weight: 2 },
  // Occipital
  { id: "o1", x: 102, y: 132, weight: 2 },
  { id: "o2", x: 86, y: 178, weight: 3 },
  { id: "o3", x: 122, y: 218, weight: 2 },
  { id: "o4", x: 94, y: 258, weight: 3 },
  { id: "o5", x: 142, y: 156, weight: 2 },
  { id: "o6", x: 156, y: 198, weight: 3 },
  { id: "o7", x: 172, y: 242, weight: 2 },
  { id: "o8", x: 76, y: 218, weight: 2 },
  { id: "o9", x: 132, y: 112, weight: 3 },
  // Central hubs
  { id: "h1", x: 252, y: 210, weight: 3 },
  { id: "h2", x: 222, y: 238, weight: 3 },
  { id: "h3", x: 286, y: 226, weight: 3 },
  { id: "h4", x: 202, y: 270, weight: 3 },
  { id: "h5", x: 252, y: 280, weight: 3 },
  { id: "h6", x: 316, y: 266, weight: 3 },
  { id: "h7", x: 270, y: 250, weight: 3 },
  // Temporal / lower
  { id: "t1", x: 182, y: 302, weight: 2 },
  { id: "t2", x: 216, y: 332, weight: 3 },
  { id: "t3", x: 250, y: 356, weight: 2 },
  { id: "t4", x: 290, y: 342, weight: 2 },
  { id: "t5", x: 326, y: 322, weight: 3 },
  { id: "t6", x: 192, y: 360, weight: 2 },
  { id: "t7", x: 246, y: 394, weight: 2 },
  { id: "t8", x: 296, y: 386, weight: 2 },
  { id: "t9", x: 336, y: 376, weight: 2 },
  // Bridges
  { id: "b1", x: 196, y: 196, weight: 2 },
  { id: "b2", x: 342, y: 246, weight: 2 },
  { id: "b3", x: 216, y: 160, weight: 2 },
];

const EDGES: Edge[] = [
  // Frontal internal
  { id: "e-f-1", from: "f1", to: "f5" },
  { id: "e-f-2", from: "f1", to: "f7" },
  { id: "e-f-3", from: "f1", to: "f2" },
  { id: "e-f-4", from: "f2", to: "f3" },
  { id: "e-f-5", from: "f2", to: "f4" },
  { id: "e-f-6", from: "f3", to: "f6" },
  { id: "e-f-7", from: "f3", to: "f9" },
  { id: "e-f-8", from: "f4", to: "f8" },
  { id: "e-f-9", from: "f4", to: "f9" },
  { id: "e-f-10", from: "f5", to: "f7" },
  { id: "e-f-11", from: "f5", to: "f6" },
  { id: "e-f-12", from: "f6", to: "f9" },
  { id: "e-f-13", from: "f8", to: "f9" },
  // Crown internal
  { id: "e-c-1", from: "c1", to: "c2" },
  { id: "e-c-2", from: "c1", to: "c4" },
  { id: "e-c-3", from: "c1", to: "c6" },
  { id: "e-c-4", from: "c2", to: "c3" },
  { id: "e-c-5", from: "c2", to: "c4" },
  { id: "e-c-6", from: "c2", to: "c5" },
  { id: "e-c-7", from: "c3", to: "c5" },
  { id: "e-c-8", from: "c3", to: "c8" },
  { id: "e-c-9", from: "c4", to: "c7" },
  { id: "e-c-10", from: "c5", to: "c7" },
  { id: "e-c-11", from: "c5", to: "c8" },
  { id: "e-c-12", from: "c6", to: "c4" },
  { id: "e-c-13", from: "c7", to: "c8" },
  // Occipital internal
  { id: "e-o-1", from: "o1", to: "o9" },
  { id: "e-o-2", from: "o1", to: "o5" },
  { id: "e-o-3", from: "o2", to: "o8" },
  { id: "e-o-4", from: "o2", to: "o5" },
  { id: "e-o-5", from: "o2", to: "o6" },
  { id: "e-o-6", from: "o3", to: "o4" },
  { id: "e-o-7", from: "o3", to: "o6" },
  { id: "e-o-8", from: "o3", to: "o7" },
  { id: "e-o-9", from: "o4", to: "o8" },
  { id: "e-o-10", from: "o4", to: "o7" },
  { id: "e-o-11", from: "o5", to: "o6" },
  { id: "e-o-12", from: "o5", to: "o9" },
  { id: "e-o-13", from: "o6", to: "o7" },
  // Hub internal (highly connected)
  { id: "e-h-1", from: "h1", to: "h2" },
  { id: "e-h-2", from: "h1", to: "h3" },
  { id: "e-h-3", from: "h1", to: "h7" },
  { id: "e-h-4", from: "h2", to: "h4" },
  { id: "e-h-5", from: "h2", to: "h7" },
  { id: "e-h-6", from: "h3", to: "h6" },
  { id: "e-h-7", from: "h3", to: "h7" },
  { id: "e-h-8", from: "h4", to: "h5" },
  { id: "e-h-9", from: "h5", to: "h7" },
  { id: "e-h-10", from: "h5", to: "h6" },
  { id: "e-h-11", from: "h6", to: "h7" },
  { id: "e-h-12", from: "h2", to: "h5" },
  // Temporal internal
  { id: "e-t-1", from: "t1", to: "t2" },
  { id: "e-t-2", from: "t1", to: "t6" },
  { id: "e-t-3", from: "t2", to: "t3" },
  { id: "e-t-4", from: "t2", to: "t6" },
  { id: "e-t-5", from: "t3", to: "t4" },
  { id: "e-t-6", from: "t3", to: "t7" },
  { id: "e-t-7", from: "t4", to: "t5" },
  { id: "e-t-8", from: "t4", to: "t8" },
  { id: "e-t-9", from: "t5", to: "t9" },
  { id: "e-t-10", from: "t5", to: "t8" },
  { id: "e-t-11", from: "t6", to: "t7" },
  { id: "e-t-12", from: "t7", to: "t8" },
  { id: "e-t-13", from: "t8", to: "t9" },
  // Frontal ↔ crown ↔ hub
  { id: "e-x-1", from: "f7", to: "c3" },
  { id: "e-x-2", from: "c8", to: "f1" },
  { id: "e-x-3", from: "f6", to: "h3" },
  { id: "e-x-4", from: "f9", to: "h3" },
  { id: "e-x-5", from: "f9", to: "b2" },
  { id: "e-x-6", from: "c5", to: "h1" },
  { id: "e-x-7", from: "c7", to: "h1" },
  { id: "e-x-8", from: "c7", to: "h2" },
  { id: "e-x-9", from: "c8", to: "h1" },
  { id: "e-x-10", from: "c8", to: "h3" },
  // Occipital ↔ crown ↔ hub
  { id: "e-x-11", from: "o9", to: "c6" },
  { id: "e-x-12", from: "o9", to: "b3" },
  { id: "e-x-13", from: "o5", to: "b3" },
  { id: "e-x-14", from: "o6", to: "h4" },
  { id: "e-x-15", from: "o7", to: "h4" },
  { id: "e-x-16", from: "o7", to: "b1" },
  { id: "e-x-17", from: "o2", to: "h4" },
  // Hub ↔ temporal
  { id: "e-x-18", from: "h4", to: "t1" },
  { id: "e-x-19", from: "h5", to: "t3" },
  { id: "e-x-20", from: "h6", to: "t4" },
  { id: "e-x-21", from: "h7", to: "t3" },
  { id: "e-x-22", from: "h2", to: "t2" },
  // Bridges
  { id: "e-x-23", from: "b1", to: "h2" },
  { id: "e-x-24", from: "b2", to: "h6" },
  { id: "e-x-25", from: "b3", to: "h1" },
  { id: "e-x-26", from: "b1", to: "b3" },
  { id: "e-x-27", from: "b2", to: "b3" },
  { id: "e-x-28", from: "b1", to: "h4" },
  // Long-distance
  { id: "e-x-29", from: "t5", to: "b2" },
  { id: "e-x-30", from: "t6", to: "o7" },
  { id: "e-x-31", from: "f4", to: "b2" },
  { id: "e-x-32", from: "c3", to: "f5" },
];

const NODE_BY_ID: Record<string, Node> = Object.fromEntries(
  NODES.map((n) => [n.id, n]),
);

function edgePath(e: Edge): string {
  const a = NODE_BY_ID[e.from]!;
  const b = NODE_BY_ID[e.to]!;
  // Bias the curve toward the head centroid (248, 240) so edges always bend
  // *inward* rather than pushing over the silhouette edge.
  const mx0 = (a.x + b.x) / 2;
  const my0 = (a.y + b.y) / 2;
  const cx = 248;
  const cy = 240;
  const pull = 0.08; // 0..1 — how strongly the control point is pulled inward
  const mx = mx0 + (cx - mx0) * pull;
  const my = my0 + (cy - my0) * pull;
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

/**
 * Smooth brain-ovoid silhouette. No neck/chin — just a clean organic blob
 * with a slight forehead lean to the right.
 */
const HEAD_PATH = `
  M 242 44
  C 338 40, 402 86, 420 170
  C 432 248, 406 322, 358 368
  C 308 414, 232 424, 178 408
  C 122 390, 82 348, 68 292
  C 54 232, 70 166, 108 118
  C 148 68, 196 46, 242 44
  Z
`
  .replace(/\s+/g, " ")
  .trim();

interface ActivityProfile {
  firingRatio: number;
  maxParticles: number;
  particlesPerEdge: 1 | 2 | 3;
  duration: number;
  rootClass: string;
  haloRings: number;
  sparks: number;
  dust: number;
  breathe: "calm" | "normal" | "intense";
  nodeGlowScale: number;
  /** Fraction of edges that get a subtle opacity pulse (no particle). */
  edgePulseRatio: number;
}

function activityPerState(state: MarvinState): ActivityProfile {
  switch (state) {
    case "idle":
      return {
        firingRatio: 0.22,
        maxParticles: 14,
        particlesPerEdge: 1,
        duration: 3.4,
        rootClass: "",
        haloRings: 1,
        sparks: 0,
        dust: 10,
        breathe: "calm",
        nodeGlowScale: 2.3,
        edgePulseRatio: 0.4,
      };
    case "thinking":
      return {
        firingRatio: 0.5,
        maxParticles: 32,
        particlesPerEdge: 2,
        duration: 2.1,
        rootClass: "",
        haloRings: 2,
        sparks: 0,
        dust: 10,
        breathe: "normal",
        nodeGlowScale: 2.7,
        edgePulseRatio: 0.55,
      };
    case "tool":
      return {
        firingRatio: 0.65,
        maxParticles: 44,
        particlesPerEdge: 2,
        duration: 1.7,
        rootClass: "",
        haloRings: 3,
        sparks: 0,
        dust: 10,
        breathe: "normal",
        nodeGlowScale: 2.9,
        edgePulseRatio: 0.65,
      };
    case "writing":
      return {
        firingRatio: 0.85,
        maxParticles: 58,
        particlesPerEdge: 3,
        duration: 1.25,
        rootClass: "",
        haloRings: 3,
        sparks: 0,
        dust: 12,
        breathe: "intense",
        nodeGlowScale: 3.1,
        edgePulseRatio: 0.75,
      };
    case "error":
      return {
        firingRatio: 0.45,
        maxParticles: 30,
        particlesPerEdge: 2,
        duration: 1.8,
        rootClass: "marvin-brain-error",
        haloRings: 2,
        sparks: 0,
        dust: 8,
        breathe: "normal",
        nodeGlowScale: 2.7,
        edgePulseRatio: 0.5,
      };
  }
}

function deterministicShuffle<T>(items: T[], salt: string): T[] {
  const out = items.slice();
  let h = 2166136261;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 16807) >>> 0;
    const j = h % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function seededRng(salt: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return () => {
    h = (h * 16807 + 17) >>> 0;
    return (h & 0xffff) / 0xffff;
  };
}

export function MarvinBrain({
  state = "idle",
  size = 320,
  label,
}: {
  state?: MarvinState;
  size?: number;
  label?: string;
}) {
  const activity = activityPerState(state);

  // Firing edges — deterministic per state; capped by maxParticles / per-edge.
  const firingEdges = useMemo(() => {
    const shuffled = deterministicShuffle(EDGES, `${state}-fire`);
    const maxEdges = Math.max(
      1,
      Math.floor(activity.maxParticles / activity.particlesPerEdge),
    );
    const count = Math.min(
      maxEdges,
      Math.max(1, Math.round(EDGES.length * activity.firingRatio)),
    );
    return shuffled.slice(0, count);
  }, [
    state,
    activity.firingRatio,
    activity.maxParticles,
    activity.particlesPerEdge,
  ]);

  // Edges that pulse in opacity (no particle — cheap suggestion of data flow).
  const pulseEdges = useMemo(() => {
    const firingIds = new Set(firingEdges.map((e) => e.id));
    const remaining = EDGES.filter((e) => !firingIds.has(e.id));
    const shuffled = deterministicShuffle(remaining, `${state}-pulse`);
    const count = Math.round(remaining.length * activity.edgePulseRatio);
    return shuffled.slice(0, count);
  }, [state, firingEdges, activity.edgePulseRatio]);

  // Ambient dust particles drifting inside the silhouette.
  const dust = useMemo(() => {
    if (activity.dust === 0) return [];
    const rng = seededRng(`${state}-dust`);
    const out: Array<{
      x: number;
      y: number;
      dx: number;
      dy: number;
      delay: number;
      duration: number;
      opacity: number;
      r: number;
    }> = [];
    for (let i = 0; i < activity.dust; i++) {
      // Rejection-sample inside a soft ellipse approximating the head.
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = 90 + rng() * 310;
        y = 80 + rng() * 320;
        const nx = (x - 248) / 170;
        const ny = (y - 240) / 180;
        if (nx * nx + ny * ny < 0.85) break;
      }
      const dx = (rng() - 0.5) * 40;
      const dy = (rng() - 0.5) * 40 - 6;
      out.push({
        x,
        y,
        dx,
        dy,
        delay: rng() * 6,
        duration: 6 + rng() * 4,
        opacity: 0.25 + rng() * 0.35,
        r: 0.9 + rng() * 1.1,
      });
    }
    return out;
  }, [state, activity.dust]);

  // Escape sparks drifting off the silhouette when active.
  const sparks = useMemo(() => {
    if (activity.sparks === 0) return [];
    const rng = seededRng(`${state}-spark`);
    const out: Array<{
      x: number;
      y: number;
      dx: number;
      dy: number;
      delay: number;
      duration: number;
    }> = [];
    for (let i = 0; i < activity.sparks; i++) {
      const angle = rng() * Math.PI * 2;
      const r = 180 + rng() * 40;
      const x = 248 + Math.cos(angle) * r;
      const y = 240 + Math.sin(angle) * r * 0.9;
      const dx = Math.cos(angle) * (60 + rng() * 40);
      const dy = Math.sin(angle) * (60 + rng() * 40) * 0.85;
      out.push({
        x,
        y,
        dx,
        dy,
        delay: rng() * 3,
        duration: 2.4 + rng() * 1.6,
      });
    }
    return out;
  }, [state, activity.sparks]);

  const breatheName =
    activity.breathe === "intense"
      ? "fire-intense"
      : activity.breathe === "calm"
        ? "breathe-calm"
        : "breathe";

  const nodeDuration =
    activity.breathe === "intense"
      ? "1.3s"
      : activity.breathe === "calm"
        ? "3.6s"
        : "2.2s";

  return (
    <div
      className="relative inline-block select-none"
      style={{ width: size, height: size * 1.083 }}
      role="img"
      aria-label={`MARVIN — ${state}`}
    >
      <svg
        viewBox="0 0 480 520"
        xmlns="http://www.w3.org/2000/svg"
        className={`block h-full w-full ${activity.rootClass}`}
        style={{
          animation:
            state === "error"
              ? "error-flicker 1.2s steps(4, end) infinite"
              : undefined,
        }}
      >
        <defs>
          <radialGradient id="marvin-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="1" />
            <stop
              offset="60%"
              stopColor="var(--color-accent-deep)"
              stopOpacity="0.45"
            />
            <stop
              offset="100%"
              stopColor="var(--color-accent-deep)"
              stopOpacity="0"
            />
          </radialGradient>
          <radialGradient id="marvin-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(127,211,255,0.18)" />
            <stop offset="60%" stopColor="rgba(62,166,255,0.06)" />
            <stop offset="100%" stopColor="rgba(62,166,255,0)" />
          </radialGradient>
        </defs>

        {/* Core halo (soft glow behind the head) */}
        <circle
          cx="248"
          cy="240"
          r="225"
          fill="url(#marvin-halo)"
          style={{
            animation:
              state === "idle"
                ? "halo-pulse 5s ease-in-out infinite"
                : state === "writing"
                  ? "halo-pulse 1.6s ease-in-out infinite"
                  : "halo-pulse 2.4s ease-in-out infinite",
            transformOrigin: "248px 240px",
          }}
        />

        {/* Concentric rippling halo rings */}
        {Array.from({ length: activity.haloRings }).map((_, i) => {
          const ringDuration =
            state === "idle" ? 8 : state === "writing" ? 2.8 : 4.2;
          const delay = (ringDuration / activity.haloRings) * i;
          const ringAnim = state === "idle" ? "halo-ring-calm" : "halo-ring";
          return (
            <circle
              key={`ring-${i}`}
              cx="248"
              cy="240"
              r={178}
              fill="none"
              stroke="var(--color-accent)"
              strokeOpacity={state === "idle" ? 0.1 : 0.2}
              strokeWidth={0.7}
              style={{
                animation: `${ringAnim} ${ringDuration}s ease-out ${delay}s infinite`,
                transformOrigin: "248px 240px",
              }}
            />
          );
        })}

        {/* Head silhouette */}
        <path
          d={HEAD_PATH}
          fill="rgba(127, 211, 255, 0.035)"
          stroke="var(--color-accent)"
          strokeOpacity="0.32"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />

        {/* Ambient dust — tiny particles drifting inside the skull */}
        {dust.length > 0 && (
          <g
            style={{
              filter:
                "drop-shadow(0 0 2px rgba(127, 211, 255, 0.45))",
            }}
          >
            {dust.map((d, i) => (
              <circle
                key={`dust-${i}`}
                cx={d.x}
                cy={d.y}
                r={d.r}
                fill="var(--color-accent)"
                style={
                  {
                    "--dust-dx": `${d.dx}px`,
                    "--dust-dy": `${d.dy}px`,
                    "--dust-opacity": d.opacity,
                    animation: `dust-drift ${d.duration}s ease-in-out ${d.delay}s infinite`,
                    transformOrigin: `${d.x}px ${d.y}px`,
                  } as React.CSSProperties
                }
              />
            ))}
          </g>
        )}

        {/* Base edges (dim, always visible) */}
        <g>
          {EDGES.map((e) => (
            <path
              key={`base-${e.id}`}
              d={edgePath(e)}
              fill="none"
              stroke="var(--color-accent)"
              strokeOpacity={0.14}
              strokeWidth={0.75}
              strokeLinecap="round"
            />
          ))}
        </g>

        {/* Pulsing edges (cheap opacity-only glow, suggests latent flow) */}
        <g>
          {pulseEdges.map((e, i) => (
            <path
              key={`pulse-${e.id}`}
              d={edgePath(e)}
              fill="none"
              stroke="var(--color-accent)"
              strokeOpacity={0.18}
              strokeWidth={0.9}
              strokeLinecap="round"
              style={{
                animation: `edge-pulse ${activity.duration * 2}s ease-in-out ${(i * 0.13) % (activity.duration * 2)}s infinite`,
              }}
            />
          ))}
        </g>

        {/* Firing edges (brighter baseline so the synapse path stands out) */}
        <g>
          {firingEdges.map((e) => (
            <path
              key={`fire-${e.id}`}
              d={edgePath(e)}
              fill="none"
              stroke="var(--color-accent)"
              strokeOpacity={0.42}
              strokeWidth={1}
              strokeLinecap="round"
            />
          ))}
        </g>

        {/* Firing particles — CSS offset-path along the edge shape.
            GPU-composited drop-shadow replaces the old SVG blur filter. */}
        <g
          style={{
            filter:
              "drop-shadow(0 0 3px rgba(127, 211, 255, 0.85)) drop-shadow(0 0 6px rgba(62, 166, 255, 0.35))",
          }}
        >
          {firingEdges.flatMap((e, i) => {
            const d = edgePath(e);
            const parts: React.ReactElement[] = [];
            for (let k = 0; k < activity.particlesPerEdge; k++) {
              const stagger =
                (activity.duration / activity.particlesPerEdge) * k;
              const baseDelay = (i * 0.19) % activity.duration;
              const delay = (baseDelay + stagger) % activity.duration;
              parts.push(
                <circle
                  key={`p-${e.id}-${k}`}
                  r={2.2 + (k === 0 ? 0.4 : 0)}
                  fill="#e8f8ff"
                  style={{
                    offsetPath: `path('${d}')`,
                    animation: `synapse-fire ${activity.duration}s linear ${delay}s infinite`,
                    offsetDistance: "0%",
                  }}
                />,
              );
            }
            return parts;
          })}
        </g>

        {/* Nodes */}
        <g>
          {NODES.map((n, i) => {
            const r = 2.4 + (n.weight ?? 1) * 0.7;
            const delay = `${(i * 0.11) % 2.4}s`;
            // Delay folded into the `animation` shorthand — React warns
            // when the shorthand and the `animationDelay` longhand are
            // set on the same style object during render (the shorthand
            // implicitly sets delay to 0, conflicting with the longhand).
            const breatheAnim = `${breatheName} ${nodeDuration} ease-in-out ${delay} infinite`;
            return (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r * activity.nodeGlowScale}
                  fill="url(#marvin-node-glow)"
                  opacity={0.55}
                  style={{
                    animation: breatheAnim,
                    transformOrigin: `${n.x}px ${n.y}px`,
                  }}
                />
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill="var(--color-accent)"
                  style={{
                    animation: breatheAnim,
                    transformOrigin: `${n.x}px ${n.y}px`,
                  }}
                />
              </g>
            );
          })}
        </g>

        {/* Escape sparks — drift off the silhouette while MARVIN works */}
        {sparks.length > 0 && (
          <g
            style={{
              filter:
                "drop-shadow(0 0 3px rgba(127, 211, 255, 0.8))",
            }}
          >
            {sparks.map((s, i) => (
              <circle
                key={`spark-${i}`}
                cx={s.x}
                cy={s.y}
                r={1.6}
                fill="#e8f8ff"
                style={
                  {
                    "--spark-dx": `${s.dx}px`,
                    "--spark-dy": `${s.dy}px`,
                    animation: `spark-drift ${s.duration}s ease-out ${s.delay}s infinite`,
                    transformOrigin: `${s.x}px ${s.y}px`,
                  } as React.CSSProperties
                }
              />
            ))}
          </g>
        )}
      </svg>

      {label && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.25em] text-[color:var(--color-fg-dim)]">
          {label}
        </div>
      )}
    </div>
  );
}

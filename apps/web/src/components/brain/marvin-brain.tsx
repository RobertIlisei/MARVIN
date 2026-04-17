"use client";

/**
 * MARVIN brain — animated head-profile + neural-network SVG.
 *
 * Five visual states:
 *   - `idle`    — slow breathing glow on nodes; no firing particles.
 *   - `thinking`— particles travel a few neural paths, moderate pace.
 *   - `tool`    — more paths firing in parallel; brighter accent.
 *   - `writing` — sustained high activity across many paths.
 *   - `error`   — red hue flicker over the whole network.
 *
 * Entirely SVG + CSS. No canvas, no three.js, no heavy deps.
 *
 * Animation mechanism:
 *   - Static paths: the neural network (gentle draw).
 *   - Firing particles: tiny <circle>s using CSS `offset-path` to follow a
 *     named path. Each particle has a random delay so they fire
 *     asynchronously, giving the "synapse" feel.
 *
 * The network topology (nodes + paths) is defined inline — hand-tuned to
 * sit inside the profile silhouette without crossing it.
 */

import { useMemo } from "react";

export type MarvinState = "idle" | "thinking" | "tool" | "writing" | "error";

interface Node {
  id: string;
  x: number;
  y: number;
  /** 0-3; larger = more prominent */
  weight?: number;
}

interface Edge {
  id: string;
  from: string;
  to: string;
  /** Bezier control for curvature; if omitted, straight. */
  c?: [number, number, number, number];
}

/*
 * Node layout inside the head silhouette.
 * Viewbox is 0 0 480 520. The head profile faces right.
 */
const NODES: Node[] = [
  // Frontal lobe (right side, near forehead)
  { id: "n1", x: 310, y: 110, weight: 3 },
  { id: "n2", x: 340, y: 145, weight: 2 },
  { id: "n3", x: 300, y: 165, weight: 2 },
  { id: "n4", x: 355, y: 195, weight: 3 },
  { id: "n5", x: 320, y: 220, weight: 2 },
  // Parietal / crown
  { id: "n6", x: 240, y: 100, weight: 2 },
  { id: "n7", x: 210, y: 135, weight: 3 },
  { id: "n8", x: 260, y: 170, weight: 2 },
  { id: "n9", x: 220, y: 200, weight: 3 },
  { id: "n10", x: 280, y: 230, weight: 2 },
  // Occipital / back
  { id: "n11", x: 150, y: 130, weight: 2 },
  { id: "n12", x: 130, y: 175, weight: 3 },
  { id: "n13", x: 160, y: 220, weight: 2 },
  { id: "n14", x: 115, y: 240, weight: 2 },
  // Temporal / lower
  { id: "n15", x: 180, y: 275, weight: 3 },
  { id: "n16", x: 240, y: 295, weight: 2 },
  { id: "n17", x: 300, y: 280, weight: 2 },
  // Central hub (high-degree)
  { id: "h1", x: 250, y: 190, weight: 3 },
  { id: "h2", x: 205, y: 235, weight: 3 },
  { id: "h3", x: 290, y: 250, weight: 3 },
];

const EDGES: Edge[] = [
  // Frontal cluster
  { id: "e1", from: "n1", to: "n2" },
  { id: "e2", from: "n1", to: "n3" },
  { id: "e3", from: "n2", to: "n4" },
  { id: "e4", from: "n3", to: "n5" },
  { id: "e5", from: "n4", to: "n5" },
  // Frontal → hub
  { id: "e6", from: "n3", to: "h1", c: [280, 180, 260, 185] },
  { id: "e7", from: "n5", to: "h1" },
  { id: "e8", from: "n5", to: "h3" },
  // Crown cluster
  { id: "e9", from: "n6", to: "n7" },
  { id: "e10", from: "n6", to: "n8" },
  { id: "e11", from: "n7", to: "n9" },
  { id: "e12", from: "n8", to: "n10" },
  { id: "e13", from: "n9", to: "n10" },
  // Crown → hub
  { id: "e14", from: "n8", to: "h1" },
  { id: "e15", from: "n9", to: "h2" },
  { id: "e16", from: "n10", to: "h1" },
  { id: "e17", from: "n10", to: "h3" },
  // Occipital
  { id: "e18", from: "n11", to: "n12" },
  { id: "e19", from: "n12", to: "n13" },
  { id: "e20", from: "n12", to: "n14" },
  { id: "e21", from: "n13", to: "n15" },
  // Occipital → hub
  { id: "e22", from: "n13", to: "h2" },
  { id: "e23", from: "n14", to: "n15" },
  // Temporal
  { id: "e24", from: "n15", to: "n16" },
  { id: "e25", from: "n16", to: "n17" },
  { id: "e26", from: "n16", to: "h2" },
  { id: "e27", from: "n17", to: "h3" },
  // Hub interconnects
  { id: "e28", from: "h1", to: "h2" },
  { id: "e29", from: "h1", to: "h3" },
  { id: "e30", from: "h2", to: "h3" },
  // Crown ↔ frontal bridges
  { id: "e31", from: "n6", to: "n1", c: [275, 95, 290, 100] },
  { id: "e32", from: "n7", to: "n2", c: [260, 130, 300, 130] },
  // Long-distance bridges (the "a-ha" paths)
  { id: "e33", from: "n11", to: "h1", c: [180, 160, 220, 170] },
  { id: "e34", from: "n14", to: "n15" },
  { id: "e35", from: "n17", to: "n5" },
];

function nodeById(id: string): Node {
  const n = NODES.find((x) => x.id === id);
  if (!n) throw new Error(`node not found: ${id}`);
  return n;
}

function edgePath(e: Edge): string {
  const a = nodeById(e.from);
  const b = nodeById(e.to);
  if (e.c) {
    return `M ${a.x} ${a.y} C ${e.c[0]} ${e.c[1]}, ${e.c[2]} ${e.c[3]}, ${b.x} ${b.y}`;
  }
  // Default: gentle midpoint lift for organic curves.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - 6;
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

/**
 * Head silhouette — a stylised right-facing profile. Hand-authored as a
 * single SVG path. Not anatomically perfect; legible at 260px tall.
 */
const HEAD_PATH = `
  M 160 48
  C 240 30, 340 40, 390 100
  C 420 140, 425 200, 415 255
  C 405 295, 395 325, 370 345
  C 360 355, 350 360, 345 372
  C 345 390, 352 405, 345 418
  C 335 438, 305 440, 275 438
  C 250 436, 235 425, 232 412
  C 230 398, 240 388, 236 378
  C 230 365, 215 365, 205 358
  C 175 345, 150 325, 135 305
  C 115 280, 105 250, 100 220
  C 95 180, 100 140, 120 105
  C 130 85, 145 65, 160 48
  Z
`
  .replace(/\s+/g, " ")
  .trim();

interface ActivityProfile {
  /** Fraction of edges that carry firing particles. */
  firingRatio: number;
  /** Max particles active simultaneously. */
  maxParticles: number;
  /** Base duration of particle travel (seconds). */
  duration: number;
  /** CSS class applied to the SVG root for hue / filter. */
  rootClass: string;
  /** Concentric halo rings rippling outward (0 = none). */
  haloRings: number;
  /** Escape sparks drifting off the silhouette (0 = none). */
  sparks: number;
  /** Node breathing intensity. */
  breathe: "calm" | "normal" | "intense";
  /** Node glow outer-radius scale. */
  nodeGlowScale: number;
}

function activityPerState(state: MarvinState): ActivityProfile {
  switch (state) {
    case "idle":
      return {
        firingRatio: 0,
        maxParticles: 0,
        duration: 2.4,
        rootClass: "",
        haloRings: 1,
        sparks: 0,
        breathe: "calm",
        nodeGlowScale: 2.2,
      };
    case "thinking":
      return {
        firingRatio: 0.35,
        maxParticles: 6,
        duration: 2.1,
        rootClass: "",
        haloRings: 2,
        sparks: 3,
        breathe: "normal",
        nodeGlowScale: 2.6,
      };
    case "tool":
      return {
        firingRatio: 0.55,
        maxParticles: 10,
        duration: 1.6,
        rootClass: "",
        haloRings: 3,
        sparks: 5,
        breathe: "normal",
        nodeGlowScale: 2.8,
      };
    case "writing":
      return {
        firingRatio: 0.75,
        maxParticles: 14,
        duration: 1.2,
        rootClass: "",
        haloRings: 3,
        sparks: 7,
        breathe: "intense",
        nodeGlowScale: 3.1,
      };
    case "error":
      return {
        firingRatio: 0.4,
        maxParticles: 6,
        duration: 1.8,
        rootClass: "marvin-brain-error",
        haloRings: 2,
        sparks: 2,
        breathe: "normal",
        nodeGlowScale: 2.6,
      };
  }
}

function deterministicShuffle<T>(items: T[], salt: string): T[] {
  const out = items.slice();
  // Simple FNV-ish hash for deterministic seeding.
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

  // Pick which edges fire this render. Deterministic on state to keep the
  // visual stable across re-renders with the same state.
  const firingEdges = useMemo(() => {
    if (activity.firingRatio === 0) return [];
    const shuffled = deterministicShuffle(EDGES, state);
    const count = Math.min(
      activity.maxParticles,
      Math.max(1, Math.round(EDGES.length * activity.firingRatio)),
    );
    return shuffled.slice(0, count);
  }, [state, activity.firingRatio, activity.maxParticles]);

  // Deterministic spark trajectories around the silhouette. Same state → same
  // positions, so the animation doesn't churn across renders.
  const sparks = useMemo(() => {
    if (activity.sparks === 0) return [];
    const out: Array<{
      x: number;
      y: number;
      dx: number;
      dy: number;
      delay: number;
      duration: number;
    }> = [];
    let h = 0x811c9dc5;
    for (let i = 0; i < state.length; i++) {
      h ^= state.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    const next = () => {
      h = (h * 16807 + 17) >>> 0;
      return (h & 0xffff) / 0xffff;
    };
    for (let i = 0; i < activity.sparks; i++) {
      const angle = next() * Math.PI * 2;
      const r = 180 + next() * 40;
      const x = 250 + Math.cos(angle) * r;
      const y = 260 + Math.sin(angle) * r * 0.9;
      const dx = Math.cos(angle) * (60 + next() * 40);
      const dy = Math.sin(angle) * (60 + next() * 40) * 0.85;
      out.push({
        x,
        y,
        dx,
        dy,
        delay: next() * 3,
        duration: 2.4 + next() * 1.6,
      });
    }
    return out;
  }, [state, activity.sparks]);

  const breatheName =
    activity.breathe === "calm"
      ? "breathe-calm"
      : activity.breathe === "intense"
        ? "fire-intense"
        : "breathe";

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
              stopOpacity="0.5"
            />
            <stop offset="100%" stopColor="var(--color-accent-deep)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="marvin-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(127,211,255,0.14)" />
            <stop offset="70%" stopColor="rgba(62,166,255,0.05)" />
            <stop offset="100%" stopColor="rgba(62,166,255,0)" />
          </radialGradient>
          <linearGradient id="marvin-synapse" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.05" />
            <stop offset="50%" stopColor="var(--color-accent)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.05" />
          </linearGradient>
          <filter id="marvin-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
          <filter id="marvin-particle-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Core halo (soft glow behind the head) */}
        <circle
          cx="250"
          cy="260"
          r="230"
          fill="url(#marvin-halo)"
          style={{
            animation:
              state === "idle"
                ? "halo-pulse 5s ease-in-out infinite"
                : state === "writing"
                  ? "halo-pulse 1.6s ease-in-out infinite"
                  : "halo-pulse 2.4s ease-in-out infinite",
            transformOrigin: "250px 260px",
          }}
        />

        {/* Concentric rippling halo rings — one per activity step */}
        {Array.from({ length: activity.haloRings }).map((_, i) => {
          const ringDuration =
            state === "idle"
              ? 7.5
              : state === "writing"
                ? 2.8
                : 4.2;
          const delay = (ringDuration / activity.haloRings) * i;
          const ringAnim = state === "idle" ? "halo-ring-calm" : "halo-ring";
          return (
            <circle
              key={`ring-${i}`}
              cx="250"
              cy="260"
              r={180}
              fill="none"
              stroke="var(--color-accent)"
              strokeOpacity={state === "idle" ? 0.1 : 0.2}
              strokeWidth={0.8}
              style={{
                animation: `${ringAnim} ${ringDuration}s ease-out ${delay}s infinite`,
                transformOrigin: "250px 260px",
              }}
            />
          );
        })}

        {/* Head outline */}
        <path
          d={HEAD_PATH}
          fill="rgba(127, 211, 255, 0.03)"
          stroke="var(--color-accent)"
          strokeOpacity="0.35"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        {/* Inner "shadow" line for depth */}
        <path
          d={HEAD_PATH}
          fill="none"
          stroke="var(--color-accent)"
          strokeOpacity="0.08"
          strokeWidth="6"
          strokeLinejoin="round"
          filter="url(#marvin-blur)"
        />

        {/* Edges (neural paths) */}
        <g>
          {EDGES.map((e) => {
            const d = edgePath(e);
            return (
              <path
                key={e.id}
                id={`marvin-edge-${e.id}`}
                d={d}
                fill="none"
                stroke="var(--color-accent)"
                strokeOpacity={0.22}
                strokeWidth={0.9}
                strokeLinecap="round"
              />
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {NODES.map((n, i) => {
            const r = 2.8 + (n.weight ?? 1) * 0.8;
            const delay = `${(i * 0.13) % 2.4}s`;
            const duration =
              activity.breathe === "intense"
                ? "1.3s"
                : activity.breathe === "calm"
                  ? "3.6s"
                  : "2.4s";
            return (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r * activity.nodeGlowScale}
                  fill="url(#marvin-node-glow)"
                  opacity={0.5}
                  style={{
                    animation: `${breatheName} ${duration} ease-in-out infinite`,
                    animationDelay: delay,
                    transformOrigin: `${n.x}px ${n.y}px`,
                  }}
                />
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill="var(--color-accent)"
                  style={{
                    animation: `${breatheName} ${duration} ease-in-out infinite`,
                    animationDelay: delay,
                    transformOrigin: `${n.x}px ${n.y}px`,
                  }}
                />
              </g>
            );
          })}
        </g>

        {/* Escape sparks — drift off the silhouette while MARVIN works */}
        {sparks.length > 0 && (
          <g filter="url(#marvin-particle-glow)">
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

        {/* Firing particles — CSS offset-path along the edge shape */}
        <g filter="url(#marvin-particle-glow)">
          {firingEdges.map((e, i) => {
            const d = edgePath(e);
            const delay = `${(i * 0.17) % activity.duration}s`;
            return (
              <circle
                key={`p-${e.id}`}
                r={2.4}
                fill="#e8f8ff"
                style={{
                  offsetPath: `path('${d}')`,
                  animation: `synapse-fire ${activity.duration}s linear ${delay} infinite`,
                  offsetDistance: "0%",
                }}
              />
            );
          })}
        </g>
      </svg>

      {label && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.25em] text-[color:var(--color-fg-dim)]">
          {label}
        </div>
      )}
    </div>
  );
}

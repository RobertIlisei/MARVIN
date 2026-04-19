"use client";

/**
 * Companion orb that signals "advisor is actively firing" in the UI.
 *
 * Sits beside the main BrainLiquid. Invisible by default — appears only
 * when the advisor tool is mid-call (tool_use emitted but tool_result
 * hasn't landed yet). Flies in from off-orbit, pulses with an icy-blue
 * glow, fades out when the advisor completes.
 *
 * Option C from the brain-visualisation brainstorm:
 * "Companion orb — MARVIN-appropriate theatricality ('bringing you a
 * second opinion from my even bigger brain')."
 *
 * Intentionally SVG + CSS, not a second canvas particle engine. A
 * second BrainLiquid would compete with the main brain for visual
 * attention; a quieter glowing orb reads as a messenger.
 */

interface AdvisorOrbProps {
  /** true while at least one `tool_use` with name=advisor is running. */
  active: boolean;
  /** Advisor model id — rendered as a subtle caption, e.g. "opus-4-7". */
  model?: string | null;
  /** Size in pixels of the orb itself (label adds a few below). */
  size?: number;
  /** Where to park the orb relative to its positioned parent. */
  offset?: { top?: number; right?: number; bottom?: number; left?: number };
}

export function AdvisorOrb({
  active,
  model,
  size = 72,
  offset = { top: -12, right: -96 },
}: AdvisorOrbProps) {
  const label = (model ?? "").replace(/^claude-/, "");

  return (
    <div
      aria-hidden={!active}
      className={`advisor-orb-wrap ${active ? "is-active" : ""}`}
      style={{
        position: "absolute",
        ...offset,
        width: size,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className="advisor-orb-svg"
        role="img"
        aria-label={
          active
            ? `advisor (${label || "unknown"}) consulting`
            : "advisor idle"
        }
      >
        <defs>
          <radialGradient id="advisor-glow" cx="50%" cy="50%" r="50%">
            <stop
              offset="0%"
              stopColor="oklch(0.92 0.08 225)"
              stopOpacity="0.95"
            />
            <stop
              offset="55%"
              stopColor="oklch(0.78 0.12 230)"
              stopOpacity="0.55"
            />
            <stop
              offset="100%"
              stopColor="oklch(0.42 0.13 230)"
              stopOpacity="0"
            />
          </radialGradient>
          <radialGradient id="advisor-core" cx="40%" cy="40%" r="60%">
            <stop offset="0%" stopColor="oklch(0.98 0.04 220)" />
            <stop offset="100%" stopColor="oklch(0.72 0.12 230)" />
          </radialGradient>
        </defs>

        {/* Outer halo — animated via CSS keyframe when active */}
        <circle cx="50" cy="50" r="46" fill="url(#advisor-glow)" />

        {/* Dashed orbital ring — the "in consultation" motif */}
        <circle
          cx="50"
          cy="50"
          r="34"
          fill="none"
          stroke="oklch(0.82 0.10 230 / 0.45)"
          strokeWidth="0.6"
          strokeDasharray="2 3"
          className="advisor-orbit-ring"
        />

        {/* Inner pearl */}
        <circle cx="50" cy="50" r="15" fill="url(#advisor-core)" />
      </svg>

      <div
        className="advisor-orb-label"
        style={{
          fontFamily: "var(--font-mono), ui-monospace, monospace",
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--color-fg-faint)",
          textAlign: "center",
          whiteSpace: "nowrap",
        }}
      >
        {active ? (
          <>
            <span style={{ color: "var(--color-accent)" }}>advisor</span>
            {label ? (
              <>
                {" · "}
                <span style={{ color: "var(--color-fg-dim)" }}>{label}</span>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

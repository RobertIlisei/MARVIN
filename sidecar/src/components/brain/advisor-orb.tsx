"use client";

/**
 * Companion orb that signals "an advisor consult is actively firing" in
 * the UI.
 *
 * Sits beside the main BrainLiquid. Invisible by default — appears only
 * while a Task subagent with a description matching MARVIN's advisor
 * pattern is mid-call (tool_use emitted but tool_result hasn't landed
 * yet). Flies in from off-orbit, pulses with an icy-blue glow, fades out
 * when the consult completes.
 *
 * See ADR-0007 (advisor as userland subagent pattern) for why this
 * detects a Task call and not a literal `advisor` tool: the SDK's
 * `advisorModel` option is server-side routing; there is no callable
 * tool named "advisor".
 *
 * Intentionally SVG + CSS, not a second canvas particle engine. A
 * second BrainLiquid would compete with the main brain for visual
 * attention; a quieter glowing orb reads as a messenger.
 */

interface AdvisorOrbProps {
  /** true while an advisor-pattern Task subagent is running. */
  active: boolean;
  /**
   * Advisor model id hinted on the Task call (e.g. "opus") — rendered
   * as a subtle caption.
   */
  model?: string | null;
  /**
   * Consult topic stripped from the Task description (the text after the
   * "advisor:" prefix). Rendered after the model as additional caption.
   */
  topic?: string | null;
  /** Size in pixels of the orb itself (label adds a few below). */
  size?: number;
  /** Where to park the orb relative to its positioned parent. */
  offset?: { top?: number; right?: number; bottom?: number; left?: number };
}

export function AdvisorOrb({
  active,
  model,
  topic,
  size = 72,
  offset = { top: -12, right: -96 },
}: AdvisorOrbProps) {
  const label = (model ?? "").replace(/^claude-/, "");
  const trimmedTopic = topic ? truncate(topic, 32) : null;

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
            {trimmedTopic ? (
              <div
                style={{
                  marginTop: 2,
                  color: "var(--color-fg-faint)",
                  letterSpacing: "0.08em",
                  textTransform: "none",
                  fontSize: 9.5,
                  maxWidth: size * 2.4,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {trimmedTopic}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

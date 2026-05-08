"use client";

/**
 * Companion orb that signals "a scout subagent is actively firing" in
 * the UI.
 *
 * Sits beside the main BrainLiquid, mirroring `AdvisorOrb` — but
 * visually distinct. The advisor is an icy-blue consultation orb
 * (escalation, judgement); the scout is a warm-teal exploration orb
 * (parallel search, discovery). Same size/layout contract so both can
 * hang off the brain without colliding.
 *
 * Invisible by default — appears only while a Task subagent with
 * `subagent_type: "scout"` (and/or `description: "scout: …"`) is
 * mid-call (tool_use emitted but tool_result not yet). Multiple
 * scouts can run in parallel; v1 just reflects "any active" without a
 * count. Adding a count later is one prop change.
 *
 * See ADR-0014 for why this exists as a separate sanctioned subagent
 * type from the advisor (ADR-0007). Why detection works via the
 * description prefix rather than `subagent_type`: the SDK streams
 * `tool_use` events with the raw user-facing input, not the resolved
 * agent-type slot, so the prefix is the available UI contract.
 */

interface ScoutOrbProps {
  /** true while any scout-pattern Task subagent is running. */
  active: boolean;
  /**
   * Consult topic stripped from the Task description (the text after
   * the "scout:" prefix). Rendered as a caption under the orb.
   */
  topic?: string | null;
  /** Size in pixels of the orb itself (label adds a few below). */
  size?: number;
  /** Where to park the orb relative to its positioned parent. */
  offset?: { top?: number; right?: number; bottom?: number; left?: number };
}

export function ScoutOrb({
  active,
  topic,
  size = 72,
  offset = { top: -12, left: -96 },
}: ScoutOrbProps) {
  const trimmedTopic = topic ? truncate(topic, 32) : null;

  return (
    <div
      aria-hidden={!active}
      className={`scout-orb-wrap ${active ? "is-active" : ""}`}
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
        className="scout-orb-svg"
        role="img"
        aria-label={active ? "scout exploring" : "scout idle"}
      >
        <defs>
          {/* Green-teal palette — same luminosity ladder as the advisor's
              blues so both orbs read as siblings, not competitors. */}
          <radialGradient id="scout-glow" cx="50%" cy="50%" r="50%">
            <stop
              offset="0%"
              stopColor="oklch(0.92 0.10 165)"
              stopOpacity="0.95"
            />
            <stop
              offset="55%"
              stopColor="oklch(0.76 0.14 170)"
              stopOpacity="0.55"
            />
            <stop
              offset="100%"
              stopColor="oklch(0.42 0.14 175)"
              stopOpacity="0"
            />
          </radialGradient>
          <radialGradient id="scout-core" cx="40%" cy="40%" r="60%">
            <stop offset="0%" stopColor="oklch(0.98 0.05 160)" />
            <stop offset="100%" stopColor="oklch(0.70 0.14 175)" />
          </radialGradient>
        </defs>

        {/* Outer halo */}
        <circle cx="50" cy="50" r="46" fill="url(#scout-glow)" />

        {/* Concentric ripple rings — the "breadth-first search" motif.
            Three rings vs the advisor's single orbital ring; rings pulse
            outward via CSS when active, suggesting radiating scans. */}
        <circle
          cx="50"
          cy="50"
          r="24"
          fill="none"
          stroke="oklch(0.82 0.12 170 / 0.55)"
          strokeWidth="0.7"
          className="scout-ripple-inner"
        />
        <circle
          cx="50"
          cy="50"
          r="31"
          fill="none"
          stroke="oklch(0.82 0.12 170 / 0.38)"
          strokeWidth="0.6"
          className="scout-ripple-mid"
        />
        <circle
          cx="50"
          cy="50"
          r="38"
          fill="none"
          stroke="oklch(0.82 0.12 170 / 0.22)"
          strokeWidth="0.5"
          className="scout-ripple-outer"
        />

        {/* Inner pearl */}
        <circle cx="50" cy="50" r="13" fill="url(#scout-core)" />
      </svg>

      <div
        className="scout-orb-label"
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
            <span style={{ color: "oklch(0.65 0.16 170)" }}>scout</span>
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

"use client";

import type { MarvinUiState, TurnStats } from "../chat/types";

/**
 * Editorial masthead strip. Reads top-to-bottom like a nautical log:
 * state glyph → label → hairline → runtime stats separated by thin
 * vertical rulings. State-glyph characters use phases of the moon to
 * carry MARVIN's slightly melancholy instrument aesthetic.
 */
const STATE_GLYPH: Record<MarvinUiState, string> = {
  idle: "◯",
  thinking: "◒",
  tool: "◐",
  writing: "◑",
  error: "◉",
};

const STATE_LABELS: Record<MarvinUiState, string> = {
  idle: "standing by",
  thinking: "thinking",
  tool: "running tool",
  writing: "writing",
  error: "error",
};

const STATE_COLOR: Record<MarvinUiState, string> = {
  idle: "text-[color:var(--color-fg-dim)]",
  thinking: "text-[color:var(--color-accent)]",
  tool: "text-[color:var(--color-accent)]",
  writing: "text-[color:var(--color-success)]",
  error: "text-[color:var(--color-danger)]",
};

export function StatusBar({
  state,
  stats,
  marvinSessionId,
}: {
  state: MarvinUiState;
  stats: TurnStats | null;
  marvinSessionId: string | null;
}) {
  const tokensTotal = stats ? stats.tokens.input + stats.tokens.output : 0;
  const active = state !== "idle";

  return (
    <div className="flex items-center gap-0 rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-bg-elev)]/40 px-0 py-0 font-mono text-[11px]">
      {/* State column — glyph + label, with a fine vertical ruling rhs */}
      <div
        className={`flex items-center gap-2 border-r border-[color:var(--color-border)]/60 px-3 py-1.5 ${STATE_COLOR[state]}`}
      >
        <span
          aria-hidden
          className={`text-[13px] leading-none ${active ? "animate-pulse" : ""}`}
          style={{
            textShadow:
              active
                ? "0 0 8px currentColor, 0 0 16px rgba(217,200,106,0.35)"
                : "none",
          }}
        >
          {STATE_GLYPH[state]}
        </span>
        <span className="tracking-[0.08em]">
          marvin · {STATE_LABELS[state]}
        </span>
      </div>

      {/* Stats ledger — each column has its label above the value, separated by hairlines */}
      <div className="flex flex-1 items-stretch divide-x divide-[color:var(--color-border)]/40 text-[color:var(--color-fg-dim)]">
        <StatCell
          label="dur"
          value={stats?.durationMs != null ? `${(stats.durationMs / 1000).toFixed(1)}s` : "—"}
        />
        <StatCell
          label="tok"
          value={tokensTotal > 0 ? tokensTotal.toLocaleString() : "—"}
        />
        <StatCell
          label="usd"
          value={
            stats?.costUsd != null && stats.costUsd > 0
              ? stats.costUsd < 0.01
                ? "<0.01"
                : stats.costUsd.toFixed(3)
              : "—"
          }
        />
        <StatCell
          label="session"
          value={marvinSessionId ? marvinSessionId.slice(0, 8) : "—"}
          mono
        />
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center px-3 py-0.5">
      <span className="text-[8px] uppercase tracking-[0.28em] text-[color:var(--color-fg-faint)]">
        {label}
      </span>
      <span
        className={`truncate leading-tight text-[color:var(--color-fg)]/90 ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

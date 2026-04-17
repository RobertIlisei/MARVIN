"use client";

import type { MarvinUiState, TurnStats } from "../chat/types";

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
  return (
    <div className="glass flex items-center gap-4 rounded-xl px-4 py-2 text-[11px] font-mono">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${state === "idle" ? "bg-[color:var(--color-fg-faint)]" : "animate-pulse bg-[color:var(--color-accent)]"}`}
        />
        <span className={STATE_COLOR[state]}>MARVIN — {STATE_LABELS[state]}</span>
      </div>
      <div className="ml-auto flex items-center gap-5 text-[color:var(--color-fg-dim)]">
        {stats?.durationMs != null && (
          <span>
            <span className="text-[color:var(--color-fg-faint)]">dur </span>
            {(stats.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {tokensTotal > 0 && (
          <span>
            <span className="text-[color:var(--color-fg-faint)]">tok </span>
            {tokensTotal.toLocaleString()}
          </span>
        )}
        {stats?.costUsd != null && stats.costUsd > 0 && (
          <span>
            <span className="text-[color:var(--color-fg-faint)]">$ </span>
            {stats.costUsd < 0.01 ? "<0.01" : stats.costUsd.toFixed(3)}
          </span>
        )}
        {marvinSessionId && (
          <span className="text-[color:var(--color-fg-faint)]">
            session {marvinSessionId.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  );
}

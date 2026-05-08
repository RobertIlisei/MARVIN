"use client";

/**
 * Small presentational helpers extracted from `apps/web/src/app/page.tsx`
 * as part of the A2 decomposition pass. Pure JSX + props, no state,
 * no effects — safe to move without behaviour change.
 *
 * - `LabeledGroup` — header-row wrapper with a small uppercase label
 *   above a group of related controls.
 * - `PaneToggle` — header-row pane button (Files / Graph / Terminal /
 *   Preview / Brain). Active state carries the accent glow.
 * - `Capability` — hero-screen cards listing MARVIN's capabilities
 *   ("PLANS FIRST", "READS CODE", "RUNS TOOLS", "WRITES DIFFS").
 * - `ExamplePrompt` — hero-screen one-click prompt template cards.
 * - `labelFor` — maps `MarvinUiState` to a human sentence for the
 *   status bar / brain caption ("thinking", "running a tool", …).
 */

import type React from "react";

export function LabeledGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  /** Extra responsive classes from the caller (e.g. `hidden xl:inline-flex`). */
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`.trim()}>
      <span className="hidden font-mono text-[9px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)] xl:inline">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function PaneToggle({
  label,
  active,
  onClick,
  disabled,
  kbd,
  tip,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Optional keyboard hint shown in the tooltip. */
  kbd?: string;
  /** Descriptive tooltip explaining what the pane does. */
  tip?: string;
}) {
  const title = [tip ?? label, kbd ? `(${kbd})` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? "border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
          : "border-[color:var(--color-border)] text-[color:var(--color-fg-dim)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
      }`}
    >
      {label}
    </button>
  );
}

export function Capability({ label, hint }: { label: string; hint: string }) {
  return (
    <div title={hint} className="glass rounded-lg px-3 py-2 text-left">
      <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-accent)]">
        {label}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-[color:var(--color-fg-dim)]">
        {hint}
      </div>
    </div>
  );
}

export function ExamplePrompt({
  title,
  body,
  onUse,
  disabled,
}: {
  title: string;
  body: string;
  onUse: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onUse(body)}
      disabled={disabled}
      title={disabled ? "pick a project first" : "use this prompt"}
      className="group glass rounded-xl px-4 py-3 text-left transition enabled:hover:border-[color:var(--color-accent-deep)]/40 enabled:hover:bg-[color:var(--color-accent-glow)]/10 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-accent)]">
          {title}
        </div>
        <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)] transition group-enabled:group-hover:text-[color:var(--color-accent)]">
          ↩ try
        </span>
      </div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-[color:var(--color-fg)]/90">
        {body}
      </div>
    </button>
  );
}

export function labelFor(state: string): string {
  return (
    {
      idle: "standing by",
      thinking: "thinking",
      tool: "running a tool",
      writing: "writing",
      cancelling: "stopping",
      error: "something broke",
    }[state] ?? state
  );
}

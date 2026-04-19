"use client";

export type PermissionStrategy = "auto" | "gated";

/**
 * auto   — full bypass. MARVIN runs every tool without confirm prompts.
 *          Matches `claude --dangerously-skip-permissions`. Default.
 * gated  — Edit / Write / unsafe Bash render an in-chat confirm card
 *          before executing. Use when you want to review every mutation.
 */
export function PermissionToggle({
  value,
  onChange,
}: {
  value: PermissionStrategy;
  onChange: (next: PermissionStrategy) => void;
}) {
  return (
    <div
      className="flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 p-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      title="Tool permissions. auto = full bypass, MARVIN just runs. gated = confirm card for Edit/Write/unsafe Bash."
    >
      {(["auto", "gated"] as PermissionStrategy[]).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`rounded-full px-2 py-0.5 transition ${
            value === mode
              ? mode === "auto"
                ? "bg-[color:var(--color-warn)]/15 text-[color:var(--color-warn)]"
                : "bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
              : "text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg)]"
          }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

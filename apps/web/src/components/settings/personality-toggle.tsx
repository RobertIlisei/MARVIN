"use client";

export type PersonalityMode = "marvin" | "neutral";

export function PersonalityToggle({
  value,
  onChange,
}: {
  value: PersonalityMode;
  onChange: (next: PersonalityMode) => void;
}) {
  return (
    <div
      className="flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 p-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      title="Chat voice. marvin = Hitchhiker's dry wit. neutral = no style layer."
    >
      {(["marvin", "neutral"] as PersonalityMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`rounded-full px-2 py-0.5 transition ${
            value === mode
              ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
              : "text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg)]"
          }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

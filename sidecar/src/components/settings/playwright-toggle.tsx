"use client";

/**
 * Opt-in toggle for the Playwright MCP browser server (ADR-0045).
 *
 * off — no browser MCP. MARVIN uses the Playwright CLI via Bash for one-shot
 *       captures (default — a browser subprocess per turn is heavy).
 * on  — registers the gated `playwright` MCP server: first-class browser tools
 *       (navigate / snapshot / click / …). Code-exec (`browser_run_code_unsafe`)
 *       is denied; interaction/egress tools confirm in gated mode.
 */
export function PlaywrightToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className="flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 p-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      title="Playwright MCP browser tools. off = Bash CLI only. on = gated browser MCP (navigate/snapshot/click); run_code_unsafe denied."
    >
      {([false, true] as boolean[]).map((on) => (
        <button
          key={String(on)}
          type="button"
          onClick={() => onChange(on)}
          className={`rounded-full px-2 py-0.5 transition ${
            value === on
              ? on
                ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
                : "text-[color:var(--color-fg-faint)]"
              : "text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg)]"
          }`}
        >
          {on ? "on" : "off"}
        </button>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  activePreset,
  PRESETS,
  resolvePreset,
} from "./model-picker-presets";
import type { ModelInfo, ModelsResponse } from "./model-picker-types";

// Re-exported for legacy consumers that import from this module.
export type { ModelInfo, ModelsResponse };

interface ModelPickerProps {
  /** Currently-selected executor model id. `null` = "default". */
  executor: string | null;
  /** Currently-selected advisor model id. `null` = no advisor. */
  advisor: string | null;
  onChange: (next: { executor: string | null; advisor: string | null }) => void;
}

const TIER_LABEL: Record<ModelInfo["tier"], string> = {
  opus: "Opus — flagship reasoning",
  sonnet: "Sonnet — balanced",
  haiku: "Haiku — fast, cheap",
  other: "Other",
};

// All preset logic (pickTierId, resolvePreset, activePreset, PRESETS)
// lives in ./model-picker-presets — pure .ts, Vitest-importable, and
// re-used here via the imports at the top of the file.

/**
 * Header control for picking executor + advisor models.
 *
 * Fetches `/api/models` on open. Two stacked dropdowns:
 *   - **executor** — the model that runs MARVIN's main turn loop.
 *   - **advisor** — optional; enables the SDK's server-side advisor
 *     tool so the executor can escalate to a bigger model for the
 *     hard steps. `null` disables.
 *
 * Both dropdowns draw from the same live-or-fallback list. When the
 * list is the fallback the user sees a small pill warning "fallback
 * list — run claude auth login or set ANTHROPIC_API_KEY for live".
 */
export function ModelPicker({ executor, advisor, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch("/api/models")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled && d) setData(d as ModelsResponse);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(
            err instanceof Error ? err.message : "failed to fetch /api/models",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grouped = useMemo(() => {
    const models = data?.models ?? [];
    const buckets: Record<ModelInfo["tier"], ModelInfo[]> = {
      opus: [],
      sonnet: [],
      haiku: [],
      other: [],
    };
    for (const m of models) buckets[m.tier].push(m);
    return buckets;
  }, [data]);

  const labelFor = (id: string | null): string => {
    if (!id) return "default";
    const hit = data?.models.find((m) => m.id === id);
    if (hit) return hit.displayName.replace(/^Claude\s+/, "");
    // Before /api/models has answered, show the bare id so the button
    // doesn't read "undefined".
    return id.replace(/^claude-/, "");
  };

  const currentPreset = activePreset(executor, advisor, data?.models ?? []);

  // The collapsed-button summary is the at-a-glance signal for which
  // runtime mode is active. The previous form just showed
  // `labelFor(executor)` which rendered "default" when nothing was
  // picked — misleading because the user couldn't tell if they'd
  // configured advisor mode or were on the plain Opus default.
  //
  //  - Solo Opus (the default)          → "opus"
  //  - Advisor mode                     → "advisor · sonnet→opus"
  //  - Custom pair (no preset match)    → "custom · <exec>→<adv>"
  //  - Custom executor, no advisor      → whatever exec model they picked
  const summary = (() => {
    if (currentPreset === "solo") return "opus";
    if (currentPreset === "advisor") {
      return `advisor · ${labelFor(executor)}→${labelFor(advisor)}`;
    }
    return advisor
      ? `custom · ${labelFor(executor)}→${labelFor(advisor)}`
      : labelFor(executor);
  })();

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          advisor
            ? `model: executor ${labelFor(executor)}, advisor ${labelFor(advisor)}`
            : `model: executor ${labelFor(executor)}, no advisor`
        }
        title={
          advisor
            ? `executor: ${labelFor(executor)}  ·  advisor: ${labelFor(advisor)}`
            : `executor: ${labelFor(executor)}  ·  no advisor`
        }
        className="flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
      >
        <span className="truncate">{summary}</span>
        <span className="text-[10px] text-[color:var(--color-fg-faint)]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/95 p-3 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
            <span>model slots</span>
            {data && (
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] ${
                  data.source === "anthropic-api"
                    ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
                    : "bg-[color:var(--color-warn)]/15 text-[color:var(--color-warn)]"
                }`}
                title={data.error ?? undefined}
              >
                {data.source === "anthropic-api" ? "live" : "fallback"}
              </span>
            )}
          </div>

          {/* Preset row — one-click mode switcher. For casual users
              this is the whole picker; the per-slot dropdowns below
              are the power-user override. The presets write both
              slots atomically (including clearing advisor on "solo")
              so it's not possible to land in a half-configured state
              by clicking here. */}
          <div className="mb-3 flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              mode
            </span>
            <div role="radiogroup" aria-label="Runtime mode preset" className="flex gap-1.5">
              {PRESETS.map((preset) => {
                const active = currentPreset === preset.id;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: segmented-control pattern; buttons carry role="radio" for the radiogroup above
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={preset.helper}
                    onClick={() => onChange(resolvePreset(preset, data?.models ?? []))}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-left transition ${
                      active
                        ? "border-[color:var(--color-accent)]/60 bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
                        : "border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/50 text-[color:var(--color-fg-dim)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
                    }`}
                  >
                    <div className="font-mono text-[11px]">{preset.label}</div>
                    <div className="mt-0.5 text-[9.5px] leading-tight text-[color:var(--color-fg-faint)]">
                      {preset.helper}
                    </div>
                  </button>
                );
              })}
            </div>
            {currentPreset === null && (
              <span className="mt-0.5 font-mono text-[9.5px] text-[color:var(--color-fg-faint)]">
                custom pair — neither preset matches. Pick one above to
                reset, or keep the per-slot override below.
              </span>
            )}
          </div>

          <div className="mb-2 h-px bg-[color:var(--color-border)]" />

          <ModelSelect
            label="executor"
            helper="runs the turn loop"
            value={executor}
            models={data?.models ?? []}
            grouped={grouped}
            loading={loading}
            onChange={(next) => onChange({ executor: next, advisor })}
            allowNone={true}
            noneLabel="default (runtime decides)"
          />

          <div className="mt-3">
            <ModelSelect
              label="advisor"
              helper="optional; escalated to for hard steps"
              value={advisor}
              models={data?.models ?? []}
              grouped={grouped}
              loading={loading}
              onChange={(next) => onChange({ executor, advisor: next })}
              allowNone={true}
              noneLabel="off — no advisor"
            />
          </div>

          {data?.error && (
            <div className="mt-3 rounded border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/5 px-2 py-1.5 font-mono text-[10px] text-[color:var(--color-warn)]">
              {data.error}
            </div>
          )}

          {fetchError && !data && (
            <div
              role="alert"
              className="mt-3 rounded border border-[color:var(--color-warn)]/30 bg-[color:var(--color-warn)]/5 px-2 py-1.5 font-mono text-[10px] text-[color:var(--color-warn)]"
            >
              couldn&apos;t load models: {fetchError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelSelect({
  label,
  helper,
  value,
  models,
  grouped,
  loading,
  onChange,
  allowNone,
  noneLabel,
}: {
  label: string;
  helper: string;
  value: string | null;
  models: ModelInfo[];
  grouped: Record<ModelInfo["tier"], ModelInfo[]>;
  loading: boolean;
  onChange: (next: string | null) => void;
  allowNone: boolean;
  noneLabel: string;
}) {
  const total = models.length;
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.22em]">
        <span className="text-[color:var(--color-fg-dim)]">{label}</span>
        <span className="normal-case tracking-normal text-[color:var(--color-fg-faint)]">
          {helper}
        </span>
      </div>
      <div className="relative">
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={loading && total === 0}
          className="w-full appearance-none rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1.5 pr-7 font-mono text-[11px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent-deep)]/50 disabled:opacity-50"
        >
          {allowNone && <option value="">{noneLabel}</option>}
          {(["opus", "sonnet", "haiku", "other"] as const).map(
            (tier) =>
              grouped[tier].length > 0 && (
                <optgroup key={tier} label={TIER_LABEL[tier]}>
                  {grouped[tier].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName.replace(/^Claude\s+/, "")}
                      {m.createdAt
                        ? `  (${m.createdAt.slice(0, 10)})`
                        : ""}
                    </option>
                  ))}
                </optgroup>
              ),
          )}
          {total === 0 && !loading && (
            <option value="" disabled>
              no models available
            </option>
          )}
        </select>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[color:var(--color-fg-faint)]">
          ▾
        </span>
      </div>
    </label>
  );
}

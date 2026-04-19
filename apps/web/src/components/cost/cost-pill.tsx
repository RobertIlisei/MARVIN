"use client";

import { useEffect, useState } from "react";

import type { CostSummary } from "@/components/project/types";

function fmtUsd(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function CostPill({
  projectId,
  refreshKey = 0,
}: {
  projectId: string | null;
  refreshKey?: number;
}) {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cost?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSummary(d as CostSummary);
      })
      .catch(() => {
        /* no-op */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  if (!projectId) return null;
  const today = summary?.today.costUsd ?? 0;
  const week = summary?.week.costUsd ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
        title="Claude cost for this project"
      >
        <span className="text-[color:var(--color-fg-faint)]">today</span>
        <span className="text-[color:var(--color-fg)]">{fmtUsd(today)}</span>
      </button>
      {open && summary && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/95 p-3 shadow-2xl backdrop-blur">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              cost for this project
            </div>
            <dl className="space-y-1 font-mono text-[11px]">
              <div className="flex justify-between">
                <dt className="text-[color:var(--color-fg-dim)]">today</dt>
                <dd className="text-[color:var(--color-fg)]">{fmtUsd(today)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[color:var(--color-fg-dim)]">7 days</dt>
                <dd className="text-[color:var(--color-fg)]">{fmtUsd(week)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[color:var(--color-fg-dim)]">lifetime</dt>
                <dd className="text-[color:var(--color-fg)]">
                  {fmtUsd(summary.lifetime.costUsd)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-[color:var(--color-border)] pt-1">
                <dt className="text-[color:var(--color-fg-dim)]">turns</dt>
                <dd className="text-[color:var(--color-fg)]">
                  {summary.lifetime.turns}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[color:var(--color-fg-dim)]">in / out tokens</dt>
                <dd className="text-[color:var(--color-fg)]">
                  {summary.lifetime.inputTokens.toLocaleString()} /{" "}
                  {summary.lifetime.outputTokens.toLocaleString()}
                </dd>
              </div>
            </dl>
            {summary.daily.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-fg-faint)]">
                  <span>last {summary.daily.length} active days</span>
                  <span className="normal-case tracking-normal text-[color:var(--color-fg-dim)]">
                    max {fmtUsd(Math.max(...summary.daily.map((x) => x.costUsd), 0))}
                  </span>
                </div>
                <div className="flex h-14 items-end gap-1 border-b border-[color:var(--color-border)] pb-0.5">
                  {summary.daily.map((d) => {
                    const max = Math.max(
                      ...summary.daily.map((x) => x.costUsd),
                      0.0001,
                    );
                    const h = Math.max(3, Math.round((d.costUsd / max) * 48));
                    return (
                      <div
                        key={d.day}
                        title={`${d.day}: ${fmtUsd(d.costUsd)} · ${d.turns} turns`}
                        className="group relative flex-1"
                      >
                        <div
                          className="mx-auto w-full rounded-t bg-gradient-to-t from-[color:var(--color-accent-deep)] to-[color:var(--color-accent)] opacity-80 transition group-hover:opacity-100"
                          style={{ height: `${h}px` }}
                        />
                        <div className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[color:var(--color-bg-elev)] px-1 font-mono text-[9px] text-[color:var(--color-fg)] opacity-0 group-hover:opacity-100">
                          {fmtUsd(d.costUsd)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex gap-1 font-mono text-[9px] text-[color:var(--color-fg-faint)]">
                  {summary.daily.map((d) => (
                    <div key={`lbl-${d.day}`} className="flex-1 text-center">
                      {d.day.slice(5)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

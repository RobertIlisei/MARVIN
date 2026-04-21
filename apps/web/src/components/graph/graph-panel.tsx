"use client";

import { useEffect, useMemo, useState } from "react";

interface GraphSummary {
  ok: boolean;
  path: string;
  exists: boolean;
  updatedAt: string | null;
  error: string | null;
  stats: { nodes: number; edges: number; communities: number };
  godNodes: Array<{ id: string; label: string; degree: number }>;
  communities: Array<{ id: number; size: number; sampleLabels: string[] }>;
}

interface SearchHit {
  id: string;
  label: string;
  sourceFile: string | null;
  degree: number;
  community: number | null;
}

export function GraphPanel({ cwd }: { cwd: string | null }) {
  const [summary, setSummary] = useState<GraphSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/graph/query?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setSummary(d.summary as GraphSummary);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!cwd || !query.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/graph/query?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { hits?: SearchHit[] };
        if (!cancelled) setHits(data.hits ?? []);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cwd, query]);

  const header = useMemo(() => {
    if (!cwd)
      return "Pick a project to see its knowledge graph.";
    if (loading) return "Reading graph…";
    if (!summary || !summary.ok)
      return summary?.error ?? "No graph yet. Run `/graphify` in this project.";
    const when = summary.updatedAt
      ? new Date(summary.updatedAt).toLocaleString()
      : "unknown";
    return `${summary.stats.nodes} nodes · ${summary.stats.edges} edges · ${summary.stats.communities} communities · updated ${when}`;
  }, [cwd, loading, summary]);

  const iframeSrc = cwd
    ? `/api/graph/html?cwd=${encodeURIComponent(cwd)}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[color:var(--color-border)] px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
          knowledge graph
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[color:var(--color-fg-dim)]">
          {header}
        </div>
      </div>

      {summary?.ok && iframeSrc && (
        <div className="min-h-[260px] flex-[2] border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
          <iframe
            // `key` forces a fresh load on cwd change (or after /graphify refresh)
            key={iframeSrc}
            src={iframeSrc}
            title="knowledge graph"
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      )}

      {summary?.ok && (
        <div className="border-b border-[color:var(--color-border)] px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search the graph"
            className="w-full rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-accent-deep)]/50"
          />
        </div>
      )}

      <div className="scroll-thin min-h-[120px] flex-1 overflow-y-auto px-3 py-2">
        {hits !== null ? (
          <>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              {searching
                ? "searching…"
                : hits.length === 0
                  ? `no hits for "${query}"`
                  : `${hits.length} hits for "${query}"`}
            </div>
            <ul className="space-y-1">
              {hits.map((h) => (
                <li
                  key={h.id}
                  className="rounded border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px]"
                >
                  <div className="truncate text-[color:var(--color-fg)]">
                    {h.label}
                  </div>
                  <div className="truncate text-[10px] text-[color:var(--color-fg-faint)]">
                    {h.sourceFile ?? ""} · degree {h.degree}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : summary?.ok ? (
          <>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              god nodes
            </div>
            <ul className="mb-4 space-y-0.5">
              {summary.godNodes.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between rounded px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]/90 transition hover:bg-[color:var(--color-accent-glow)] hover:text-[color:var(--color-accent)]"
                >
                  <span className="truncate">{g.label}</span>
                  <span className="text-[10px] text-[color:var(--color-fg-faint)]">
                    {g.degree}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              communities
            </div>
            <ul className="space-y-1">
              {summary.communities.map((c) => (
                <li
                  key={c.id}
                  className="rounded border border-[color:var(--color-border)] px-2 py-1"
                >
                  <div className="flex justify-between font-mono text-[10px] text-[color:var(--color-fg-faint)]">
                    <span>community {c.id}</span>
                    <span>{c.size} nodes</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-[color:var(--color-fg)]/85">
                    {c.sampleLabels.join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          !loading &&
          cwd && (
            <div className="px-1 py-4 text-[11px] text-[color:var(--color-fg-dim)]">
              Tip: run <span className="font-mono">/graphify</span> inside this
              project&apos;s directory to build a graph MARVIN can reason over.
            </div>
          )
        )}
      </div>
    </div>
  );
}

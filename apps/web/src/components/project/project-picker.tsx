"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  ProjectRecord,
  SessionSummary,
  VerifyResult,
} from "./types";
import { AddProjectDialog } from "./add-project-dialog";

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ProjectPicker({
  projects,
  active,
  loading,
  onSelect,
  onRemove,
  onAdd,
  verifyWorkDir,
  onResumeSession,
  openSignal,
}: {
  projects: ProjectRecord[];
  active: ProjectRecord | null;
  loading: boolean;
  onSelect: (id: string | null) => Promise<void> | void;
  onRemove: (id: string) => Promise<boolean> | boolean;
  onAdd: (input: {
    name?: string;
    workDir: string;
    setActive?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  verifyWorkDir: (path: string) => Promise<VerifyResult>;
  onResumeSession?: (projectId: string, sessionId: string) => void;
  /** Monotonic counter — when it changes, open the picker. */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  useEffect(() => {
    if (openSignal != null && openSignal > 0) setOpen(true);
  }, [openSignal]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.workDir.toLowerCase().includes(q),
    );
  }, [projects, filter]);

  // Load sessions for the active project when the picker opens.
  useEffect(() => {
    if (!open || !active) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setSessionsLoading(true);
    fetch(`/api/sessions?projectId=${encodeURIComponent(active.id)}`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => {
        if (cancelled) return;
        setSessions(
          Array.isArray(d.sessions) ? (d.sessions as SessionSummary[]) : [],
        );
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, active]);

  const label = active
    ? active.name
    : loading
      ? "loading…"
      : "pick a project";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[12px] transition ${
          active
            ? "border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)] hover:border-[color:var(--color-accent-deep)]"
            : "border-[color:var(--color-accent-deep)]/50 bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)] hover:border-[color:var(--color-accent-deep)]"
        }`}
        title={active?.workDir ?? "no project selected"}
      >
        <span className="inline-flex h-2 w-2 rounded-full bg-[color:var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]" />
        <span className="truncate max-w-[260px]">{label}</span>
        {active && (
          <span className="truncate text-[10px] text-[color:var(--color-fg-faint)] max-w-[220px]">
            {active.workDir}
          </span>
        )}
        <span className="text-[10px] text-[color:var(--color-fg-faint)]">▾</span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onMouseDown={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-40 mt-2 w-[min(560px,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/95 shadow-2xl backdrop-blur">
            <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-2">
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="search projects"
                className="flex-1 bg-transparent font-mono text-[12px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)]"
              />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setAddOpen(true);
                }}
                className="rounded-md border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-2.5 py-1 text-[11px] font-mono text-[color:var(--color-accent)] transition hover:border-[color:var(--color-accent-deep)]"
              >
                + add
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12px] text-[color:var(--color-fg-dim)]">
                  {projects.length === 0
                    ? "No projects yet. Click + add to register one."
                    : "No projects match that search."}
                </div>
              ) : (
                <ul>
                  {filtered.map((p) => {
                    const isActive = p.id === active?.id;
                    return (
                      <li
                        key={p.id}
                        className={`group flex items-center gap-2 border-b border-[color:var(--color-border)]/50 px-3 py-2 transition hover:bg-[color:var(--color-accent-glow)] ${
                          isActive ? "bg-[color:var(--color-accent-glow)]" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={async () => {
                            await onSelect(p.id);
                            setOpen(false);
                          }}
                          className="flex min-w-0 flex-1 flex-col items-start text-left"
                        >
                          <span
                            className={`truncate text-sm ${
                              isActive
                                ? "text-[color:var(--color-accent)]"
                                : "text-[color:var(--color-fg)]"
                            }`}
                          >
                            {p.name}
                          </span>
                          <span className="truncate font-mono text-[10px] text-[color:var(--color-fg-dim)]">
                            {p.workDir}
                          </span>
                          <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)]">
                            last used {fmtWhen(p.lastUsedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm(`Remove ${p.name}?`)) return;
                            await onRemove(p.id);
                          }}
                          className="rounded border border-transparent px-2 py-1 font-mono text-[10px] text-[color:var(--color-fg-faint)] transition group-hover:border-[color:var(--color-border)] group-hover:text-[color:var(--color-fg-dim)] hover:border-[color:var(--color-danger)]/40 hover:text-[color:var(--color-danger)]"
                          title="remove from MARVIN (files untouched)"
                        >
                          remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {active && onResumeSession && (
              <div className="border-t border-[color:var(--color-border)] px-3 py-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
                    recent sessions for {active.name}
                  </div>
                  {sessions.length > 0 && (
                    <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)]">
                      {sessions.length}
                    </span>
                  )}
                </div>
                {sessions.length > 5 && (
                  <input
                    value={sessionFilter}
                    onChange={(e) => setSessionFilter(e.target.value)}
                    placeholder="search sessions…"
                    className="mb-1 w-full rounded border border-[color:var(--color-border)] bg-transparent px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-accent-deep)]/50"
                  />
                )}
                {sessionsLoading ? (
                  <div className="py-2 text-[11px] text-[color:var(--color-fg-dim)]">
                    loading…
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="py-2 text-[11px] text-[color:var(--color-fg-dim)]">
                    No saved sessions yet.
                  </div>
                ) : (
                  (() => {
                    const q = sessionFilter.trim().toLowerCase();
                    const shown = q
                      ? sessions.filter((s) =>
                          (s.firstUserMessage ?? "")
                            .toLowerCase()
                            .includes(q),
                        )
                      : sessions;
                    if (shown.length === 0) {
                      return (
                        <div className="py-2 text-[11px] text-[color:var(--color-fg-dim)]">
                          No sessions match &quot;{sessionFilter}&quot;.
                        </div>
                      );
                    }
                    return (
                      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                        {shown.slice(0, 20).map((s) => (
                          <li key={s.sessionId}>
                            <button
                              type="button"
                              onClick={() => {
                                onResumeSession(active.id, s.sessionId);
                                setOpen(false);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-[11px] text-[color:var(--color-fg)]/85 transition hover:bg-[color:var(--color-accent-glow)] hover:text-[color:var(--color-accent)]"
                            >
                              <span className="truncate">
                                {s.firstUserMessage ?? "(empty session)"}
                              </span>
                              <span className="text-[10px] text-[color:var(--color-fg-faint)]">
                                {s.turnCount} · {fmtWhen(s.updatedAt)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    );
                  })()
                )}
              </div>
            )}
          </div>
        </>
      )}

      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={onAdd}
        verifyWorkDir={verifyWorkDir}
      />
    </div>
  );
}

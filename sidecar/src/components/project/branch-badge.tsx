"use client";

import { useEffect, useState } from "react";

interface StatusResponse {
  isGit: boolean;
  branch?: string | null;
  status: Record<string, string>;
}

/**
 * Header pill showing the git branch of the currently-active project's
 * workDir — plus a tiny dirty-count indicator when there are uncommitted
 * changes. Hidden entirely when there's no project or the workDir isn't
 * a git repo.
 *
 * Refreshes when `cwd` changes and after every completed turn
 * (via the shared `refreshKey` the header already bumps on `turn.completed`).
 */
export function BranchBadge({
  cwd,
  refreshKey = 0,
}: {
  cwd: string | null;
  refreshKey?: number;
}) {
  const [data, setData] = useState<StatusResponse | null>(null);

  useEffect(() => {
    if (!cwd) {
      setData(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/files/status?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setData(d as StatusResponse);
      })
      .catch(() => {
        /* no-op — pill simply stays hidden if git call fails */
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, refreshKey]);


  if (!data?.isGit || !data.branch) return null;

  const dirtyCount = Object.keys(data.status).length;
  const title =
    dirtyCount === 0
      ? `git branch · clean  (${cwd})`
      : `git branch · ${dirtyCount} uncommitted ${dirtyCount === 1 ? "change" : "changes"}  (${cwd})`;

  return (
    <span
      role="status"
      title={title}
      aria-label={`git branch ${data.branch}${
        dirtyCount > 0 ? `, ${dirtyCount} uncommitted changes` : ", clean"
      }`}
      className="flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)]"
    >
      <span className="text-[color:var(--color-fg-faint)]">git</span>
      <span className="text-[color:var(--color-fg)]">{data.branch}</span>
      {dirtyCount > 0 && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-warn)]"
        />
      )}
    </span>
  );
}

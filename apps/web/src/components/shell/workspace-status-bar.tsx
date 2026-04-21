"use client";

/**
 * Left-column footer strip. VSCode / Cursor parity: a persistent row
 * under the Files / Source Control content showing:
 *
 *   [ workspace-name ]                  [ branch ● ↑N↓M ]
 *
 * The branch area is a click target — tapping it switches the tab
 * to Source Control (where the full branch switcher lives) so users
 * who spot they're on the wrong branch have a one-click path into
 * the switcher without hunting for the ⌄ in the branch bar.
 *
 * State comes from a 5 s poll against `/api/git/status`. The Source
 * Control panel already polls at 2 s when visible, but this bar is
 * cheap enough on its own and decouples the footer from panel-
 * visibility — the bar shows the current branch regardless of which
 * left-column tab is active.
 */

import { Folder, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import type { LeftColumnTab } from "@/components/left-column-tabs";

interface StatusState {
  enabled: boolean;
  branch: string | null;
  isDirty: boolean;
  ahead: number | null;
  behind: number | null;
}

const EMPTY: StatusState = {
  enabled: false,
  branch: null,
  isDirty: false,
  ahead: null,
  behind: null,
};

// 5 s cadence is a compromise: responsive enough that the bar doesn't
// feel stale after a commit, quiet enough that it doesn't churn the
// event loop when the user's away. The Source Control panel's faster
// 2 s poll covers the "watching the tree" case; this is the "glance
// at the footer" case.
const POLL_MS = 5000;

export function WorkspaceStatusBar({
  cwd,
  projectName,
  onSwitchToSourceControl,
}: {
  cwd: string | null;
  projectName: string | null;
  onSwitchToSourceControl?(tab: LeftColumnTab): void;
}) {
  const [state, setState] = useState<StatusState>(EMPTY);

  useEffect(() => {
    if (!cwd) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const res = await fetch(
          `/api/git/status?cwd=${encodeURIComponent(cwd)}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const body = await res.json();
        if (cancelled) return;
        if (body?.enabled === false) {
          setState(EMPTY);
          return;
        }
        const files = (body.files ?? []) as Array<{ entryType?: string }>;
        // A file counts toward "dirty" unless it's ignored. Includes
        // untracked, unmerged, staged, renamed — any actionable state.
        const dirty = files.some((f) => f.entryType !== "ignored");
        setState({
          enabled: Boolean(body?.enabled),
          branch: body?.branch?.name ?? null,
          isDirty: dirty,
          ahead: body?.branch?.ahead ?? null,
          behind: body?.branch?.behind ?? null,
        });
      } catch {
        /* network hiccups ignored — next tick will retry */
      }
    };

    void fetchStatus();
    const id = window.setInterval(fetchStatus, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cwd]);

  const workspaceLabel = projectName ?? (cwd ? basename(cwd) : null);

  return (
    <div className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--material-toolbar)] px-2.5 py-1">
      {/* Left: workspace / project name */}
      <div
        className="flex min-w-0 items-center gap-1 truncate text-[color:var(--color-fg-faint)]"
        title={cwd ?? "no project selected"}
      >
        <Folder size={11} strokeWidth={1.8} className="shrink-0" aria-hidden />
        <span className="truncate font-mono text-[10.5px] text-[color:var(--color-fg-dim)]">
          {workspaceLabel ?? "no project"}
        </span>
      </div>

      {/* Right: branch, dirty dot, ahead/behind */}
      {state.enabled && state.branch ? (
        <button
          type="button"
          onClick={() => onSwitchToSourceControl?.("source-control")}
          title={
            state.isDirty
              ? `${state.branch} · uncommitted changes · click to open Source Control`
              : `${state.branch} · click to open Source Control`
          }
          className="flex shrink-0 items-center gap-1.5 rounded-[3px] px-1 py-0.5 font-mono text-[10.5px] text-[color:var(--color-fg-dim)] transition hover:bg-[color:var(--color-bg-elev)]/60 hover:text-[color:var(--color-fg)]"
        >
          <GitBranch size={11} strokeWidth={1.8} aria-hidden />
          <span className="truncate max-w-[120px]">{state.branch}</span>
          {state.isDirty && (
            <span
              title="uncommitted changes"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)]"
            />
          )}
          {state.ahead !== null && state.ahead > 0 && (
            <span title={`${state.ahead} commits ahead of upstream`}>
              ↑{state.ahead}
            </span>
          )}
          {state.behind !== null && state.behind > 0 && (
            <span title={`${state.behind} commits behind upstream`}>
              ↓{state.behind}
            </span>
          )}
        </button>
      ) : (
        <span className="font-mono text-[10.5px] text-[color:var(--color-fg-faint)]">
          {cwd ? (state.enabled ? "—" : "not a git repo") : ""}
        </span>
      )}
    </div>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

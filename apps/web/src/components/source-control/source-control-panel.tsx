"use client";

/**
 * Source Control panel — M2 scaffold.
 *
 * Shows the current branch, ahead / behind counters, and a grouped
 * status list (staged / changes / untracked / conflicts). Click a
 * row → fires `onSelect(absolutePath)` so the host can open the
 * file in the centre viewer.
 *
 * Mutation affordances (stage / unstage / discard / commit box)
 * land in M3. The commit-box placeholder at the bottom renders a
 * disabled textarea with a hint so the eventual surface isn't a
 * jump-scare once M3 lands.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { useMemo } from "react";

import { BranchBar } from "./branch-bar";
import { StatusList } from "./status-list";
import { useGitStatus } from "./use-git-status";

export interface SourceControlPanelProps {
  cwd: string | null;
  /**
   * `true` when the panel is visible (i.e. its tab is selected).
   * Gates the polling hook so we don't spam `/api/git/status`
   * when the user is on the Files tab.
   */
  visible: boolean;
  selectedPath: string | null;
  onSelect(absolutePath: string): void;
}

export function SourceControlPanel({
  cwd,
  visible,
  selectedPath,
  onSelect,
}: SourceControlPanelProps) {
  const { state } = useGitStatus({ cwd, enabled: visible });

  const totalChanges = useMemo(() => {
    if (state.phase !== "ready") return 0;
    return state.data.files.filter((f) => f.entryType !== "ignored").length;
  }, [state]);

  if (!cwd) {
    return (
      <EmptyState
        title="No project selected"
        body="Pick a project from the top bar to see source-control state."
      />
    );
  }

  if (state.phase === "idle" || state.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] italic text-[color:var(--color-fg-faint)]">
        {state.phase === "loading" ? "loading git status…" : "…"}
      </div>
    );
  }

  if (state.phase === "no-repo") {
    return (
      <EmptyState
        title="Not a git repository"
        body="MARVIN only shows source-control state for projects initialised with git. Run `git init` in the project to start tracking changes."
      />
    );
  }

  if (state.phase === "error") {
    return (
      <EmptyState
        title="Couldn't read git status"
        body={`The status poll failed: ${state.message}. MARVIN will keep retrying — this surface clears once git answers.`}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <BranchBar branch={state.data.branch} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <StatusList
          files={state.data.files}
          cwd={cwd}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      </div>
      <CommitBoxPlaceholder changeCount={totalChanges} />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
        source control
      </div>
      <div className="font-display text-[15px] leading-tight text-[color:var(--color-fg)]">
        {title}
      </div>
      <p className="max-w-prose text-[11.5px] leading-relaxed text-[color:var(--color-fg-dim)]">
        {body}
      </p>
    </div>
  );
}

/**
 * M3 replaces this with a real textarea + amend toggle + commit
 * button wired to `/api/git/commit`. For M2 we render a shape-stable
 * placeholder so the panel layout doesn't jump when mutations land.
 */
function CommitBoxPlaceholder({ changeCount }: { changeCount: number }) {
  return (
    <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
        <span>commit</span>
        <span className="tracking-normal">
          {changeCount === 0
            ? "nothing to commit"
            : `${changeCount} file${changeCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div
        className="rounded-[4px] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg)]/40 px-2.5 py-2 font-mono text-[10.5px] italic text-[color:var(--color-fg-faint)]"
        aria-live="off"
      >
        commit affordance ships in M3 — stage / unstage, write a
        message, click commit
      </div>
    </div>
  );
}

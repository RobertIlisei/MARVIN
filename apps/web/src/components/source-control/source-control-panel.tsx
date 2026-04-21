"use client";

/**
 * Source Control panel — M3.
 *
 * Composes:
 *   - `BranchBar` with the branch switcher dropdown
 *   - `StatusList` with hover action icons (stage / unstage / discard)
 *   - `CommitBox` with amend toggle + ⌘Enter to commit
 *   - `ConfirmGitOpDialog` rendered at panel scope for every
 *     confirm-class mutation
 *
 * The poll hook (`use-git-status`) and the mutation hook
 * (`use-git-mutations`) are both owned here. A successful mutation
 * fires `refresh()` on the status poll so the UI updates before the
 * next 2 s tick.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { useCallback, useMemo } from "react";

import { BranchBar } from "./branch-bar";
import { CommitBox } from "./commit-box";
import { ConfirmGitOpDialog } from "./confirm-git-op-dialog";
import { StatusList } from "./status-list";
import { useGitMutations } from "./use-git-mutations";
import { useGitStatus } from "./use-git-status";

export interface SourceControlPanelProps {
  cwd: string | null;
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
  const { state, refresh } = useGitStatus({ cwd, enabled: visible });

  const mutations = useGitMutations({
    cwd,
    onChanged: refresh,
  });

  const stagedCount = useMemo(() => {
    if (state.phase !== "ready") return 0;
    return state.data.files.filter(
      (f) => f.indexStatus !== "." && f.entryType !== "untracked",
    ).length;
  }, [state]);

  const commitHandler = useCallback(
    (message: string, amend: boolean) => mutations.commit(message, amend),
    [mutations],
  );

  if (!cwd) {
    return (
      <>
        <EmptyState
          title="No project selected"
          body="Pick a project from the top bar to see source-control state."
        />
        <ConfirmGitOpDialog pending={mutations.state.pending} />
      </>
    );
  }

  if (state.phase === "idle" || state.phase === "loading") {
    return (
      <>
        <div className="flex h-full items-center justify-center px-4 text-center text-[11px] italic text-[color:var(--color-fg-faint)]">
          {state.phase === "loading" ? "loading git status…" : "…"}
        </div>
        <ConfirmGitOpDialog pending={mutations.state.pending} />
      </>
    );
  }

  if (state.phase === "no-repo") {
    return (
      <>
        <EmptyState
          title="Not a git repository"
          body="MARVIN only shows source-control state for projects initialised with git. Run `git init` in the project to start tracking changes."
        />
        <ConfirmGitOpDialog pending={mutations.state.pending} />
      </>
    );
  }

  if (state.phase === "error") {
    return (
      <>
        <EmptyState
          title="Couldn't read git status"
          body={`The status poll failed: ${state.message}. MARVIN will keep retrying — this surface clears once git answers.`}
        />
        <ConfirmGitOpDialog pending={mutations.state.pending} />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <BranchBar
        branch={state.data.branch}
        cwd={cwd}
        onSwitch={mutations.branchSwitch}
        onCreate={mutations.branchCreate}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <StatusList
          files={state.data.files}
          cwd={cwd}
          selectedPath={selectedPath}
          onSelect={onSelect}
          actions={{
            stage: mutations.stage,
            unstage: mutations.unstage,
            discard: mutations.discard,
          }}
          busy={mutations.state.busy}
        />
      </div>
      {mutations.state.error && (
        <ErrorBanner
          message={mutations.state.error.message}
          onDismiss={mutations.dismissError}
        />
      )}
      <CommitBox
        stagedCount={stagedCount}
        busy={mutations.state.busy}
        onCommit={commitHandler}
      />
      <ConfirmGitOpDialog pending={mutations.state.pending} />
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

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss(): void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/12 px-3 py-1.5 font-mono text-[10.5px] text-[color:var(--color-danger)]">
      <span className="truncate" title={message}>
        {message}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-1 text-[13px] leading-none hover:bg-[color:var(--color-danger)]/20"
        aria-label="dismiss error"
      >
        ×
      </button>
    </div>
  );
}

"use client";

import type { StatusBranch } from "@marvin/git";

import { BranchSwitcher } from "./branch-switcher";

/**
 * Top-of-panel branch indicator: current branch name, upstream, and
 * ahead / behind counters. The dropdown arrow opens the branch
 * switcher populated from `/api/git/branch`.
 */
export function BranchBar({
  branch,
  cwd,
  onSwitch,
  onCreate,
}: {
  branch: StatusBranch;
  cwd: string;
  onSwitch(name: string): Promise<boolean>;
  onCreate(name: string, from?: string): Promise<boolean>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <BranchGlyph />
        <div className="min-w-0">
          <div
            className="truncate font-mono text-[11.5px] text-[color:var(--color-fg)]"
            title={branch.name ?? "(detached HEAD)"}
          >
            {branch.name ?? "detached"}
          </div>
          {branch.upstream ? (
            <div
              className="truncate font-mono text-[10px] text-[color:var(--color-fg-faint)]"
              title={branch.upstream}
            >
              ↕ {branch.upstream}
            </div>
          ) : (
            <div className="font-mono text-[10px] italic text-[color:var(--color-fg-faint)]">
              no upstream
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {branch.upstream && (branch.ahead !== null || branch.behind !== null) && (
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-[color:var(--color-fg-faint)]">
            {branch.ahead !== null && branch.ahead > 0 && (
              <span title={`${branch.ahead} commits ahead of upstream`}>
                ↑{branch.ahead}
              </span>
            )}
            {branch.behind !== null && branch.behind > 0 && (
              <span title={`${branch.behind} commits behind upstream`}>
                ↓{branch.behind}
              </span>
            )}
            {branch.ahead === 0 && branch.behind === 0 && (
              <span title="Up to date with upstream">=</span>
            )}
          </div>
        )}
        <BranchSwitcher
          cwd={cwd}
          currentBranch={branch.name}
          onSwitch={onSwitch}
          onCreate={onCreate}
        />
      </div>
    </div>
  );
}

function BranchGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0 text-[color:var(--color-fg-dim)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 4.5v7" />
      <path d="M4 10c0-3 2-5 6-5" />
    </svg>
  );
}

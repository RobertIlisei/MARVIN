"use client";

/**
 * Grouped file-status list for the Source Control panel.
 *
 * Three buckets:
 *   - Staged — at least one of index / working tracks a change and the
 *     index side is non-"." (i.e. the change is visible in `--cached`).
 *   - Changes — unstaged modifications, deletions, type changes.
 *   - Untracked — new files git has never seen.
 *
 * Conflicts (`entryType === "unmerged"`) are surfaced at the top with
 * their own label so they can't get lost in the staged bucket.
 *
 * Action icons (stage / unstage / discard) render in M2 but are
 * disabled — mutation endpoints land in M3. Clicking a row fires
 * `onSelect(path)` so the parent can open the file (viewer) or diff
 * (future).
 */

import type { StatusFile } from "@marvin/git";

import { StatusBadge } from "./status-badge";

interface StatusListProps {
  files: readonly StatusFile[];
  cwd: string;
  selectedPath: string | null;
  onSelect(absolutePath: string): void;
}

interface Bucket {
  label: string;
  emptyHint?: string;
  files: StatusFile[];
}

export function StatusList({
  files,
  cwd,
  selectedPath,
  onSelect,
}: StatusListProps) {
  const buckets = groupFiles(files);
  if (files.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] italic text-[color:var(--color-fg-faint)]">
        Nothing to commit — working tree clean.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 py-2">
      {buckets.map((bucket) => {
        if (bucket.files.length === 0) return null;
        return (
          <section key={bucket.label} className="flex flex-col">
            <header className="flex items-baseline justify-between px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              <span>{bucket.label}</span>
              <span className="font-sans text-[10.5px] tracking-normal text-[color:var(--color-fg-faint)]">
                {bucket.files.length}
              </span>
            </header>
            <ul className="flex flex-col">
              {bucket.files.map((file) => {
                const absolutePath = joinPath(cwd, file.path);
                const isSelected = selectedPath === absolutePath;
                return (
                  <li key={`${bucket.label}:${file.path}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(absolutePath)}
                      className={`flex w-full items-center gap-2 px-3 py-[5px] text-left font-mono text-[11.5px] transition ${
                        isSelected
                          ? "bg-[color:var(--color-accent-deep)]/18 text-[color:var(--color-fg)]"
                          : "text-[color:var(--color-fg-dim)] hover:bg-[color:var(--color-bg-elev)]/60 hover:text-[color:var(--color-fg)]"
                      }`}
                      title={file.path}
                    >
                      <StatusBadge file={file} />
                      <span className="truncate">
                        {file.renamedFrom ? (
                          <>
                            <span className="text-[color:var(--color-fg-faint)]">
                              {file.renamedFrom}
                            </span>
                            <span className="px-1 text-[color:var(--color-fg-faint)]">
                              →
                            </span>
                          </>
                        ) : null}
                        {file.path}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function groupFiles(files: readonly StatusFile[]): Bucket[] {
  const conflicts: StatusFile[] = [];
  const staged: StatusFile[] = [];
  const changes: StatusFile[] = [];
  const untracked: StatusFile[] = [];
  for (const f of files) {
    if (f.entryType === "unmerged") {
      conflicts.push(f);
      continue;
    }
    if (f.entryType === "untracked") {
      untracked.push(f);
      continue;
    }
    if (f.entryType === "ignored") continue; // git doesn't surface these by default; don't render
    const stagedSide = f.indexStatus !== ".";
    const unstagedSide = f.workingStatus !== ".";
    if (stagedSide) staged.push(f);
    if (unstagedSide) changes.push(f);
  }
  return [
    { label: "Conflicts", files: conflicts },
    { label: "Staged", files: staged },
    { label: "Changes", files: changes },
    { label: "Untracked", files: untracked },
  ];
}

function joinPath(cwd: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return `${cwd.replace(/\/+$/, "")}/${rel}`;
}

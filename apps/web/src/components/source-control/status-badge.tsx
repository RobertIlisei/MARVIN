"use client";

import type { StatusFile } from "@marvin/git";

/**
 * Two-character status pill, styled consistently with how VSCode /
 * Cursor render gutter icons: single-letter code, coloured by the
 * underlying change kind. The ordering mirrors `git status`:
 * index-side code first, working-side second.
 */
export function StatusBadge({ file }: { file: StatusFile }) {
  const badge = resolveBadge(file);
  return (
    <span
      className={`inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-[3px] px-1 font-mono text-[10px] font-semibold leading-none tracking-[0.05em] ${badge.className}`}
      title={badge.title}
    >
      {badge.label}
    </span>
  );
}

function resolveBadge(file: StatusFile): {
  label: string;
  title: string;
  className: string;
} {
  if (file.entryType === "unmerged") {
    return {
      label: "!",
      title: "Merge conflict",
      className:
        "bg-[color:var(--color-danger)]/18 text-[color:var(--color-danger)]",
    };
  }
  if (file.entryType === "untracked") {
    return {
      label: "U",
      title: "Untracked",
      className:
        "bg-[color:var(--color-warn)]/18 text-[color:var(--color-warn)]",
    };
  }
  const primary =
    file.indexStatus !== "." ? file.indexStatus : file.workingStatus;
  const staged = file.indexStatus !== ".";
  switch (primary) {
    case "A":
      return {
        label: "A",
        title: staged ? "Added (staged)" : "Added",
        className:
          "bg-[color:var(--color-success)]/18 text-[color:var(--color-success)]",
      };
    case "M":
      return {
        label: "M",
        title: staged ? "Modified (staged)" : "Modified",
        className: staged
          ? "bg-[color:var(--color-accent-deep)]/22 text-[color:var(--color-accent-deep)]"
          : "bg-[color:var(--color-fg-dim)]/18 text-[color:var(--color-fg-dim)]",
      };
    case "D":
      return {
        label: "D",
        title: "Deleted",
        className:
          "bg-[color:var(--color-danger)]/18 text-[color:var(--color-danger)]",
      };
    case "R":
      return {
        label: "R",
        title: "Renamed",
        className:
          "bg-[color:var(--color-accent-deep)]/18 text-[color:var(--color-accent-deep)]",
      };
    case "C":
      return {
        label: "C",
        title: "Copied",
        className:
          "bg-[color:var(--color-accent-deep)]/18 text-[color:var(--color-accent-deep)]",
      };
    case "T":
      return {
        label: "T",
        title: "Type changed",
        className:
          "bg-[color:var(--color-warn)]/18 text-[color:var(--color-warn)]",
      };
    default:
      return {
        label: "·",
        title: "Unchanged",
        className:
          "bg-[color:var(--color-fg-faint)]/12 text-[color:var(--color-fg-faint)]",
      };
  }
}

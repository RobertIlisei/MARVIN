"use client";

/**
 * Tab strip at the top of the left column.
 *
 * Swaps the body between the Files tab (`<FileTree>`) and the Source
 * Control tab (`<SourceControlPanel>`). Persists the active tab in
 * `localStorage.marvin.leftColumn` so reloads land the user back on
 * the same view.
 *
 * Intentionally a dumb tab switcher — no focus management beyond
 * normal button focus. VSCode-style icon rail was considered and
 * rejected during plan review: MARVIN's left column is narrow, and a
 * rail eats real estate without adding value at this tab count.
 */

import { useEffect, useState } from "react";

export type LeftColumnTab = "files" | "source-control";

const STORAGE_KEY = "marvin.leftColumn";

function readStoredTab(): LeftColumnTab {
  if (typeof window === "undefined") return "files";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "files" || raw === "source-control") return raw;
  } catch {
    /* localStorage might be unavailable (private mode, Tauri quirks) */
  }
  return "files";
}

export function useLeftColumnTab(): [LeftColumnTab, (t: LeftColumnTab) => void] {
  const [tab, setTab] = useState<LeftColumnTab>("files");
  useEffect(() => {
    setTab(readStoredTab());
  }, []);
  const update = (next: LeftColumnTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };
  return [tab, update];
}

export function LeftColumnTabs({
  tab,
  onTabChange,
  badgeCount,
}: {
  tab: LeftColumnTab;
  onTabChange(next: LeftColumnTab): void;
  /** Number shown as a dot next to "source control" when > 0. */
  badgeCount?: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="left column"
      className="flex items-stretch border-b border-[color:var(--color-border)]"
    >
      <TabButton
        label="files"
        active={tab === "files"}
        onClick={() => onTabChange("files")}
      />
      <TabButton
        label="source control"
        active={tab === "source-control"}
        onClick={() => onTabChange("source-control")}
        badgeCount={badgeCount}
      />
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  badgeCount,
}: {
  label: string;
  active: boolean;
  onClick(): void;
  badgeCount?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.24em] transition ${
        active
          ? "text-[color:var(--color-fg)] bg-[color:var(--color-bg-elev)]/50 border-b-[1.5px] border-[color:var(--color-accent-deep)]"
          : "text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg-dim)]"
      }`}
    >
      <span>{label}</span>
      {typeof badgeCount === "number" && badgeCount > 0 && (
        <span
          className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-[color:var(--color-accent-deep)]/22 px-1 py-[1px] font-sans text-[9.5px] font-medium tracking-normal text-[color:var(--color-accent-deep)]"
          title={`${badgeCount} change${badgeCount === 1 ? "" : "s"}`}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
    </button>
  );
}

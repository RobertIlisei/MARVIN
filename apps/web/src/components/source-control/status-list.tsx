"use client";

/**
 * Grouped file-status list for the Source Control panel.
 *
 * Three buckets plus a Conflicts top section:
 *   - Conflicts — merge-conflicted; no inline actions (resolve in the
 *     editor or via chat).
 *   - Staged — index carries a change; actions: Unstage.
 *   - Changes — working-tree edits; actions: Stage, Discard.
 *   - Untracked — never-seen-before files; action: Stage.
 *
 * Action icons hover-reveal to keep rows calm when you're not
 * targeting them. Click a row → `onSelect(absolutePath)`; click an
 * action → the corresponding mutation fires.
 */

import type { StatusFile } from "@marvin/git";

import { StatusBadge } from "./status-badge";

interface Actions {
  stage(paths: string[]): Promise<boolean>;
  unstage(paths: string[]): Promise<boolean>;
  discard(paths: string[], mode: "working" | "staged"): Promise<boolean>;
}

interface StatusListProps {
  files: readonly StatusFile[];
  cwd: string;
  selectedPath: string | null;
  onSelect(absolutePath: string): void;
  actions: Actions;
  busy: boolean;
}

interface Bucket {
  key: "conflicts" | "staged" | "changes" | "untracked";
  label: string;
  files: StatusFile[];
}

export function StatusList({
  files,
  cwd,
  selectedPath,
  onSelect,
  actions,
  busy,
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
          <BucketSection
            key={bucket.key}
            bucket={bucket}
            cwd={cwd}
            selectedPath={selectedPath}
            onSelect={onSelect}
            actions={actions}
            busy={busy}
          />
        );
      })}
    </div>
  );
}

function BucketSection({
  bucket,
  cwd,
  selectedPath,
  onSelect,
  actions,
  busy,
}: {
  bucket: Bucket;
  cwd: string;
  selectedPath: string | null;
  onSelect(absolutePath: string): void;
  actions: Actions;
  busy: boolean;
}) {
  // Bulk action for the bucket header (Stage all / Unstage all).
  const bulkAction = bulkActionFor(bucket);
  const allPaths = bucket.files.map((f) => f.path);
  return (
    <section className="flex flex-col">
      <header className="group flex items-baseline justify-between px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
        <span>{bucket.label}</span>
        <div className="flex items-baseline gap-2">
          {bulkAction && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulkAction.run(actions, allPaths)}
              className="hidden font-sans text-[10px] tracking-normal text-[color:var(--color-fg-dim)] transition group-hover:inline hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
              title={bulkAction.label}
            >
              {bulkAction.glyph}
            </button>
          )}
          <span className="font-sans text-[10.5px] tracking-normal text-[color:var(--color-fg-faint)]">
            {bucket.files.length}
          </span>
        </div>
      </header>
      <ul className="flex flex-col">
        {bucket.files.map((file) => (
          <FileRow
            key={`${bucket.key}:${file.path}`}
            file={file}
            bucket={bucket.key}
            cwd={cwd}
            selectedPath={selectedPath}
            onSelect={onSelect}
            actions={actions}
            busy={busy}
          />
        ))}
      </ul>
    </section>
  );
}

function FileRow({
  file,
  bucket,
  cwd,
  selectedPath,
  onSelect,
  actions,
  busy,
}: {
  file: StatusFile;
  bucket: Bucket["key"];
  cwd: string;
  selectedPath: string | null;
  onSelect(absolutePath: string): void;
  actions: Actions;
  busy: boolean;
}) {
  const absolutePath = joinPath(cwd, file.path);
  const isSelected = selectedPath === absolutePath;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(absolutePath)}
        className={`flex w-full items-center gap-2 px-3 py-[5px] pr-14 text-left font-mono text-[11.5px] transition ${
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
              <span className="px-1 text-[color:var(--color-fg-faint)]">→</span>
            </>
          ) : null}
          {file.path}
        </span>
      </button>
      <RowActions
        bucket={bucket}
        path={file.path}
        actions={actions}
        busy={busy}
      />
    </li>
  );
}

function RowActions({
  bucket,
  path,
  actions,
  busy,
}: {
  bucket: Bucket["key"];
  path: string;
  actions: Actions;
  busy: boolean;
}) {
  if (bucket === "conflicts") return null;
  const items = rowActionsFor(bucket);
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-2 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void item.run(actions, [path]);
          }}
          title={item.title}
          className="rounded-[3px] px-1 py-0.5 text-[12px] leading-none text-[color:var(--color-fg-dim)] transition hover:bg-[color:var(--color-bg-elev)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {item.glyph}
        </button>
      ))}
    </div>
  );
}

function rowActionsFor(bucket: Bucket["key"]): Array<{
  key: string;
  title: string;
  glyph: string;
  run(a: Actions, paths: string[]): Promise<boolean>;
}> {
  switch (bucket) {
    case "staged":
      return [
        {
          key: "unstage",
          title: "unstage",
          glyph: "−",
          run: (a, paths) => a.unstage(paths),
        },
      ];
    case "changes":
      return [
        {
          key: "discard",
          title: "discard working-tree changes",
          glyph: "↺",
          run: (a, paths) => a.discard(paths, "working"),
        },
        {
          key: "stage",
          title: "stage",
          glyph: "+",
          run: (a, paths) => a.stage(paths),
        },
      ];
    case "untracked":
      return [
        {
          key: "stage",
          title: "stage (add)",
          glyph: "+",
          run: (a, paths) => a.stage(paths),
        },
      ];
    default:
      return [];
  }
}

function bulkActionFor(bucket: Bucket): {
  label: string;
  glyph: string;
  run(a: Actions, paths: string[]): Promise<boolean>;
} | null {
  switch (bucket.key) {
    case "staged":
      return {
        label: "unstage all",
        glyph: "unstage all",
        run: (a, paths) => a.unstage(paths),
      };
    case "changes":
      return {
        label: "stage all",
        glyph: "stage all",
        run: (a, paths) => a.stage(paths),
      };
    case "untracked":
      return {
        label: "stage all",
        glyph: "stage all",
        run: (a, paths) => a.stage(paths),
      };
    default:
      return null;
  }
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
    if (f.entryType === "ignored") continue;
    const stagedSide = f.indexStatus !== ".";
    const unstagedSide = f.workingStatus !== ".";
    if (stagedSide) staged.push(f);
    if (unstagedSide) changes.push(f);
  }
  return [
    { key: "conflicts", label: "Conflicts", files: conflicts },
    { key: "staged", label: "Staged", files: staged },
    { key: "changes", label: "Changes", files: changes },
    { key: "untracked", label: "Untracked", files: untracked },
  ];
}

function joinPath(cwd: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return `${cwd.replace(/\/+$/, "")}/${rel}`;
}

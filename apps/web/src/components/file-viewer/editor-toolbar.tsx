"use client";

/**
 * Toolbar for the single-file Monaco editor. Shows:
 *  - Path relative to cwd + dirty dot
 *  - Language / line count / size metadata (moved from the previous
 *    file-viewer header so the editor owns the full chrome)
 *  - Save button (disabled while not dirty)
 *  - Close button
 *
 * A secondary banner row slides in below when the server returns
 * `409 stale` on save — caller passes a `conflict` with the on-disk
 * mtime and two resolution callbacks (reload / overwrite).
 */

export interface EditorConflict {
  currentMtime: number;
  size: number;
  onReload(): void;
  onOverwrite(): void;
}

export function EditorToolbar({
  relPath,
  language,
  lineCount,
  size,
  isDirty,
  saving,
  onSave,
  onClose,
  conflict,
}: {
  relPath: string;
  language: string;
  lineCount: number;
  size: number;
  isDirty: boolean;
  saving: boolean;
  onSave(): void;
  onClose(): void;
  conflict: EditorConflict | null;
}) {
  const segments = relPath.split("/").filter(Boolean);
  return (
    <>
      <div className="flex items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[11px]">
        <span className="text-[color:var(--color-fg-faint)]">file</span>
        <nav
          aria-label="path breadcrumb"
          className="flex min-w-0 items-center gap-1 truncate text-[color:var(--color-fg)]"
        >
          {segments.map((seg, i) => {
            const last = i === segments.length - 1;
            return (
              <span key={`${seg}-${i}`} className="flex shrink-0 items-center gap-1">
                <span
                  className={
                    last
                      ? "truncate text-[color:var(--color-fg)]"
                      : "truncate text-[color:var(--color-fg-dim)]"
                  }
                >
                  {seg}
                </span>
                {!last && (
                  <span
                    aria-hidden
                    className="text-[color:var(--color-fg-faint)]"
                  >
                    /
                  </span>
                )}
              </span>
            );
          })}
        </nav>
        {isDirty && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]"
            aria-label="unsaved changes"
            title="unsaved changes"
          />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-[color:var(--color-fg-faint)]">
          <span>{language}</span>
          <span>·</span>
          <span>{lineCount} lines</span>
          <span>·</span>
          <span>{fmtBytes(size)}</span>
          <button
            type="button"
            onClick={onSave}
            disabled={!isDirty || saving}
            className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-dim)] transition enabled:hover:border-[color:var(--color-accent)] enabled:hover:text-[color:var(--color-fg)] disabled:opacity-40"
            aria-label="save"
            title="save (⌘S)"
          >
            {saving ? "saving…" : "save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
            aria-label="close file"
          >
            close ✕
          </button>
        </span>
      </div>
      {conflict && (
        <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-warn)]/10 px-3 py-2 text-[11px] text-[color:var(--color-warn)]">
          <span>
            file changed on disk — your edits are not yet saved.
            reload to discard them, or overwrite to replace the on-disk version.
          </span>
          <button
            type="button"
            onClick={conflict.onReload}
            className="ml-auto rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[color:var(--color-fg-dim)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            reload
          </button>
          <button
            type="button"
            onClick={conflict.onOverwrite}
            className="rounded border border-[color:var(--color-danger)]/50 bg-[color:var(--color-danger)]/10 px-1.5 py-0.5 text-[color:var(--color-danger)] hover:border-[color:var(--color-danger)] hover:text-[color:var(--color-danger)]"
          >
            overwrite
          </button>
        </div>
      )}
    </>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

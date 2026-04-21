"use client";

import { useEffect, useState } from "react";

import { MonacoEditor } from "./monaco-editor";
import { UnsavedGuard, type UnsavedGuardState } from "./unsaved-guard";
import { useDirtyState } from "./use-dirty-state";

type ContentResponse = {
  path: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
  maxSize?: number;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileViewer({
  cwd,
  filePath,
  onClose,
}: {
  cwd: string;
  filePath: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ContentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dirty = useDirtyState();
  const [guard, setGuard] = useState<UnsavedGuardState>({
    open: false,
    filePath: "",
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(
      `/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? r.statusText);
        }
        return (await r.json()) as ContentResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, filePath]);

  const relPath = filePath.startsWith(cwd)
    ? filePath.slice(cwd.length).replace(/^\/+/, "")
    : filePath;

  const handleClose = async () => {
    if (dirty.isDirty) {
      const choice = await new Promise<"save" | "discard" | "cancel">(
        (resolve) => {
          setGuard({
            open: true,
            filePath: relPath,
            onResolve: resolve,
          });
        },
      );
      setGuard((g) => ({ ...g, open: false }));
      if (choice === "cancel") return;
      if (choice === "save") {
        // The editor owns the content; we can't trigger save from here
        // without lifting state. Simplest: ask the user to Cmd-S first
        // via a visual cue and don't close. A future refactor can expose
        // an imperative save() handle.
        return;
      }
      // discard: proceed
      dirty.markClean();
    }
    onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {loading && !data && (
        <div className="p-4 text-xs text-[color:var(--color-fg-dim)]">
          reading file…
        </div>
      )}
      {error && (
        <div className="p-4 text-xs text-[color:var(--color-danger)]/80">
          {error}
        </div>
      )}
      {data?.binary && (
        <ReadOnlyPanel
          cwd={cwd}
          filePath={filePath}
          data={data}
          relPath={relPath}
          onClose={handleClose}
        />
      )}
      {data && !data.binary && data.content != null && (
        <MonacoEditor
          // key forces a fresh mount when the file changes — simpler than
          // plumbing a reload through internal state.
          key={filePath}
          cwd={cwd}
          filePath={filePath}
          initialContent={data.content}
          initialMtime={data.mtime}
          initialSize={data.size}
          readOnly={data.truncated}
          notice={
            data.truncated
              ? `file is ${fmtBytes(data.size)} — showing first ${fmtBytes(data.maxSize ?? 0)}, read-only to prevent truncation on save.`
              : null
          }
          onDirtyChange={(d) => {
            if (d) dirty.markDirty();
            else dirty.markClean();
          }}
          onClose={handleClose}
          onError={(e) => setError(e)}
        />
      )}
      {data && !data.binary && data.content == null && (
        <ReadOnlyPanel
          cwd={cwd}
          filePath={filePath}
          data={data}
          relPath={relPath}
          onClose={handleClose}
        />
      )}
      <UnsavedGuard
        state={guard}
        onResolve={(c) => guard.onResolve?.(c)}
      />
    </div>
  );
}

const PREVIEWABLE_BINARY = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|heic|pdf)$/i;

function ReadOnlyPanel({
  cwd,
  filePath,
  data,
  relPath,
  onClose,
}: {
  cwd: string;
  filePath: string;
  data: ContentResponse;
  relPath: string;
  onClose(): void;
}) {
  const canPreview = data.binary && PREVIEWABLE_BINARY.test(filePath);
  const isPdf = /\.pdf$/i.test(filePath);
  const rawUrl = `/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/40">
      <div className="flex items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[11px]">
        <span className="text-[color:var(--color-fg-faint)]">file</span>
        <span className="truncate text-[color:var(--color-fg)]">{relPath}</span>
        <span className="ml-auto flex items-center gap-3 text-[color:var(--color-fg-faint)]">
          {data.binary && <span>binary · {fmtBytes(data.size)}</span>}
          {data.truncated && (
            <span>
              truncated · {fmtBytes(data.size)} (cap {fmtBytes(data.maxSize ?? 0)})
            </span>
          )}
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
      <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
        {canPreview ? (
          isPdf ? (
            <iframe
              src={rawUrl}
              title={relPath}
              // PDFs paint their own page background; keeping the wrapper
              // transparent avoids a white stripe flashing in dark mode
              // while the viewer mounts.
              className="h-full w-full rounded border border-[color:var(--color-border)] bg-transparent"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={rawUrl}
                alt={relPath}
                className="max-h-full max-w-full rounded border border-[color:var(--color-border)] object-contain"
              />
            </div>
          )
        ) : data.binary ? (
          <div className="text-xs text-[color:var(--color-fg-dim)]">
            binary file — preview not available for this type. Reveal in
            Finder or open externally.
          </div>
        ) : null}
        {data.truncated && !canPreview && (
          <div className="mt-2 text-xs text-[color:var(--color-fg-dim)]">
            file is larger than {fmtBytes(data.maxSize ?? 0)} — not loaded.
            MARVIN&apos;s editor refuses to open truncated files to avoid
            silent data loss on save.
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

/**
 * Accept OS → tree drops (Finder, desktop, downloads folder, etc.).
 * Shares the drop surface with within-tree DnD (`use-tree-dnd.ts`) —
 * the two are discriminated by `dataTransfer.types`:
 *
 *   - within-tree move carries `application/x-marvin-paths`
 *   - OS drop carries `Files` (DataTransferItem `kind === "file"`)
 *
 * When both types are present on a single drop (possible in theory),
 * within-tree semantics win — the MIME check in `use-tree-dnd` fires
 * first and `preventDefault`s.
 *
 * Calls `/api/files/write/upload` with the `X-Marvin-Client: 1` header
 * that forces a CORS preflight; cross-origin drive-by posts can't
 * replay this because the preflight won't be answered
 * (`Access-Control-Allow-Headers` never names it).
 */

import { useCallback, useState } from "react";
import { marvinFetch } from "@/lib/csrf";

export interface UploadOutcome {
  uploaded: Array<{ name: string; path: string; bytes: number }>;
  skipped: Array<{ name: string; reason: string }>;
  destDir: string;
}

export interface UseOsDropOptions {
  cwd: string;
  /** Called on every successful (even partial) upload so the tree re-fetches. */
  onComplete(result: UploadOutcome): void;
  /** Called on a hard error (preflight rejection, network failure). */
  onError?(message: string): void;
}

export interface UseOsDrop {
  /** `true` while a drag containing OS files is hovering. */
  osDragHover: boolean;
  /** `true` while an upload request is in flight. */
  uploading: boolean;
  /** Spread on a directory row (or the tree root) to accept OS drops. */
  osDropProps(params: { destDir: string }): {
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

function hasOsFiles(dt: DataTransfer): boolean {
  // "Files" is the canonical type browsers set when the drag carries
  // OS files, regardless of MIME.
  return Array.from(dt.types).includes("Files");
}

function hasMarvinPaths(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes("application/x-marvin-paths");
}

export function useOsDrop(opts: UseOsDropOptions): UseOsDrop {
  const [osDragHover, setOsDragHover] = useState(false);
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(
    async (destDir: string, files: File[]) => {
      if (files.length === 0) return;
      const form = new FormData();
      form.append("cwd", opts.cwd);
      form.append("destDir", destDir);
      for (const f of files) form.append("file", f);
      setUploading(true);
      try {
        const res = await marvinFetch("/api/files/write/upload", {
          method: "POST",
          headers: { "X-Marvin-Client": "1" },
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          uploaded?: UploadOutcome["uploaded"];
          skipped?: UploadOutcome["skipped"];
          destDir?: string;
          error?: string;
        };
        if (!res.ok) {
          opts.onError?.(body.error ?? `upload failed (${res.status})`);
          return;
        }
        opts.onComplete({
          uploaded: body.uploaded ?? [],
          skipped: body.skipped ?? [],
          destDir: body.destDir ?? destDir,
        });
      } catch (e) {
        opts.onError?.(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [opts],
  );

  const osDropProps = useCallback<UseOsDrop["osDropProps"]>(
    ({ destDir }) => ({
      onDragOver: (e) => {
        if (!hasOsFiles(e.dataTransfer)) return;
        if (hasMarvinPaths(e.dataTransfer)) return; // within-tree wins
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragEnter: (e) => {
        if (!hasOsFiles(e.dataTransfer)) return;
        if (hasMarvinPaths(e.dataTransfer)) return;
        setOsDragHover(true);
      },
      onDragLeave: (e) => {
        if (e.currentTarget === e.target) setOsDragHover(false);
      },
      onDrop: async (e) => {
        if (!hasOsFiles(e.dataTransfer)) return;
        if (hasMarvinPaths(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setOsDragHover(false);
        const files = Array.from(e.dataTransfer.files);
        await upload(destDir, files);
      },
    }),
    [upload],
  );

  return { osDragHover, uploading, osDropProps };
}

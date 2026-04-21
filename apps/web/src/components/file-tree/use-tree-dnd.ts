"use client";

/**
 * Within-tree drag-and-drop for the file tree.
 *
 * Uses native HTML5 DnD — no @dnd-kit dependency. The drag source sets a
 * `application/x-marvin-paths` payload (JSON array of absolute paths).
 * Drop targets that are directories accept the drop if the source payload
 * is present; otherwise they ignore it (so M5's OS → tree drop can key
 * off the same handlers without colliding).
 *
 * Drop semantics: the source paths are moved into the destination
 * directory. If any destination already exists, the server returns
 * `409 collisions` and the caller's `onError` surfaces a toast; nothing
 * on disk has changed.
 */

import { useCallback, useState } from "react";

const MARVIN_PATHS_MIME = "application/x-marvin-paths";

export interface UseTreeDndOptions {
  /** Called when a within-tree drop succeeds. */
  onMove(params: { from: string[]; to: string }): Promise<void> | void;
}

export interface UseTreeDnd {
  /** Path currently under the cursor while dragging (for hover highlight). */
  dropTarget: string | null;
  /** Spread on the draggable element (file or dir row). */
  dragProps(params: { path: string; selected: ReadonlySet<string> }): {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
  /** Spread on a directory row to accept drops. */
  dropProps(params: { path: string }): {
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useTreeDnd(opts: UseTreeDndOptions): UseTreeDnd {
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const dragProps = useCallback<UseTreeDnd["dragProps"]>(
    ({ path, selected }) => ({
      draggable: true,
      onDragStart: (e) => {
        // If the drag source is part of the selection, carry all of them.
        // If it isn't, carry just the source path.
        const payload = selected.has(path)
          ? Array.from(selected)
          : [path];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MARVIN_PATHS_MIME, JSON.stringify(payload));
        // Human-readable fallback so drops into other apps show a sensible name.
        e.dataTransfer.setData(
          "text/plain",
          payload.map((p) => p.split("/").pop()).join("\n"),
        );
      },
      onDragEnd: () => {
        setDropTarget(null);
      },
    }),
    [],
  );

  const dropProps = useCallback<UseTreeDnd["dropProps"]>(
    ({ path }) => ({
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(MARVIN_PATHS_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDragEnter: (e) => {
        if (!e.dataTransfer.types.includes(MARVIN_PATHS_MIME)) return;
        setDropTarget(path);
      },
      onDragLeave: (e) => {
        // Only clear if we really left this element (not one of its
        // children — dragleave fires when entering a child because of
        // event bubbling).
        if (e.currentTarget === e.target) {
          setDropTarget((cur) => (cur === path ? null : cur));
        }
      },
      onDrop: async (e) => {
        const raw = e.dataTransfer.getData(MARVIN_PATHS_MIME);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        let from: string[];
        try {
          from = JSON.parse(raw) as string[];
        } catch {
          return;
        }
        if (from.length === 0) return;
        if (from.includes(path)) return; // no-op self-drop
        // A directory-into-its-own-child drop is caught by the server
        // (the source realpath contains the target), but we can avoid the
        // round-trip with a cheap prefix check.
        if (from.some((src) => path === src || path.startsWith(src + "/"))) {
          return;
        }
        await opts.onMove({ from, to: path });
      },
    }),
    [opts],
  );

  return { dropTarget, dragProps, dropProps };
}

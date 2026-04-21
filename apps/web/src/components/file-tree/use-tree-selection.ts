"use client";

/**
 * Multi-select state for the file tree.
 *
 * Gestures:
 *   - Plain click      → single-select (replace)
 *   - Cmd/Ctrl-click   → toggle in-set
 *   - Shift-click      → range from lastAnchor through the clicked node
 *
 * The set holds absolute paths. The hook is order-preserving — the
 * insertion order of the underlying Map is what iteration returns. Shift-
 * range uses a caller-supplied `flatten()` that produces the visible
 * linear order of the tree so range arithmetic is unambiguous when
 * nodes are collapsed.
 */

import { useCallback, useMemo, useState } from "react";

export interface UseTreeSelectionOptions {
  /** Absolute paths of every visible node, in display order. */
  visibleOrder: string[];
}

export interface UseTreeSelection {
  /** Absolute paths of currently-selected nodes. */
  selected: ReadonlySet<string>;
  /** Last single-select / range-anchor path. */
  anchor: string | null;
  isSelected(path: string): boolean;
  /** Apply a click gesture. Derives the correct next-state from modifier keys. */
  onItemClick(path: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void;
  /** Replace the selection entirely — useful after rename/move. */
  replace(paths: string[]): void;
  clear(): void;
}

export function useTreeSelection(
  opts: UseTreeSelectionOptions,
): UseTreeSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [anchor, setAnchor] = useState<string | null>(null);

  // Snapshot the visibleOrder so callbacks don't stale-capture.
  const orderRef = useMemo(() => opts.visibleOrder, [opts.visibleOrder]);

  const isSelected = useCallback(
    (path: string) => selected.has(path),
    [selected],
  );

  const onItemClick = useCallback<UseTreeSelection["onItemClick"]>(
    (path, e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.shiftKey && anchor) {
        const start = orderRef.indexOf(anchor);
        const end = orderRef.indexOf(path);
        if (start === -1 || end === -1) {
          setSelected(new Set([path]));
          setAnchor(path);
          return;
        }
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        const next = new Set(orderRef.slice(lo, hi + 1));
        setSelected(next);
        return;
      }
      if (mod) {
        const next = new Set(selected);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        setSelected(next);
        setAnchor(path);
        return;
      }
      setSelected(new Set([path]));
      setAnchor(path);
    },
    [anchor, orderRef, selected],
  );

  const replace = useCallback<UseTreeSelection["replace"]>((paths) => {
    setSelected(new Set(paths));
    setAnchor(paths[paths.length - 1] ?? null);
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  return { selected, anchor, isSelected, onItemClick, replace, clear };
}

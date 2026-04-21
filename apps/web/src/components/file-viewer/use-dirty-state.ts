"use client";

/**
 * Track whether the editor has unsaved changes, and guard the browser's
 * own navigation (tab close / reload / back / forward) while the flag
 * is set.
 *
 * In-app navigation guards (switching between files, switching projects)
 * should call `guardOrConfirm()` themselves — the browser-level
 * `beforeunload` listener can't intercept in-app state transitions.
 *
 * This hook is deliberately minimal — no modal rendering, no
 * persistence. The caller composes it with `unsaved-guard.tsx` for the
 * in-app Save/Discard/Cancel dialog.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseDirtyState {
  isDirty: boolean;
  markDirty(): void;
  markClean(): void;
  /**
   * If the editor is dirty, prompt via `confirmFn` ("save / discard /
   * cancel"). Returns `true` if navigation should proceed (discard or
   * explicit save-then-continue), `false` to cancel.
   */
  guardOrConfirm(
    confirmFn: () => Promise<"save" | "discard" | "cancel">,
    onSave?: () => Promise<boolean>,
  ): Promise<boolean>;
}

export function useDirtyState(): UseDirtyState {
  const [isDirty, setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = isDirty;

  const markDirty = useCallback(() => setIsDirty(true), []);
  const markClean = useCallback(() => setIsDirty(false), []);

  // Browser-level guard: blocks tab close / reload / back / forward with
  // the browser's own "Changes you made may not be saved" dialog. We
  // can't show our modal here — `beforeunload` is synchronous by design.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      // Modern browsers ignore the custom message (security), but
      // returnValue must be set to trigger the dialog.
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const guardOrConfirm = useCallback<UseDirtyState["guardOrConfirm"]>(
    async (confirmFn, onSave) => {
      if (!dirtyRef.current) return true;
      const decision = await confirmFn();
      if (decision === "cancel") return false;
      if (decision === "discard") {
        setIsDirty(false);
        return true;
      }
      // save: delegate to caller; if save succeeds, mark clean and proceed.
      if (!onSave) return false;
      const saved = await onSave();
      if (saved) {
        setIsDirty(false);
        return true;
      }
      return false;
    },
    [],
  );

  return { isDirty, markDirty, markClean, guardOrConfirm };
}

"use client";

/**
 * Three-choice dialog rendered when a navigation / file-switch / project-
 * switch is attempted while the editor has unsaved changes.
 *
 * Save → caller attempts to persist, then navigates if save succeeds.
 * Discard → caller drops the pending changes and navigates.
 * Cancel → no-op, user stays on the current file.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";
import { Button } from "@marvin/ui/button";

export interface UnsavedGuardState {
  open: boolean;
  filePath: string;
  onResolve?: (choice: "save" | "discard" | "cancel") => void;
}

export function UnsavedGuard({
  state,
  onResolve,
}: {
  state: UnsavedGuardState;
  onResolve(choice: "save" | "discard" | "cancel"): void;
}) {
  return (
    <Dialog
      open={state.open}
      onOpenChange={(o) => {
        if (!o) onResolve("cancel");
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            <span className="block font-mono text-xs text-[color:var(--color-fg-dim)]">
              {state.filePath}
            </span>
            <span className="mt-2 block text-sm">
              Save before switching away, or discard the pending changes?
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onResolve("cancel")}>
            Cancel
          </Button>
          <Button
            variant="ghost"
            onClick={() => onResolve("discard")}
            className="text-[color:var(--color-fg-dim)]"
          >
            Discard
          </Button>
          <Button onClick={() => onResolve("save")}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

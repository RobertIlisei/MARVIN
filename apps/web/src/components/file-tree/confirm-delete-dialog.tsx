"use client";

/**
 * Shared confirm dialog for destructive operations the user-initiated
 * write channel classifies as `confirm`. Used by the file tree for
 * permanent-delete, secret-file writes, and case-only rename prompts.
 *
 * Visual severity ("warn" vs "danger") drives the colour of the confirm
 * button and the icon.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvin/ui/alert-dialog";

export interface ConfirmDeleteDialogState {
  open: boolean;
  reason: string;
  severity: "warn" | "danger";
  summary: string;
}

export function ConfirmDeleteDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: ConfirmDeleteDialogState;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <AlertDialog
      open={state.open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {state.severity === "danger" ? "This is irreversible" : "Are you sure?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block font-mono text-xs text-[color:var(--color-fg-dim)]">
              {state.summary}
            </span>
            <span className="mt-2 block text-sm">{state.reason}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              state.severity === "danger"
                ? "bg-[color:var(--color-danger,#c62828)] text-white hover:bg-[color:var(--color-danger,#c62828)]/90"
                : ""
            }
          >
            {state.severity === "danger" ? "Delete" : "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

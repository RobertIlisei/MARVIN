"use client";

/**
 * Modal rendered when a mutation triggered a `needs-confirm` response.
 *
 * Severity drives styling:
 *   - `warn`  — neutral modal, accent button.
 *   - `danger` — red border + primary button styled as destructive.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
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

import type { PendingConfirm } from "./use-git-mutations";

export function ConfirmGitOpDialog({
  pending,
}: {
  pending: PendingConfirm | null;
}) {
  const open = pending !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) pending.reject();
      }}
    >
      <AlertDialogContent
        className={
          pending?.severity === "danger"
            ? "border-[color:var(--color-danger)]/60"
            : undefined
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending?.title ?? "Confirm git operation"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block pb-2 text-[13px] leading-relaxed text-[color:var(--color-fg-dim)]">
              {pending?.reason}
            </span>
            {pending?.severity === "danger" && (
              <span className="block text-[11.5px] font-medium uppercase tracking-[0.18em] text-[color:var(--color-danger)]">
                Destructive — not reversible without git reflog.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => pending?.reject()}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => pending?.accept()}
            className={
              pending?.severity === "danger"
                ? "bg-[color:var(--color-danger)] text-white hover:bg-[color:var(--color-danger)]/85"
                : undefined
            }
          >
            {pending?.severity === "danger" ? "Proceed anyway" : "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

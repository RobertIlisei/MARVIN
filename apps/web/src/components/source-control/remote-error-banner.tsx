"use client";

/**
 * Specialised banner for remote-op failures (push / pull / fetch).
 *
 * Replaces the generic error banner when the most recent mutation
 * error is a classified remote-network error: we know what to tell
 * the user and how to fix it. The raw stderr is kept collapsed
 * behind a "show details" affordance for the occasional weird
 * failure.
 *
 * See [ADR-0013](../../../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import { useState } from "react";

export interface RemoteErrorBannerProps {
  code: string;
  /** One-line remedy text returned by the server. */
  remedy: string;
  /** Raw stderr from git, preserved for the "show details" toggle. */
  stderr: string | null;
  onDismiss(): void;
}

const CODE_TITLES: Record<string, string> = {
  "auth-publickey": "SSH key rejected",
  "auth-failed": "Authentication failed",
  network: "Network error",
  "non-fast-forward": "Non-fast-forward — pull first",
  "no-upstream": "No upstream configured",
  "no-remote": "Remote not reachable",
  "merge-conflict": "Merge conflict",
  "dirty-working-tree": "Working tree is dirty",
  "detached-head": "Detached HEAD",
  "git-failed": "Git returned an error",
};

export function RemoteErrorBanner({
  code,
  remedy,
  stderr,
  onDismiss,
}: RemoteErrorBannerProps) {
  const [open, setOpen] = useState(false);
  const title = CODE_TITLES[code] ?? code;
  return (
    <div className="border-t border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-danger)]">
            {title}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--color-fg-dim)]">
            {remedy}
          </p>
          {stderr && (
            <>
              <button
                type="button"
                onClick={() => setOpen((p) => !p)}
                className="mt-1 font-mono text-[10px] tracking-normal text-[color:var(--color-fg-faint)] underline-offset-2 hover:text-[color:var(--color-fg-dim)] hover:underline"
              >
                {open ? "hide" : "show"} stderr
              </button>
              {open && (
                <pre className="scroll-thin mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 p-2 font-mono text-[10.5px] text-[color:var(--color-fg-dim)]">
                  {stderr}
                </pre>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded px-1 text-[13px] leading-none text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/20"
          aria-label="dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

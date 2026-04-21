"use client";

/**
 * Floating toast summarising the outcome of an OS → tree upload.
 *
 * Shows the uploaded file list on success; any `skipped` entries get a
 * secondary block with the reason (deny-listed, oversize, needs-confirm,
 * io error). Auto-dismisses after 6 s unless the user hovers it.
 */

import { useEffect, useState } from "react";

import type { UploadOutcome } from "./use-os-drop";

export interface UploadToastState {
  result: UploadOutcome | null;
  error: string | null;
  uploading: boolean;
}

export function UploadProgressToast({
  state,
  onDismiss,
}: {
  state: UploadToastState;
  onDismiss(): void;
}) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (hovered) return;
    if (!state.result && !state.error) return;
    const id = setTimeout(onDismiss, 6000);
    return () => clearTimeout(id);
  }, [hovered, state.result, state.error, onDismiss]);

  if (state.uploading) {
    return (
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] px-3 py-2 font-mono text-[11px] text-[color:var(--color-fg-dim)] shadow-lg">
        uploading…
      </div>
    );
  }
  if (state.error) {
    return (
      <div
        className="fixed bottom-6 right-6 z-50 max-w-sm rounded-md border border-[color:var(--color-danger)]/50 bg-[color:var(--color-danger)]/10 px-3 py-2 font-mono text-[11px] text-[color:var(--color-danger)] shadow-lg"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        upload failed — {state.error}
      </div>
    );
  }
  if (state.result) {
    const uploaded = state.result.uploaded.length;
    const skipped = state.result.skipped.length;
    return (
      <div
        className="fixed bottom-6 right-6 z-50 max-w-sm rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] px-3 py-2 font-mono text-[11px] text-[color:var(--color-fg)] shadow-lg"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="font-medium">
          uploaded {uploaded} file{uploaded === 1 ? "" : "s"}
          {skipped > 0 ? ` · skipped ${skipped}` : ""}
        </div>
        {skipped > 0 && (
          <ul className="mt-1 space-y-0.5 text-[color:var(--color-fg-dim)]">
            {state.result.skipped.slice(0, 5).map((s) => (
              <li key={s.name} className="truncate">
                <span className="text-[color:var(--color-warn)]">skipped</span>{" "}
                {s.name} — {s.reason}
              </li>
            ))}
            {state.result.skipped.length > 5 && (
              <li className="text-[color:var(--color-fg-faint)]">
                …and {state.result.skipped.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>
    );
  }
  return null;
}

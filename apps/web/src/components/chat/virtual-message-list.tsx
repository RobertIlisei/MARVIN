"use client";

import { useCallback, useEffect, useState } from "react";

import { MessageView } from "./message-view";
import type { Message } from "./types";

/**
 * Windowed message list — caps the number of mounted MessageView rows
 * at `windowSize` (default 200, newest-first window). Older rows are
 * available behind a "show earlier" button that grows the window by
 * `windowSize` each click.
 *
 * Audit finding #20: long sessions render 1:1 from page.tsx —
 * 500+ turns with `tool_use` cards (each holding a Monaco diff viewer
 * subtree) start dropping frames, even though MessageView is
 * `React.memo`'d. This component is the smallest fix that meets the
 * audit's stated concern: cap the mounted DOM count regardless of
 * session length.
 *
 * Why not `react-virtuoso`: the dependency wasn't in the lockfile
 * during the audit fix-pass and Cowork's sandbox can't run
 * `pnpm install`. The chunked-render approach has worse worst-case
 * behaviour than a true virtualiser (the user CAN scroll into a wall
 * of mounting if they click "show earlier" on a 5000-turn session),
 * but for the realistic message counts MARVIN sees in a single session
 * (10s to low 100s) this is plenty. If sessions ever get long enough
 * to feel laggy through this, swap in `react-virtuoso` — the API
 * surface here is intentionally narrow so the swap is contained.
 *
 * Sticky-bottom + "jump to latest" pill (audit #13) live in page.tsx;
 * this component just owns the window-size logic.
 */
export interface VirtualMessageListProps {
  messages: Message[];
  /** Initial render window — default 200. */
  windowSize?: number;
  /** Forwarded to each MessageView. */
  onDecideConfirm?: (
    toolUseId: string,
    decision: "allow" | "deny",
    message?: string,
  ) => Promise<void> | void;
  onRetry?: () => void;
}

export function VirtualMessageList({
  messages,
  windowSize = 200,
  onDecideConfirm,
  onRetry,
}: VirtualMessageListProps) {
  // The size of the "tail" of messages we currently render. Grows on
  // "show earlier" clicks. Reset whenever the user starts a fresh
  // conversation (messages array shrinks past the current window).
  const [windowEnd, setWindowEnd] = useState(windowSize);

  // Reset the window whenever the messages array shrinks below it —
  // signals a session reset / hydration / cleared chat.
  useEffect(() => {
    if (messages.length < windowEnd && messages.length < windowSize) {
      setWindowEnd(windowSize);
    }
  }, [messages.length, windowEnd, windowSize]);

  const totalCount = messages.length;
  const start = Math.max(0, totalCount - windowEnd);
  const visibleSlice = messages.slice(start);
  const hidden = start;

  const showEarlier = useCallback(() => {
    setWindowEnd((w) => w + windowSize);
  }, [windowSize]);

  return (
    <>
      {hidden > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={showEarlier}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            ↑ show {Math.min(hidden, windowSize)} earlier ({hidden} hidden)
          </button>
        </div>
      )}
      {visibleSlice.map((m) => (
        <MessageView
          key={m.id}
          message={m}
          {...(onDecideConfirm ? { onDecideConfirm } : {})}
          {...(onRetry ? { onRetry } : {})}
        />
      ))}
    </>
  );
}

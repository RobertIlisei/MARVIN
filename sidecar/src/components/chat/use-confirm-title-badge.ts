"use client";

import { useEffect } from "react";

import type { Message } from "./types";

/**
 * Prefix `document.title` with a `(N)` badge when N tool calls are
 * waiting on a confirm. The original title is restored when the count
 * drops to zero (and on unmount), so navigating to a different surface
 * doesn't leave the badge sticky.
 *
 * Why a hook and not a global SSE listener: the source of truth for
 * "is there a pending confirm right now" is the message list shaped by
 * `useChatStream` — that's what already consolidates `confirm.request`
 * SSE events into `block.pendingConfirm`. Re-deriving from the bus
 * would duplicate that logic.
 *
 * Browser-tab visibility is intentionally NOT a precondition. A user
 * who is on the MARVIN tab but scrolled past the confirm card still
 * benefits from the title cue; the cost is negligible (a short
 * write to `document.title` per messages-change). System
 * notifications, when added later, should gate on `document.hidden`.
 *
 * See [docs/reviews/2026-04-26-full-audit.md, finding #11].
 */
export function useConfirmTitleBadge(messages: Message[]): void {
  // Count `pendingConfirm` blocks. Walk every block — there can be
  // multiple in flight when the SDK queues several tool calls behind
  // a single confirm boundary (rare but possible).
  let pending = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.type === "tool_use" && b.pendingConfirm && !b.confirmDecision) {
        pending++;
      }
    }
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (pending <= 0) return;

    const original = document.title;
    // Strip any pre-existing `(N) ` badge we might have left, then add
    // the current count. `original` is captured at effect start so
    // restore-on-cleanup uses the unbadged title.
    const stripped = original.replace(/^\(\d+\)\s/, "").replace(/^\(!\)\s/, "");
    document.title = `(${pending}) ${stripped}`;

    return () => {
      // Only restore if no other code path has already retitled.
      // Compare against the value we just wrote — if it's been
      // overwritten in the meantime, leave it alone.
      if (document.title.startsWith(`(${pending}) `)) {
        document.title = original;
      }
    };
  }, [pending]);
}

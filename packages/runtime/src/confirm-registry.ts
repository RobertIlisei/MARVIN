/**
 * In-process confirm registry — maps (turnId, toolUseId) → resolver promise
 * so /api/confirm can satisfy a `canUseTool` callback that was registered
 * by an in-flight /api/chat turn.
 *
 * Lives in memory only; MARVIN's web app is single-process, so this is
 * sufficient. If we ever move to multi-process, swap for Redis keyed the
 * same way.
 *
 * The registry also remembers the ORIGINAL `toolInput` the SDK handed us.
 * The Agent SDK validates the returned `PermissionResult` with a zod schema
 * that requires `updatedInput: Record<string, unknown>` on every `allow`
 * reply. When the user simply clicks "allow" in the UI without editing the
 * input, the client POST omits `updatedInput` — we fall back to the stored
 * original instead of returning `undefined` and blowing up the turn.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

type Resolver = (result: PermissionResult) => void;

interface PendingEntry {
  resolver: Resolver;
  /** Original tool input the SDK passed to canUseTool — always a record. */
  originalInput: Record<string, unknown>;
  /** Optional auto-deny timer; cleared on resolve / clear. */
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, Map<string, PendingEntry>>();

/**
 * Default ceiling on how long a confirm can sit awaiting a user
 * response before MARVIN auto-denies. 5 minutes is the audit pick
 * (finding #5) — long enough to walk away to grab coffee, short
 * enough that a closed tab doesn't pin the SDK loop forever.
 *
 * Override via `MARVIN_CONFIRM_TIMEOUT_MS` (eg. tests pass `0` to
 * disable the timer). 0 / negative / NaN disables — useful for the
 * Vitest registry tests that need deterministic resolution order
 * without racing real timers.
 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = (() => {
  const env = process.env.MARVIN_CONFIRM_TIMEOUT_MS;
  if (env != null) {
    const n = Number(env);
    if (Number.isFinite(n)) return n;
  }
  return 5 * 60 * 1000;
})();

export function registerPendingConfirm(
  turnId: string,
  toolUseId: string,
  resolver: Resolver,
  originalInput: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_CONFIRM_TIMEOUT_MS,
): void {
  let bucket = registry.get(turnId);
  if (!bucket) {
    bucket = new Map();
    registry.set(turnId, bucket);
  }
  const entry: PendingEntry = { resolver, originalInput };
  bucket.set(toolUseId, entry);
  if (timeoutMs > 0) {
    // The resolved branch in resolvePendingConfirm clears this handle
    // before the resolver fires — so a late timer callback finds no
    // entry and is a no-op (the .get returns undefined).
    entry.timeoutHandle = setTimeout(() => {
      resolvePendingConfirm(turnId, toolUseId, {
        behavior: "deny",
        message: `Auto-denied — no user response within ${Math.round(timeoutMs / 1000)}s.`,
        interrupt: false,
      });
    }, timeoutMs);
  }
}

export function getPendingOriginalInput(
  turnId: string,
  toolUseId: string,
): Record<string, unknown> | null {
  const entry = registry.get(turnId)?.get(toolUseId);
  return entry ? entry.originalInput : null;
}

export function resolvePendingConfirm(
  turnId: string,
  toolUseId: string,
  result: PermissionResult,
): boolean {
  const bucket = registry.get(turnId);
  if (!bucket) return false;
  const entry = bucket.get(toolUseId);
  if (!entry) return false;
  bucket.delete(toolUseId);
  if (bucket.size === 0) registry.delete(turnId);
  if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
  entry.resolver(result);
  return true;
}

export function clearTurnConfirms(turnId: string): void {
  const bucket = registry.get(turnId);
  if (!bucket) return;
  // Any still-pending confirms are auto-denied so the SDK doesn't hang.
  for (const entry of bucket.values()) {
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.resolver({
      behavior: "deny",
      message: "turn aborted before user confirmed",
      interrupt: false,
    });
  }
  registry.delete(turnId);
}

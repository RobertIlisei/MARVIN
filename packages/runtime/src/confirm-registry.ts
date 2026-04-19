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
}

const registry = new Map<string, Map<string, PendingEntry>>();

export function registerPendingConfirm(
  turnId: string,
  toolUseId: string,
  resolver: Resolver,
  originalInput: Record<string, unknown> = {},
): void {
  let bucket = registry.get(turnId);
  if (!bucket) {
    bucket = new Map();
    registry.set(turnId, bucket);
  }
  bucket.set(toolUseId, { resolver, originalInput });
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
  entry.resolver(result);
  return true;
}

export function clearTurnConfirms(turnId: string): void {
  const bucket = registry.get(turnId);
  if (!bucket) return;
  // Any still-pending confirms are auto-denied so the SDK doesn't hang.
  for (const { resolver } of bucket.values()) {
    resolver({
      behavior: "deny",
      message: "turn aborted before user confirmed",
      interrupt: false,
    });
  }
  registry.delete(turnId);
}

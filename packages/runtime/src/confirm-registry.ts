/**
 * In-process confirm registry — maps (turnId, toolUseId) → resolver promise
 * so /api/confirm can satisfy a `canUseTool` callback that was registered
 * by an in-flight /api/chat turn.
 *
 * Lives in memory only; MARVIN's web app is single-process, so this is
 * sufficient. If we ever move to multi-process, swap for Redis keyed the
 * same way.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

type Resolver = (result: PermissionResult) => void;

const registry = new Map<string, Map<string, Resolver>>();

export function registerPendingConfirm(
  turnId: string,
  toolUseId: string,
  resolver: Resolver,
): void {
  let bucket = registry.get(turnId);
  if (!bucket) {
    bucket = new Map();
    registry.set(turnId, bucket);
  }
  bucket.set(toolUseId, resolver);
}

export function resolvePendingConfirm(
  turnId: string,
  toolUseId: string,
  result: PermissionResult,
): boolean {
  const bucket = registry.get(turnId);
  if (!bucket) return false;
  const resolver = bucket.get(toolUseId);
  if (!resolver) return false;
  bucket.delete(toolUseId);
  if (bucket.size === 0) registry.delete(turnId);
  resolver(result);
  return true;
}

export function clearTurnConfirms(turnId: string): void {
  const bucket = registry.get(turnId);
  if (!bucket) return;
  // Any still-pending confirms are auto-denied so the SDK doesn't hang.
  for (const resolver of bucket.values()) {
    resolver({
      behavior: "deny",
      message: "turn aborted before user confirmed",
      interrupt: false,
    });
  }
  registry.delete(turnId);
}

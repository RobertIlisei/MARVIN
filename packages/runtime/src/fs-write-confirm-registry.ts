/**
 * Session-scoped confirm-token ledger for the user-initiated write channel.
 *
 * Parallel to [`confirm-registry.ts`](./confirm-registry.ts) but with
 * different lifetime semantics:
 *
 * - `confirm-registry.ts` is **turn-scoped** — keyed by `(turnId, toolUseId)`,
 *   blocks the Agent SDK's `canUseTool` callback, cleaned up on turn exit.
 * - This registry is **session-scoped** — keyed by a short-lived opaque
 *   token. A route returns `409 { needsConfirm, reason, severity }` when
 *   `fsWritePolicy` classifies an op as `confirm`. The client calls
 *   `/api/files/write/confirm` with the op → gets back `{ token,
 *   expiresIn }` → replays the original request with an
 *   `X-Marvin-Confirmed: <token>` header. The token is one-shot.
 *
 * See [ADR-0008](../../../docs/decisions/0008-user-initiated-write-channel.md).
 */

import { randomBytes } from "node:crypto";

import type { FsWriteOp } from "@marvin/tools/fs-write-policy";

const TOKEN_TTL_MS = 60_000;

interface RegistryEntry {
  /** The op the client committed to when it asked for a token. */
  op: FsWriteOp;
  /** Absolute cwd the op was classified against. */
  cwd: string;
  expiresAt: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Mint a one-shot token committing the caller to `op` against `cwd`. The
 * token expires in 60 s; re-minting is cheap if the user needs longer.
 */
export function mintConfirmToken(op: FsWriteOp, cwd: string): {
  token: string;
  expiresIn: number;
} {
  sweepExpired();
  const token = randomBytes(24).toString("base64url");
  registry.set(token, { op, cwd, expiresAt: Date.now() + TOKEN_TTL_MS });
  return { token, expiresIn: TOKEN_TTL_MS / 1000 };
}

/**
 * Consume a token. Returns the stored op+cwd on success; `null` if the
 * token is unknown, expired, already consumed, or doesn't match the
 * provided op / cwd.
 *
 * The comparison is structural to prevent "mint token for harmless op,
 * replay with dangerous op" attacks. The route handler passes the
 * reconstituted op it's about to execute; if it doesn't match what was
 * minted, the token is invalid for that request.
 */
export function consumeConfirmToken(
  token: string | null | undefined,
  expected: { op: FsWriteOp; cwd: string },
): { ok: true } | { ok: false; reason: string } {
  sweepExpired();
  if (!token) return { ok: false, reason: "no token provided" };
  const entry = registry.get(token);
  if (!entry) return { ok: false, reason: "unknown or consumed token" };
  // One-shot regardless of outcome.
  registry.delete(token);
  if (entry.expiresAt <= Date.now()) return { ok: false, reason: "token expired" };
  if (entry.cwd !== expected.cwd) {
    return { ok: false, reason: "token/cwd mismatch" };
  }
  if (!opsEqual(entry.op, expected.op)) {
    return { ok: false, reason: "token/op mismatch" };
  }
  return { ok: true };
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [token, entry] of registry) {
    if (entry.expiresAt <= now) registry.delete(token);
  }
}

function opsEqual(a: FsWriteOp, b: FsWriteOp): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "create-file":
      return (
        b.kind === "create-file" && a.path === b.path && a.bytes === b.bytes
      );
    case "create-dir":
      return b.kind === "create-dir" && a.path === b.path;
    case "write-file":
      return (
        b.kind === "write-file" &&
        a.path === b.path &&
        a.bytes === b.bytes &&
        a.overwrite === b.overwrite
      );
    case "rename":
      return b.kind === "rename" && a.from === b.from && a.to === b.to;
    case "move":
      return (
        b.kind === "move" &&
        a.to === b.to &&
        a.from.length === b.from.length &&
        a.from.every((p, i) => p === b.from[i])
      );
    case "delete-trash":
      return (
        b.kind === "delete-trash" &&
        a.paths.length === b.paths.length &&
        a.paths.every((p, i) => p === b.paths[i])
      );
    case "delete-permanent":
      return (
        b.kind === "delete-permanent" &&
        a.paths.length === b.paths.length &&
        a.paths.every((p, i) => p === b.paths[i])
      );
  }
}

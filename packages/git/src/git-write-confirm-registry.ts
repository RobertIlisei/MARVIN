/**
 * Session-scoped confirm-token ledger for the user-initiated git
 * channel.
 *
 * Direct sibling of
 * [`packages/runtime/src/fs-write-confirm-registry.ts`](../../runtime/src/fs-write-confirm-registry.ts)
 * — same 60 s TTL, same one-shot-consume semantics, same structural
 * op-equality check. Kept separate because the stored-op type differs
 * (GitOp vs FsWriteOp) and making the registry generic costs more
 * casting than it saves.
 *
 * See [ADR-0012](../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { randomBytes } from "node:crypto";

import type { GitOp } from "./git-write-policy.js";

const TOKEN_TTL_MS = 60_000;

interface RegistryEntry {
  op: GitOp;
  cwd: string;
  expiresAt: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Mint a one-shot token committing the caller to `op` against `cwd`.
 * Expires in 60 s; re-minting is cheap if the user needs longer.
 */
export function mintGitConfirmToken(
  op: GitOp,
  cwd: string,
): { token: string; expiresIn: number } {
  sweepExpired();
  const token = randomBytes(24).toString("base64url");
  registry.set(token, { op, cwd, expiresAt: Date.now() + TOKEN_TTL_MS });
  return { token, expiresIn: TOKEN_TTL_MS / 1000 };
}

/**
 * Consume a token. Returns `{ ok: true }` if the token is valid AND
 * structurally matches the op + cwd the caller is about to execute.
 * Returns `{ ok: false, reason }` otherwise.
 *
 * The op-equality check prevents "mint token for harmless op, replay
 * with dangerous op" attacks — the route handler passes what it's
 * about to execute; if it doesn't match what was minted, the token
 * is invalid.
 */
export function consumeGitConfirmToken(
  token: string | null | undefined,
  expected: { op: GitOp; cwd: string },
): { ok: true } | { ok: false; reason: string } {
  sweepExpired();
  if (!token) return { ok: false, reason: "no token provided" };
  const entry = registry.get(token);
  if (!entry) return { ok: false, reason: "unknown or consumed token" };
  registry.delete(token); // one-shot regardless of outcome
  if (entry.expiresAt <= Date.now()) {
    return { ok: false, reason: "token expired" };
  }
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

function opsEqual(a: GitOp, b: GitOp): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "stage":
      return b.kind === "stage" && arraysEqual(a.paths, b.paths);
    case "unstage":
      return b.kind === "unstage" && arraysEqual(a.paths, b.paths);
    case "discard":
      return (
        b.kind === "discard" &&
        a.mode === b.mode &&
        arraysEqual(a.paths, b.paths)
      );
    case "commit":
      return (
        b.kind === "commit" &&
        a.message === b.message &&
        a.amend === b.amend &&
        a.hasPushedHead === b.hasPushedHead
      );
    case "branch-create":
      return b.kind === "branch-create" && a.name === b.name && a.from === b.from;
    case "branch-switch":
      return (
        b.kind === "branch-switch" &&
        a.name === b.name &&
        a.workingTreeClean === b.workingTreeClean
      );
    case "branch-delete":
      return (
        b.kind === "branch-delete" &&
        a.name === b.name &&
        a.merged === b.merged &&
        a.isCurrent === b.isCurrent
      );
    case "push":
      return (
        b.kind === "push" &&
        a.force === b.force &&
        a.branch === b.branch &&
        a.upstreamAhead === b.upstreamAhead
      );
    case "pull":
      return b.kind === "pull" && a.strategy === b.strategy;
    case "fetch":
      return b.kind === "fetch" && a.remote === b.remote;
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Exposed for tests only. */
export function _resetRegistryForTests(): void {
  registry.clear();
}

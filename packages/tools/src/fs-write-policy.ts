/**
 * Policy for user-initiated filesystem writes from the tree UI.
 *
 * Sibling of `policy.ts` — same shape (auto/confirm/deny), different input
 * space. `policy.ts` classifies LLM tool calls (`Edit`, `Write`, `Bash`).
 * `fsWritePolicy` classifies user ops (create / rename / move / delete /
 * write / upload) dispatched from `/api/files/write/*`.
 *
 * Both channels share `fs-constants.ts` so tightening one policy
 * automatically flows into the other.
 *
 * See [ADR-0008](../../../docs/decisions/0008-user-initiated-write-channel.md).
 */

import {
  HARD_DENY_DIR_SEGMENTS,
  hasDenySegment,
  isSecretFileName,
} from "./fs-constants";

/** Maximum bytes accepted by the editor `/save` route. */
export const WRITE_SIZE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export type FsWriteOp =
  | { kind: "create-file"; path: string; bytes: number }
  | { kind: "create-dir"; path: string }
  | { kind: "write-file"; path: string; bytes: number; overwrite: boolean }
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; from: string[]; to: string }
  | { kind: "delete-trash"; paths: string[] }
  | { kind: "delete-permanent"; paths: string[] };

export type FsWriteClass = "auto" | "confirm" | "deny";
export type FsWriteSeverity = "warn" | "danger";

export interface FsWriteDecision {
  class: FsWriteClass;
  reason: string;
  /** Only populated when `class === "confirm"`. */
  severity?: FsWriteSeverity;
}

const auto = (reason: string): FsWriteDecision => ({ class: "auto", reason });
const deny = (reason: string): FsWriteDecision => ({ class: "deny", reason });
const confirm = (
  reason: string,
  severity: FsWriteSeverity,
): FsWriteDecision => ({ class: "confirm", reason, severity });

/**
 * Classify a user-initiated filesystem op. Caller is expected to have run
 * each path through `checkFsPath` already — this function only consults
 * the deny list / secret list / size caps / structural rules.
 *
 * `cwd` is the absolute project root; paths in `op` may be absolute or
 * relative.
 */
export function fsWritePolicy(op: FsWriteOp, cwd: string): FsWriteDecision {
  switch (op.kind) {
    case "create-file":
    case "write-file": {
      const denyReason = denyByPath(op.path, cwd);
      if (denyReason) return deny(denyReason);
      if (op.bytes > WRITE_SIZE_MAX_BYTES) {
        return deny(
          `write exceeds ${WRITE_SIZE_MAX_BYTES}-byte cap (${op.bytes} bytes)`,
        );
      }
      if (isSecretPath(op.path)) {
        return confirm("writing a secret-bearing file", "danger");
      }
      return auto("write inside project, no sensitive match");
    }
    case "create-dir": {
      const denyReason = denyByPath(op.path, cwd);
      if (denyReason) return deny(denyReason);
      return auto("mkdir inside project");
    }
    case "rename": {
      const d1 = denyByPath(op.from, cwd);
      if (d1) return deny(`rename source: ${d1}`);
      const d2 = denyByPath(op.to, cwd);
      if (d2) return deny(`rename target: ${d2}`);
      if (op.from === op.to) return deny("rename to same path");
      // Case-insensitive collision on APFS/HFS+ case-preserving volumes:
      // renaming `Foo.ts` → `foo.ts` silently no-ops. Ask for confirm so the
      // UI can surface the quirk (and later fall back to a two-step rename
      // if the user insists).
      if (
        op.from.toLowerCase() === op.to.toLowerCase() &&
        op.from !== op.to
      ) {
        return confirm(
          "rename only changes case — may no-op on case-insensitive filesystems",
          "warn",
        );
      }
      if (isSecretPath(op.from) || isSecretPath(op.to)) {
        return confirm("rename touches a secret-bearing file", "danger");
      }
      return auto("rename inside project");
    }
    case "move": {
      if (op.from.length === 0) return deny("move: empty source list");
      for (const src of op.from) {
        const d = denyByPath(src, cwd);
        if (d) return deny(`move source ${src}: ${d}`);
        if (isSameOrParent(src, cwd)) {
          return deny(`move source ${src} is the project root or above`);
        }
      }
      const dTo = denyByPath(op.to, cwd);
      if (dTo) return deny(`move target: ${dTo}`);
      if (op.from.some((p) => isSecretPath(p))) {
        return confirm("move touches a secret-bearing file", "danger");
      }
      return auto("move inside project");
    }
    case "delete-trash": {
      if (op.paths.length === 0) return deny("delete: empty path list");
      for (const p of op.paths) {
        const d = denyByPath(p, cwd);
        if (d) return deny(`delete source ${p}: ${d}`);
        if (isSameOrParent(p, cwd)) {
          return deny("delete would remove the project root");
        }
      }
      if (op.paths.some(isSecretPath)) {
        return confirm("trashing a secret-bearing file", "danger");
      }
      return auto("move to Trash is reversible");
    }
    case "delete-permanent": {
      if (op.paths.length === 0) return deny("delete: empty path list");
      for (const p of op.paths) {
        const d = denyByPath(p, cwd);
        if (d) return deny(`delete source ${p}: ${d}`);
        if (isSameOrParent(p, cwd)) {
          return deny("delete would remove the project root");
        }
      }
      // Permanent-delete always confirms. UX: the modal surfaces the
      // severity and the count; the user clicks through once per batch.
      return confirm(
        `permanent delete of ${op.paths.length} item(s) is irreversible`,
        "danger",
      );
    }
  }
}

/** Returns a deny reason if the path is disallowed, else null. */
function denyByPath(p: string, cwd: string): string | null {
  // Paths should already be sandboxed by `checkFsPath`; defensive here.
  if (p.includes("\0")) return "path contains NUL byte";
  const rel = relativeFromCwd(p, cwd);
  if (rel.startsWith("..")) return `path escapes cwd: ${p}`;
  if (hasDenySegment(rel)) {
    const seg = [...HARD_DENY_DIR_SEGMENTS].find((s) =>
      rel.split("/").includes(s),
    );
    return `path contains deny-listed segment \`${seg}\``;
  }
  return null;
}

function relativeFromCwd(p: string, cwd: string): string {
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (p === cwd) return "";
  return p; // caller handles the escape case
}

function isSameOrParent(p: string, cwd: string): boolean {
  return p === cwd || cwd.startsWith(p + "/");
}

function isSecretPath(p: string): boolean {
  const base = p.split("/").pop() ?? p;
  return isSecretFileName(base);
}

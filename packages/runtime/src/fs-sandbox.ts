/**
 * Path sandboxing for MARVIN's filesystem endpoints.
 *
 * Single source of truth for "does this caller-provided path stay inside the
 * project cwd?" Both the read-side routes (`/api/files/content`, tree,
 * status) and the write-side routes (`/api/files/write/*`, M2) call
 * `checkFsPath` before touching disk.
 *
 * Order of checks (fail fast):
 *   1. `cwd` must be absolute.
 *   2. `target` can't contain NUL bytes; total length ≤ 1024 bytes.
 *   3. `path.resolve(cwd, target)` → absolute; `path.relative(cwd, abs)` must
 *      not start with `..` and must not be absolute.
 *   4. `fs.lstat(abs)` — if the direct entry is a symlink, reject by default.
 *      (The existing `content` route used `fs.stat`, which silently followed
 *      symlinks. A symlink `project/foo.txt -> /etc/passwd` would have
 *      rendered `/etc/passwd`. Fixed here.)
 *   5. `fs.realpath(abs)` — rerun the escape check against the canonicalised
 *      path so an ancestor symlink (e.g. `project/cache -> /tmp/stuff`)
 *      can't escape either.
 *   6. For `mustExist: false`, find the first extant ancestor, realpath
 *      *that*, and rerun the escape check on the ancestor.
 *
 * The helper is intentionally I/O-bearing (it performs `lstat`/`realpath`),
 * which is why it lives in `@marvin/runtime` rather than `@marvin/tools` —
 * the latter is a pure classifier package.
 *
 * See [ADR-0008](../../../docs/decisions/0008-user-initiated-write-channel.md).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type SandboxErrorCode =
  | "cwd-not-absolute"
  | "path-contains-null"
  | "path-too-long"
  | "path-escapes-cwd"
  | "symlink-rejected"
  | "symlink-escapes-cwd"
  | "not-found"
  | "parent-not-found"
  | "is-directory"
  | "not-a-directory"
  | "io-error";

export interface SandboxCheckInput {
  /** Absolute path to the project root. Caller is expected to have normalised. */
  cwd: string;
  /** Caller-provided path; may be relative to cwd or absolute. */
  target: string;
  /**
   * If `true` (default), the target must already exist. If `false`, the
   * parent must exist and the escape check runs against the first extant
   * ancestor.
   */
  mustExist?: boolean;
  /**
   * If `true`, the target may be a directory; otherwise reject directories.
   * If `false` (default), the target must be a regular file (when it
   * exists).
   */
  allowDirectory?: boolean;
}

export interface SandboxCheckOk {
  ok: true;
  /** Canonicalised absolute path — safe to pass to fs.* without further checks. */
  absolutePath: string;
  /** `realpath` output. Same as `absolutePath` unless ancestors were symlinks. */
  realPath: string | null;
  isDirectory: boolean;
  /** Whether the *target itself* is a symlink (always rejected — present for telemetry). */
  isSymlink: boolean;
  exists: boolean;
}

export interface SandboxCheckErr {
  ok: false;
  error: SandboxErrorCode;
  /** Human-readable detail suitable for logs (not user-facing). */
  detail: string;
}

export type SandboxCheckResult = SandboxCheckOk | SandboxCheckErr;

const MAX_PATH_BYTES = 1024;

function err(error: SandboxErrorCode, detail: string): SandboxCheckErr {
  return { ok: false, error, detail };
}

/**
 * Check whether `target` resolves inside `cwd` and return the canonicalised
 * absolute path on success.
 */
export async function checkFsPath(
  input: SandboxCheckInput,
): Promise<SandboxCheckResult> {
  const { cwd, target } = input;
  const mustExist = input.mustExist ?? true;
  const allowDirectory = input.allowDirectory ?? false;

  if (!path.isAbsolute(cwd)) {
    return err("cwd-not-absolute", `cwd must be absolute: ${cwd}`);
  }
  if (target.includes("\0")) {
    return err("path-contains-null", "target contains NUL byte");
  }
  if (Buffer.byteLength(target, "utf8") > MAX_PATH_BYTES) {
    return err("path-too-long", `target exceeds ${MAX_PATH_BYTES} bytes`);
  }

  const rootResolved = path.resolve(cwd);
  const targetResolved = path.resolve(rootResolved, target);

  if (!isInside(rootResolved, targetResolved)) {
    return err(
      "path-escapes-cwd",
      `${targetResolved} is not inside ${rootResolved}`,
    );
  }

  // lstat to detect a symlink *at the target* without following it.
  let lstat;
  try {
    lstat = await fs.lstat(targetResolved);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      if (mustExist) return err("not-found", targetResolved);
      return checkNonExistentTarget(rootResolved, targetResolved);
    }
    return err("io-error", `lstat failed: ${String(e)}`);
  }

  const isSymlink = lstat.isSymbolicLink();
  if (isSymlink) {
    return err("symlink-rejected", `${targetResolved} is a symlink`);
  }

  // Rerun the escape check against realpath in case an *ancestor* is a
  // symlink (e.g. cwd/cache -> /tmp). We only reach this branch for non-
  // symlink targets, but ancestors might still point outside cwd.
  let realPath: string;
  try {
    realPath = await fs.realpath(targetResolved);
  } catch (e) {
    return err("io-error", `realpath failed: ${String(e)}`);
  }
  const realRoot = await safeRealpath(rootResolved);
  if (!isInside(realRoot, realPath)) {
    return err(
      "symlink-escapes-cwd",
      `${realPath} (realpath of ${targetResolved}) escapes ${realRoot}`,
    );
  }

  const isDirectory = lstat.isDirectory();
  if (isDirectory && !allowDirectory) {
    return err("is-directory", `${targetResolved} is a directory`);
  }
  if (!isDirectory && !lstat.isFile() && !lstat.isSymbolicLink()) {
    // Sockets, devices, etc. Treat as not a regular file.
    return err("not-a-directory", `${targetResolved} is not a regular file`);
  }

  return {
    ok: true,
    absolutePath: targetResolved,
    realPath,
    isDirectory,
    isSymlink,
    exists: true,
  };
}

/**
 * For `mustExist: false`: walk upward from `target` to the first extant
 * ancestor, canonicalise it, and re-run the escape check. Prevents the
 * `cwd/cache/new.txt` → `cache` is a symlink escape.
 */
async function checkNonExistentTarget(
  rootResolved: string,
  targetResolved: string,
): Promise<SandboxCheckResult> {
  let cursor = path.dirname(targetResolved);
  const realRoot = await safeRealpath(rootResolved);
  while (cursor !== path.dirname(cursor)) {
    try {
      const ancestor = await fs.realpath(cursor);
      if (!isInside(realRoot, ancestor)) {
        return err(
          "symlink-escapes-cwd",
          `ancestor ${ancestor} (realpath of ${cursor}) escapes ${realRoot}`,
        );
      }
      return {
        ok: true,
        absolutePath: targetResolved,
        realPath: null,
        isDirectory: false,
        isSymlink: false,
        exists: false,
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        cursor = path.dirname(cursor);
        continue;
      }
      return err("io-error", `realpath on ancestor failed: ${String(e)}`);
    }
  }
  return err("parent-not-found", `no extant ancestor for ${targetResolved}`);
}

/** `true` when `child` equals `parent` or is strictly inside it. */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `fs.realpath` that falls back to the input if the path is missing. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

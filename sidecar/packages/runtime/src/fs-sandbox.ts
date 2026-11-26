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
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { validateSessionCwd } from "./session-cwd";

export type SandboxErrorCode =
  | "cwd-not-absolute"
  | "cwd-not-registered"
  | "path-contains-null"
  | "path-too-long"
  | "path-escapes-cwd"
  | "symlink-rejected"
  | "symlink-escapes-cwd"
  | "not-found"
  | "parent-not-found"
  | "is-directory"
  | "not-a-directory"
  | "not-regular-file"
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
  /**
   * Set only by `checkViewPath`: the file is a regular file under a system
   * temp root, readable for display and NOT part of the project — so never
   * writable (the write routes call `checkFsPath`, which refuses it).
   */
  outsideProject?: true;
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
  // Audit 🟠 #9: every mutating route that takes a cwd from the
  // client must verify it matches a registered project. Path-
  // sandboxing alone (`isInside(cwd, target)`) doesn't help if
  // `cwd` itself is `/etc` — checkFsPath would then happily
  // allow writes anywhere under /etc. The registered-project
  // check makes the sandbox boundary the project root the user
  // actually opened, not an attacker-supplied path.
  // ADR-0107 — a chat session may run in its own worktree; the boundary is
  // then that worktree's root. Only a REGISTERED worktree of a registered
  // project passes (see `validateSessionCwd`), never an arbitrary directory.
  const projectCheck = validateSessionCwd(cwd);
  if (!projectCheck.ok) {
    return err(
      "cwd-not-registered",
      `cwd is not a registered project: ${cwd}`,
    );
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
  let lstat: Awaited<ReturnType<typeof fs.lstat>>;
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

export interface ViewCheckInput {
  cwd: string;
  target: string;
  /** Override the temp roots (tests). Default: `viewableTempRoots()`. */
  tempRoots?: string[];
}

/**
 * Read-only counterpart of `checkFsPath`, for DISPLAYING a file to the user
 * who clicked it (`/api/files/content`, `/api/files/raw`). Everything
 * `checkFsPath` accepts is accepted unchanged. One extension: a tab is told to
 * copy captures out of the project into /tmp (Playwright wipes `test-results`
 * on every run) and then links them, so a REGULAR file under a system temp
 * root is viewable too.
 *
 * What stays refused: a symlink at the target (even one pointing inside the
 * root), an ancestor symlink whose realpath leaves the root, a prefix
 * look-alike (`/tmp-evil`), a directory (no listing), and anything that is not
 * a regular file — opening a FIFO for read would hang the route. A path that
 * is lexically outside every root answers `path-escapes-cwd` WITHOUT touching
 * disk, so the route is not an existence oracle for the rest of the machine.
 * The registered-cwd check still runs first (inside `checkFsPath`).
 *
 * Never use this on a write route: those keep calling `checkFsPath`, which
 * refuses these files, so a temp file shown in the viewer cannot be saved.
 */
export async function checkViewPath(
  input: ViewCheckInput,
): Promise<SandboxCheckResult> {
  const inProject = await checkFsPath(input);
  if (inProject.ok || inProject.error !== "path-escapes-cwd") return inProject;
  // Only an ABSOLUTE target may reach outside the project; a relative one that
  // climbs out of it is exactly what the project sandbox exists to refuse.
  if (!path.isAbsolute(input.target)) return inProject;

  const roots = input.tempRoots ?? (await viewableTempRoots());
  const abs = path.resolve(input.target);
  // Lexical gate first (raw roots and their canonical forms), before any I/O.
  const lexicalRoots = [...roots, ...(await Promise.all(roots.map(safeRealpath)))];
  if (!lexicalRoots.some((r) => isStrictlyInside(r, abs))) return inProject;

  let lstat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lstat = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return err("not-found", abs);
    }
    return err("io-error", `lstat failed: ${String(e)}`);
  }
  if (lstat.isSymbolicLink()) {
    return err("symlink-rejected", `${abs} is a symlink`);
  }
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    return err("io-error", `realpath failed: ${String(e)}`);
  }
  const realRoots = await Promise.all(roots.map(safeRealpath));
  if (!realRoots.some((r) => isStrictlyInside(r, real))) {
    return err("symlink-escapes-cwd", `${real} (realpath of ${abs}) leaves the temp roots`);
  }
  if (!lstat.isFile()) {
    return err(
      lstat.isDirectory() ? "is-directory" : "not-regular-file",
      `${abs} is not a regular file`,
    );
  }
  return {
    ok: true,
    // The canonical path: what the route opens is what was checked.
    absolutePath: real,
    realPath: real,
    isDirectory: false,
    isSymlink: false,
    exists: true,
    outsideProject: true,
  };
}

/**
 * The system temp directories a session's links may point into, canonicalised
 * (`/tmp` is a symlink to `/private/tmp` on macOS). Never `/`, never the home
 * directory: `TMPDIR` is environment, and a root that wide is not a temp dir.
 */
export async function viewableTempRoots(): Promise<string[]> {
  const candidates = ["/tmp", tmpdir(), process.env.TMPDIR].filter(
    (c): c is string => typeof c === "string" && path.isAbsolute(c),
  );
  const home = await safeRealpath(homedir());
  const out: string[] = [];
  for (const c of candidates) {
    const real = await safeRealpath(path.resolve(c));
    if (real === path.parse(real).root || real === home) continue;
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * One sentence per refusal: what was refused and why. The routes send it as
 * `message` beside the machine code, and the app shows it — the viewer used to
 * print `FilesServiceError error 0` for a 400 whose reason was in the body.
 */
export function describeSandboxError(code: SandboxErrorCode, target: string): string {
  switch (code) {
    case "path-escapes-cwd":
    case "symlink-escapes-cwd":
      return `This file is outside the project and cannot be shown: ${target}`;
    case "symlink-rejected":
      return `This path is a symbolic link, which MARVIN does not follow: ${target}`;
    case "not-found":
    case "parent-not-found":
      return `This file does not exist (any more): ${target}`;
    case "is-directory":
      return `This is a folder, not a file: ${target}`;
    case "not-a-directory":
    case "not-regular-file":
      return `This is not a regular file (a pipe, socket or device) and cannot be shown: ${target}`;
    case "cwd-not-registered":
      return "This project is not registered with MARVIN, so its files cannot be shown.";
    case "cwd-not-absolute":
      return "The project folder was not given as an absolute path.";
    case "path-contains-null":
      return "The file path contains an invalid character.";
    case "path-too-long":
      return "The file path is too long.";
    case "io-error":
      return `The file could not be read: ${target}`;
  }
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

/** `true` when `child` is strictly inside `parent` (a root itself is a directory, not a file). */
function isStrictlyInside(parent: string, child: string): boolean {
  return parent !== child && isInside(parent, child);
}

/** `fs.realpath` that falls back to the input if the path is missing. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

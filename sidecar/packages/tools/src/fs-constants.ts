/**
 * Shared constants for MARVIN's filesystem surfaces.
 *
 * Both the LLM-initiated tool channel (Edit/Write/Bash) and the user-initiated
 * write channel (tree UI, /api/files/write/*) must enforce the same
 * ignore/deny lists. Keeping them in one module prevents the classic
 * "tightened one, forgot the other" drift.
 *
 * See [ADR-0008](../../../docs/decisions/0008-user-initiated-write-channel.md).
 */

/**
 * Directory names excluded from tree walks, writes, and policy enforcement.
 * Historical: this set previously lived inline in
 * `sidecar/src/app/api/files/tree/route.ts`.
 */
export const IGNORE_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  "coverage",
  ".parcel-cache",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  "vendor",
]);

/**
 * Path segments that the user-initiated write policy HARD-denies — create,
 * rename-to, move-to, delete, or write-through all reject if any segment of
 * the target path matches.
 *
 * Superset of IGNORE_DIR_NAMES minus `.DS_Store` (which is a file, not a dir
 * the user would ever navigate into). We keep them as a superset so future
 * additions to the ignore set automatically flow into the deny list.
 */
export const HARD_DENY_DIR_SEGMENTS: ReadonlySet<string> = new Set(
  [...IGNORE_DIR_NAMES].filter((n) => n !== ".DS_Store"),
);

/**
 * Filename patterns for secret-bearing files. Writes/deletes targeting these
 * require an explicit confirm (danger severity). We don't block — users
 * legitimately need to edit `.env` — but we want a conscious click.
 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\.[^/]+)?$/,
  /\.pem$/,
  /^id_rsa(\.[^/]+)?$/,
  /^id_ed25519(\.[^/]+)?$/,
  /\.p12$/,
  /\.pfx$/,
];

/** `true` if any segment of an absolute or relative path hits the deny list. */
export function hasDenySegment(absOrRelPath: string): boolean {
  for (const seg of absOrRelPath.split("/")) {
    if (HARD_DENY_DIR_SEGMENTS.has(seg)) return true;
  }
  return false;
}

/** `true` if the basename matches a known secret-file pattern. */
export function isSecretFileName(basename: string): boolean {
  return SECRET_FILE_PATTERNS.some((r) => r.test(basename));
}

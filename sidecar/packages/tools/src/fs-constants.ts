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
 * Subdirectories of `graphify-out/` the tree skips. The folder itself is
 * shown (user, 2026-08-29: "I can't see the graphify-out directory") —
 * `graph.json`, `GRAPH_REPORT.md`, `knowledge/graph.json` are things people
 * open. What must stay out is the extraction cache: 12,195 files on one
 * real project, 61 % of the tree's 20,000-entry cap, truncating the tree so
 * unrelated folders looked MISSING (observed 2026-08-15). That was the
 * reason the whole folder was hidden; hiding only the cache keeps the fix.
 */
export const GRAPHIFY_OUT_DIR = "graphify-out";
export const GRAPHIFY_OUT_SKIP: ReadonlySet<string> = new Set([
  "cache",
  ".chunks",
  "chunks",
  "reflections",
  // ADR-0092 — `graphify export obsidian` writes ONE NOTE PER GRAPH NODE:
  // 34,463 files on a real project, which is the ENTIRE 20,000-entry tree
  // budget and then some ("Tree truncated" — user, 2026-08-30). Exactly the
  // failure that got `cache` skipped (12,195 files, 2026-08-15), repeated by
  // a folder that did not exist then. The canvas beside them —
  // `graph.canvas`, one file — is the artefact worth browsing, and a file is
  // not a directory, so it survives this filter.
  "obsidian",
]);

/** True when `name` under `parentName` is generated graphify bulk the tree
 *  hides. `graphify-out/` itself stays browsable — `graph.json`,
 *  `GRAPH_REPORT.md` and `obsidian/graph.canvas` are things people open. */
export function isGraphifyCacheDir(parentName: string, name: string): boolean {
  return parentName === GRAPHIFY_OUT_DIR && GRAPHIFY_OUT_SKIP.has(name);
}

/**
 * Subdirectories of `.marvin/` the tree skips — MARVIN's own scratch space,
 * not the user's project.
 *
 * `.marvin/` itself stays browsable, and deliberately so: `plans/`, `memory/`,
 * `backlog/`, `skills/` and the loose markdown beside them are documents
 * people open. What must stay out is the bulk MARVIN generates for its own
 * use.
 *
 * `worktrees/` is the reason this exists. A MARVIN worktree is a FULL CHECKOUT
 * of the repository, created inside the repository — so the tree walked into
 * copies of itself. Measured on one real project (2026-09-01): five worktrees,
 * **49,304 files**, against ~9,000 files of actual source. The tree truncated
 * at 20,000 and the user's own `apps/` and `docs/` fell off the end.
 *
 * **This is the third time this exact bug has shipped.** `cache` was skipped
 * on 2026-08-15 (12,195 files, 61 % of the budget); `obsidian` on 2026-08-30
 * (34,463 files, "Tree truncated" — user); `worktrees` now. Every one was a
 * directory of machine-generated bulk that did not exist when the previous fix
 * was written, and every one presented as "my folders are missing". The entry
 * cap no longer truncates by default (see the tree route), so a fourth such
 * directory degrades a scroll bar rather than hiding the user's source — but
 * it still belongs here, because walking a full second checkout is waste
 * whether or not it fits.
 */
export const MARVIN_DIR = ".marvin";
export const MARVIN_DIR_SKIP: ReadonlySet<string> = new Set([
  // Full repository checkouts (ADR-0081 implementer worktrees).
  "worktrees",
  // Sanitised copies of every enabled plugin, re-staged per turn (ADR-0053).
  "plugins-stage",
]);

/** True when `name` under `parentName` is MARVIN's own generated bulk. */
export function isMarvinScratchDir(parentName: string, name: string): boolean {
  return parentName === MARVIN_DIR && MARVIN_DIR_SKIP.has(name);
}

/**
 * Path segments that the user-initiated write policy HARD-denies — create,
 * rename-to, move-to, delete, or write-through all reject if any segment of
 * the target path matches.
 *
 * Superset of IGNORE_DIR_NAMES minus `.DS_Store` (which is a file, not a dir
 * the user would ever navigate into). We keep them as a superset so future
 * additions to the ignore set automatically flow into the deny list.
 */
export const HARD_DENY_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  ...[...IGNORE_DIR_NAMES].filter((n) => n !== ".DS_Store"),
  // Visible in the tree since 2026-08-29, still not user-writable: it is
  // graphify's output, and the MCP graph tools own it.
  GRAPHIFY_OUT_DIR,
]);

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

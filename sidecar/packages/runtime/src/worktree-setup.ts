/**
 * Worktree setup (ADR-0107) — make a fresh session worktree usable without
 * re-installing the world.
 *
 * `git worktree add` gives a clean checkout: no `node_modules`, no `.env`, no
 * build caches. Anthropic's own worktree support has two knobs for exactly
 * this (`worktree.symlinkDirectories`, `.worktreeinclude`); they apply only to
 * worktrees the CLI creates, so MARVIN honours the same intent for the trees
 * it creates itself:
 *
 *   - `<workDir>/.marvin/worktree.json`
 *       { "symlinkDirectories": ["node_modules", ".cache"],
 *         "copyIgnored": [".env", ".env.local"],
 *         "honorWorktreeInclude": true }
 *   - `<workDir>/.worktreeinclude` — one gitignore-style pattern per line,
 *     the file Claude Code documents; read when `honorWorktreeInclude` is on.
 *
 * Nothing is symlinked or copied by default (Golden Rule 6: MARVIN ships no
 * project knowledge). Only files git IGNORES are ever copied — a tracked file
 * is already in the checkout, and copying an ignored file is the whole point.
 * Never overwrites, bounded in count and bytes, best-effort throughout.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export interface WorktreeSetupConfig {
  symlinkDirectories: string[];
  copyIgnored: string[];
  honorWorktreeInclude: boolean;
}

export interface WorktreeSetupReport {
  symlinked: string[];
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export const DEFAULT_SETUP: WorktreeSetupConfig = {
  symlinkDirectories: [],
  copyIgnored: [],
  honorWorktreeInclude: true,
};

const MAX_COPY_FILES = 500;
const MAX_COPY_BYTES = 50 * 1024 * 1024;

function safeRelative(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const s = entry.trim().replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s === ".." || s.startsWith("../") || s.includes("/../") || s.endsWith("/..")) return null;
  return s.replace(/\/+$/, "");
}

/**
 * Dependency directories worth symlinking when they exist in the main
 * checkout and git ignores them. Caches and installed dependencies only —
 * never build OUTPUT (`target`, `.next`, `dist`), which would make two
 * worktrees share stale artefacts. A project overrides all of this in
 * `.marvin/worktree.json`.
 */
export const DETECTABLE_DEPENDENCY_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  ".pnpm-store",
  "vendor",
  ".yarn/cache",
  ".gradle",
  // MARVIN's own graph output. `graphify-bridge` already reads it from
  // `workDir`, but the MODEL reaches for `graphify-out/…` by relative path,
  // and an absent one sent it back to the main checkout on every query.
  "graphify-out",
];

/** Ignored files a fresh worktree almost always needs: local environment. */
export const DETECTABLE_COPY_PATTERNS = [".env", ".env.*", ".envrc", "*.local"];

/**
 * ADR-0107 addendum — work out a sensible setup for a project that has no
 * `.marvin/worktree.json`: every detectable dependency dir that exists and is
 * git-ignored (root and one level into workspace packages, e.g.
 * `apps/web/node_modules`), plus the environment-file patterns when at least
 * one ignored file matches them. Pure with respect to the config; reads git.
 */
export function detectWorktreeSetup(workDir: string): WorktreeSetupConfig {
  const ignored = ignoredCandidates(workDir).map((c) => c.replace(/\/$/, ""));
  const ignoredSet = new Set(ignored);
  const symlinkDirectories: string[] = [];
  for (const dir of DETECTABLE_DEPENDENCY_DIRS) {
    if (ignoredSet.has(dir) && isDir(join(workDir, dir))) symlinkDirectories.push(dir);
  }
  // Nested dependency dirs (monorepo packages), one or two levels deep.
  for (const rel of ignored) {
    const parts = rel.split("/");
    const last = parts[parts.length - 1] ?? "";
    if (parts.length >= 2 && parts.length <= 3 && DETECTABLE_DEPENDENCY_DIRS.includes(last) && isDir(join(workDir, rel))) {
      if (!symlinkDirectories.includes(rel)) symlinkDirectories.push(rel);
    }
  }
  const copyIgnored = DETECTABLE_COPY_PATTERNS.filter((pat) => ignored.some((rel) => matchesInclude(pat, rel)));
  return { symlinkDirectories, copyIgnored, honorWorktreeInclude: true };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the project's config, or — when there is none — DETECT one and write
 * it to `.marvin/worktree.json` (marked `"detected": true`) so the user can
 * see and edit what MARVIN chose. Golden Rule 6 holds: nothing project-
 * specific ships in MARVIN; the detection reads the project itself.
 */
export function readOrDetectWorktreeSetup(workDir: string): { config: WorktreeSetupConfig; detected: boolean } {
  const p = join(workDir, ".marvin", "worktree.json");
  if (existsSync(p)) return { config: readWorktreeSetupConfig(workDir), detected: false };
  const config = detectWorktreeSetup(workDir);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify({ ...config, detected: true }, null, 2)}\n`, "utf-8");
  } catch {
    /* best-effort: the detected config still applies to this worktree */
  }
  return { config, detected: true };
}

/** Tolerant read of `<workDir>/.marvin/worktree.json`; defaults when absent or malformed. */
export function readWorktreeSetupConfig(workDir: string): WorktreeSetupConfig {
  const p = join(workDir, ".marvin", "worktree.json");
  if (!existsSync(p)) return { ...DEFAULT_SETUP };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<Record<keyof WorktreeSetupConfig, unknown>>;
    const dirs = Array.isArray(raw.symlinkDirectories)
      ? raw.symlinkDirectories.map(safeRelative).filter((d): d is string => !!d)
      : [];
    const copy = Array.isArray(raw.copyIgnored)
      ? raw.copyIgnored.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean)
      : [];
    return {
      symlinkDirectories: [...new Set(dirs)],
      copyIgnored: [...new Set(copy)],
      honorWorktreeInclude: raw.honorWorktreeInclude !== false,
    };
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

/** Patterns from `<workDir>/.worktreeinclude`, comments and blanks stripped. */
export function readWorktreeInclude(workDir: string): string[] {
  const p = join(workDir, ".worktreeinclude");
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * A small gitignore-style matcher: a leading `/` anchors to the root, a
 * trailing `/` means "a directory (and everything under it)", `*` matches
 * within a segment, `**` matches across segments, and an unanchored pattern
 * matches at any depth. Enough for `.env`, `*.local`, `config/**`, `dir/`.
 */
export function matchesInclude(pattern: string, relPath: string): boolean {
  let pat = pattern.trim().replace(/\\/g, "/");
  if (!pat || pat.startsWith("#")) return false;
  const rel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  const toRegex = (glob: string): string =>
    glob
      .split("**")
      .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
      .join(".*");
  const body = toRegex(pat);
  const re = anchored || pat.includes("/")
    ? new RegExp(`^${body}(?:/.*)?$`)
    : new RegExp(`(?:^|/)${body}(?:/.*)?$`);
  if (dirOnly) {
    // Must match a directory: the path itself or something below it.
    return re.test(rel) && (rel === pat || rel.startsWith(`${pat}/`) || !anchored);
  }
  return re.test(rel);
}

function ignoredCandidates(workDir: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", workDir, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function walkFiles(root: string, cap: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) {
        out.push(p);
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/**
 * Apply the config to a freshly created worktree. Idempotent: an existing
 * target is skipped, never overwritten.
 */
export function prepareSessionWorktree(
  workDir: string,
  worktreePath: string,
  cfg: WorktreeSetupConfig = readWorktreeSetupConfig(workDir),
): WorktreeSetupReport {
  const report: WorktreeSetupReport = { symlinked: [], copied: [], skipped: [] };
  const root = resolve(workDir);
  const wt = resolve(worktreePath);

  // 1. Symlinks — only for directories that exist in the main checkout.
  const linked = new Set<string>();
  for (const dir of cfg.symlinkDirectories) {
    const source = join(root, dir);
    const target = join(wt, dir);
    try {
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        report.skipped.push({ path: dir, reason: "not a directory in the main checkout" });
        continue;
      }
      if (existsSync(target) || isLink(target)) {
        report.skipped.push({ path: dir, reason: "already present in the worktree" });
        linked.add(dir);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, "dir");
      report.symlinked.push(dir);
      linked.add(dir);
    } catch (err) {
      report.skipped.push({ path: dir, reason: `symlink failed: ${String((err as Error)?.message ?? err)}` });
    }
  }

  // 2. Copies — only files git ignores, matched by the configured patterns.
  const patterns = [...cfg.copyIgnored, ...(cfg.honorWorktreeInclude ? readWorktreeInclude(root) : [])];
  if (patterns.length === 0) return report;
  let files = 0;
  let bytes = 0;
  for (const candidate of ignoredCandidates(root)) {
    const rel = candidate.replace(/\/$/, "");
    if (linked.has(rel) || [...linked].some((l) => rel.startsWith(`${l}/`))) continue;
    if (!patterns.some((p) => matchesInclude(p, rel))) continue;
    const abs = join(root, rel);
    let paths: string[];
    try {
      paths = statSync(abs).isDirectory() ? walkFiles(abs, MAX_COPY_FILES - files) : [abs];
    } catch {
      continue;
    }
    for (const src of paths) {
      if (files >= MAX_COPY_FILES) {
        report.skipped.push({ path: relative(root, src), reason: `cap of ${MAX_COPY_FILES} files reached` });
        return report;
      }
      const relFile = relative(root, src);
      const dest = join(wt, relFile);
      try {
        const size = statSync(src).size;
        if (bytes + size > MAX_COPY_BYTES) {
          report.skipped.push({ path: relFile, reason: `cap of ${MAX_COPY_BYTES} bytes reached` });
          continue;
        }
        if (existsSync(dest)) {
          report.skipped.push({ path: relFile, reason: "already present in the worktree" });
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        files += 1;
        bytes += size;
        report.copied.push(relFile.split(sep).join(posix.sep));
      } catch (err) {
        report.skipped.push({ path: relFile, reason: `copy failed: ${String((err as Error)?.message ?? err)}` });
      }
    }
  }
  return report;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// `isAbsolute` is imported for symmetry with sibling modules; a config entry
// that is absolute is rejected by `safeRelative` before it gets here.
void isAbsolute;

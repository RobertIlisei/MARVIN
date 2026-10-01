/**
 * Numbered-file collisions across parallel worktrees.
 *
 * Many repositories number files in sequence inside one directory: ADRs
 * (`docs/adr/0491-…md`), Flyway / Liquibase / Rails migrations
 * (`V202610021010__…sql`, `0042_add_users.py`), RFCs. Each tab in its own
 * worktree picks "the next free number" from what *its* checkout can see, so
 * two tabs working at once pick the same one — and nobody notices until merge,
 * when Flyway refuses a duplicate version or two ADRs share a number. On
 * 2026-10-01/02 this happened eight times in one night on one project.
 *
 * Nothing here knows any project's conventions (Golden Rule 6): a "numbered
 * file" is any file whose name starts with an optional letter prefix and a run
 * of 3+ digits followed by a separator. Calendar-dated names
 * (`2026-10-01-notes.md`) are not sequence numbers and are ignored.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** `0491` from `0491-errors.md`, `V202610021010` from `V202610021010__x.sql`, else null. */
export function sequenceToken(path: string): string | null {
  const name = basename(path);
  if (/^\d{4}-\d{2}-\d{2}/.test(name)) return null; // a date, not a sequence
  const m = name.match(/^([A-Za-z]?)(\d{3,}(?:[._]\d+)*)(?=__|[-_.])/);
  if (!m) return null;
  return `${(m[1] ?? "").toUpperCase()}${m[2]}`;
}

export interface NumberedFile {
  /** Repo-relative path. */
  path: string;
  /** Where it was seen: a worktree path, or "base" for the integration branch. */
  where: string;
}

export interface Collision {
  mine: string;
  theirs: NumberedFile;
  /** A token one higher than every token seen in that directory, same width. */
  suggestion: string;
}

/**
 * Pure core: `mine` are files this commit adds; `others` are files added
 * elsewhere (sibling worktrees, the base branch). Two files collide when they
 * live in the same directory, carry the same sequence token, and are not the
 * same file.
 */
export function findCollisions(mine: string[], others: NumberedFile[]): Collision[] {
  const out: Collision[] = [];
  for (const m of mine) {
    const tok = sequenceToken(m);
    if (!tok) continue;
    const dir = dirname(m);
    const sameDir = others.filter((o) => dirname(o.path) === dir && sequenceToken(o.path) !== null);
    const clash = sameDir.find((o) => sequenceToken(o.path) === tok && basename(o.path) !== basename(m));
    if (!clash) continue;
    out.push({ mine: m, theirs: clash, suggestion: nextToken(tok, [...sameDir.map((o) => o.path), m]) });
  }
  return out;
}

function nextToken(tok: string, paths: string[]): string {
  const prefix = /^[A-Z]/.test(tok) ? tok[0] : "";
  const digits = (t: string): string => t.replace(/^[A-Z]/, "").split(/[._]/)[0] ?? "";
  let max = BigInt(digits(tok) || "0");
  for (const p of paths) {
    const t = sequenceToken(p);
    if (!t || (/^[A-Z]/.test(t) ? t[0] : "") !== prefix) continue;
    const d = digits(t);
    if (d && BigInt(d) > max) max = BigInt(d);
  }
  const width = digits(tok).length;
  return `${prefix}${(max + 1n).toString().padStart(width, "0")}`;
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Files added by the sibling worktrees of `cwd`'s repository (relative to each
 * worktree's merge-base with `cwd`'s HEAD, plus their uncommitted new files), and
 * the files the base branch already has in the directories `mine` touches.
 * Best-effort: any git failure yields an empty list, never a throw.
 */
export function collectNumberedElsewhere(cwd: string, mine: string[]): NumberedFile[] {
  const dirs = [...new Set(mine.filter((m) => sequenceToken(m)).map((m) => dirname(m)))];
  if (dirs.length === 0) return [];
  const git = (dir: string, args: string[]): string => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const out: NumberedFile[] = [];
  const self = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  // What this checkout's HEAD already contains in those directories.
  for (const d of dirs) {
    for (const p of lines(git(cwd, ["ls-tree", "--name-only", "HEAD", `${d}/`]))) out.push({ path: p, where: "HEAD" });
  }
  const porcelain = git(cwd, ["worktree", "list", "--porcelain"]);
  const trees = porcelain.split("\n\n").map((b) => b.match(/^worktree (.+)$/m)?.[1]).filter((p): p is string => !!p);
  for (const wt of trees) {
    if (wt === self) continue;
    const base = git(wt, ["merge-base", "HEAD", git(cwd, ["rev-parse", "HEAD"]).trim()]).trim();
    const added = base ? lines(git(wt, ["diff", "--name-only", "--diff-filter=A", `${base}`, "HEAD", "--", ...dirs])) : [];
    const pending = lines(git(wt, ["status", "--porcelain", "--untracked-files=all", "--", ...dirs]))
      .filter((l) => l.startsWith("A ") || l.startsWith("??") || l.startsWith("AM"))
      .map((l) => l.slice(3).trim());
    for (const p of [...added, ...pending]) out.push({ path: p, where: wt });
  }
  return out;
}

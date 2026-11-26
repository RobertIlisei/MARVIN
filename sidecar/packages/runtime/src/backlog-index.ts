/**
 * The backlog's closed index (ADR-0044 amendment, 2026-11-27).
 *
 * Item files never move: `.marvin/backlog/<slug>.md` is where an item lives from
 * the day it is filed to the day it is forgotten, open or closed. On a real
 * project that directory is TRACKED in git, so a migration that moved the 2,500
 * closed files would be 2,500 renames in a checkout MARVIN must not commit in
 * and the merge planner works from. Speed comes from an index instead:
 *
 *   `.marvin/backlog.md`            the OPEN index (open, doing, to-review) —
 *                                   human-readable, written by `backlog.ts`;
 *   `.marvin/backlog-closed.idx`    the CLOSED index (this file): one line per
 *                                   done / dismissed item, newest first.
 *
 * A reader of open work lstats the directory, trusts every closed file whose
 * (mtime, size) still matches its line, and reads only the rest — the open
 * items, and anything that changed. The Resolved tab pages through the closed
 * index and reads the files of one page. Same idea as the session list cache of
 * ADR-0072: a marker that is cheap to check, a full read only where it moved.
 *
 * **Git-ignored, deliberately.** The index records each file's mtime and size
 * so it can tell what changed; those differ on every machine and after every
 * checkout, so a tracked copy would be wrong on arrival and would dirty the
 * tree each time it was rebuilt. It is derived data, safe to delete (the next
 * read rebuilds it), and is kept out of `git status` through the repository's
 * own `info/exclude` — never the user's `.gitignore` — the way the worktrees
 * directory is. Its content is still deterministic (sorted newest first, then
 * by slug; nothing that changes on a read), so a copy someone commits does no
 * harm.
 *
 * It can be wrong only in one way — a file edited in place within the same
 * size and mtime tick — and is rebuilt whenever a line or a file disagrees.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const CLOSED_INDEX_FILE = "backlog-closed.idx";
const HEADER = "# MARVIN backlog closed index v1 — derived from .marvin/backlog/*.md, safe to delete.";
/** git-status exclusion; the glob also covers the temp name an interrupted write can leave. */
const EXCLUDE_PATTERN = `.marvin/${CLOSED_INDEX_FILE}*`;

export interface ClosedEntry {
  id: string;
  status: "done" | "dismissed";
  /** When the item was last written — for a closed item, when it was closed. Sorts the index. */
  updated: string;
  mtimeMs: number;
  size: number;
  title: string;
}

export interface StoreScan {
  /** Content of every file that is NOT closed (provisional / open / doing), by slug. */
  openFiles: Map<string, string>;
  /** Closed items, newest first. */
  closed: ClosedEntry[];
  counts: { done: number; dismissed: number };
}

function backlogDir(workDir: string): string {
  return join(workDir, ".marvin", "backlog");
}
function indexPath(workDir: string): string {
  return join(workDir, ".marvin", CLOSED_INDEX_FILE);
}

/** Same first-match, horizontal-whitespace-only reading as `backlog.ts` `parseField`, on the frontmatter. */
function fmField(content: string, name: string): string {
  const end = content.indexOf("\n---", 3);
  const fm = end >= 0 ? content.slice(0, end) : content;
  return new RegExp(`^${name}:[^\\S\\n]*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
}

function oneLine(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

function newestFirst(a: ClosedEntry, b: ClosedEntry): number {
  return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function serializeClosedIndex(entries: Iterable<ClosedEntry>): string {
  const lines = [...entries].sort(newestFirst).map((e) => [e.status, e.id, e.updated, e.mtimeMs, e.size, oneLine(e.title)].join("\t"));
  return `${HEADER}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

export function parseClosedIndex(text: string): Map<string, ClosedEntry> {
  const out = new Map<string, ClosedEntry>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [status, id, updated, mtime, size, ...title] = line.split("\t");
    if ((status !== "done" && status !== "dismissed") || !id || updated === undefined) continue;
    const mtimeMs = Number(mtime);
    const sz = Number(size);
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(sz)) continue;
    out.set(id, { id, status, updated, mtimeMs, size: sz, title: title.join("\t") });
  }
  return out;
}

async function readIndex(workDir: string): Promise<{ text: string; entries: Map<string, ClosedEntry> } | null> {
  try {
    const text = await readFile(indexPath(workDir), "utf-8");
    return { text, entries: parseClosedIndex(text) };
  } catch {
    return null;
  }
}

const excluded = new Set<string>();

/** Keep the index out of `git status` without touching the project's `.gitignore` (the worktrees directory's precedent). Best-effort, once per process. */
function ensureExcluded(workDir: string): void {
  if (excluded.has(workDir)) return;
  excluded.add(workDir);
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: workDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const exclude = join(isAbsolute(gitDir) ? gitDir : join(workDir, gitDir), "info", "exclude");
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
    if (existing.split("\n").includes(EXCLUDE_PATTERN)) return;
    mkdirSync(join(exclude, ".."), { recursive: true });
    appendFileSync(exclude, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${EXCLUDE_PATTERN}\n`);
  } catch {
    /* not a repository, or no git: nothing to keep clean */
  }
}

/** Write the index only when its text changed; atomically, so a second session never reads half of it. */
async function writeIndex(workDir: string, entries: Iterable<ClosedEntry>, previousText: string | null): Promise<void> {
  const text = serializeClosedIndex(entries);
  if (text === previousText) return;
  try {
    ensureExcluded(workDir);
    // A random suffix per write: two scans in one process (or two sessions) must not share a temp file.
    const tmp = `${indexPath(workDir)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, text, "utf-8");
    await rename(tmp, indexPath(workDir));
  } catch {
    /* a cache that cannot be written is only slower */
  }
}

/**
 * Read the store: which items are closed (from the index, validated against the
 * files) and the content of every other one. Rebuilds the index when it is
 * missing or any line disagrees with a file.
 */
export async function scanStore(workDir: string): Promise<StoreScan> {
  const dir = backlogDir(workDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return { openFiles: new Map(), closed: [], counts: { done: 0, dismissed: 0 } };
  }
  const prior = await readIndex(workDir);
  const known = prior?.entries ?? new Map<string, ClosedEntry>();
  const closed = new Map<string, ClosedEntry>();
  const openFiles = new Map<string, string>();

  const readOne = async (id: string): Promise<void> => {
    const path = join(dir, `${id}.md`);
    try {
      const st = await lstat(path); // a symlink or a directory is not an item (REVIEW.md: project-controlled input)
      if (!st.isFile()) return;
      const content = await readFile(path, "utf-8");
      const status = fmField(content, "status");
      if (status === "done" || status === "dismissed") {
        closed.set(id, { id, status, updated: fmField(content, "updated"), mtimeMs: st.mtimeMs, size: st.size, title: oneLine(fmField(content, "title") || id) });
      } else {
        openFiles.set(id, content);
      }
    } catch {
      /* vanished or unreadable between readdir and read */
    }
  };

  const BATCH = 64;
  for (let i = 0; i < names.length; i += BATCH) {
    await Promise.all(
      names.slice(i, i + BATCH).map(async (name) => {
        const id = name.slice(0, -3);
        const entry = known.get(id);
        if (entry) {
          try {
            const st = await lstat(join(dir, name));
            if (st.isFile() && st.mtimeMs === entry.mtimeMs && st.size === entry.size) {
              closed.set(id, entry);
              return;
            }
          } catch {
            return;
          }
        }
        await readOne(id);
      }),
    );
  }

  // Missing, or any line gone / changed / new: write it again. An unchanged
  // index is not rewritten, so a read does not touch the disk.
  await writeIndex(workDir, closed.values(), prior?.text ?? null);

  const sorted = [...closed.values()].sort(newestFirst);
  let done = 0;
  for (const e of sorted) if (e.status === "done") done += 1;
  return { openFiles, closed: sorted, counts: { done, dismissed: sorted.length - done } };
}

/**
 * After the store wrote an item: keep the index in step without a rescan. A
 * closed item gets a line (from the file as written), anything else loses its
 * line. No index yet means nothing to keep in step — the next read builds it.
 */
export async function noteItemWritten(workDir: string, id: string, status: string, updated: string, title: string): Promise<void> {
  const prior = await readIndex(workDir);
  if (!prior) return;
  const entries = prior.entries;
  if (status === "done" || status === "dismissed") {
    try {
      const st = await lstat(join(backlogDir(workDir), `${id}.md`));
      entries.set(id, { id, status, updated, mtimeMs: st.mtimeMs, size: st.size, title: oneLine(title || id) });
    } catch {
      entries.delete(id);
    }
  } else {
    entries.delete(id);
  }
  await writeIndex(workDir, entries.values(), prior.text);
}

/** Tests: forget which projects this process already excluded. */
export function resetClosedIndexCacheForTests(): void {
  excluded.clear();
}

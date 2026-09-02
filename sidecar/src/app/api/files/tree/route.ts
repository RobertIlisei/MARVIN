import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { IGNORE_DIR_NAMES, isGraphifyCacheDir, isMarvinScratchDir } from "@marvin/tools/fs-constants";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

// Walk depth cap. 10 accommodates typical large monorepos; overridable at
// runtime via `MARVIN_TREE_MAX_DEPTH`.
const DEFAULT_MAX_DEPTH = Number(process.env.MARVIN_TREE_MAX_DEPTH) || 10;

// ## The entry cap is OFF by default (2026-09-01)
//
// It was 20,000, and the previous note here said: "If your repo starts hitting
// 20000 routinely, the architectural answer is lazy-load-on-expand, not a
// bigger global cap." That advice was right about the remedy and wrong about
// the diagnosis, three times running.
//
// Every time the cap actually fired on a real project, the cause was not a big
// repo. It was a directory of machine-generated bulk that MARVIN itself had
// written into the project: graphify's extraction cache (12,195 files,
// 2026-08-15), its Obsidian export (34,463 files, 2026-08-30), and
// `.marvin/worktrees/` — full checkouts of the repository, nested inside the
// repository (49,304 files, 2026-09-01, against ~9,000 files of actual
// source). Each was fixed by not walking it. The cap never protected anyone
// from a pathological walk; it converted one into a silent "Tree truncated"
// banner while the user's own `apps/` and `docs/` fell off the end, which is
// strictly worse than being slow.
//
// So the default ceiling is gone. `MARVIN_TREE_MAX_ENTRIES` still sets one for
// anyone who wants it — it is now opt-in rather than a limit you discover by
// losing your source tree. Lazy-load-on-expand remains the right answer for a
// genuinely enormous repo and is still unbuilt; this makes the common case
// correct instead of trading it against a case nobody has hit.
const MAX_ENTRIES = Number(process.env.MARVIN_TREE_MAX_ENTRIES) || Number.POSITIVE_INFINITY;

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const depth = Number(req.nextUrl.searchParams.get("depth") ?? DEFAULT_MAX_DEPTH);
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }

  const check = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    const status =
      check.error === "not-found"
        ? 404
        : check.error === "is-directory" || check.error === "not-a-directory"
          ? 400
          : check.error === "symlink-rejected" ||
              check.error === "symlink-escapes-cwd" ||
              check.error === "path-escapes-cwd"
            ? 400
            : 500;
    return NextResponse.json({ error: check.error }, { status });
  }
  if (!check.isDirectory) {
    return NextResponse.json({ error: "not a directory" }, { status: 400 });
  }
  const root = check.absolutePath;

  let count = 0;
  async function walk(dir: string, d: number): Promise<TreeNode[]> {
    if (d > depth || count >= MAX_ENTRIES) return [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (count >= MAX_ENTRIES) break;
      if (IGNORE_DIR_NAMES.has(e.name)) continue;
      // graphify-out is shown; only its extraction cache is skipped.
      if (e.isDirectory() && isGraphifyCacheDir(path.basename(dir), e.name)) continue;
      // .marvin is shown — plans / memory / backlog are things people open.
      // Its worktrees are full copies of this same repo; walking them is how
      // the tree grew to 54,000 entries on a 9,000-file project.
      if (e.isDirectory() && isMarvinScratchDir(path.basename(dir), e.name)) continue;
      // Skip symlinks during the walk — matches the sandbox helper's
      // reject-symlink policy (see ADR-0008). A symlink named `cache`
      // pointing to /tmp would otherwise leak into the tree UI.
      if (e.isSymbolicLink()) continue;
      const fullPath = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) {
        out.push({
          name: e.name,
          path: fullPath,
          type: "dir",
          children: await walk(fullPath, d + 1),
        });
      } else if (e.isFile()) {
        out.push({ name: e.name, path: fullPath, type: "file" });
      }
    }
    return out;
  }

  const tree = await walk(root, 0);
  return NextResponse.json({
    root,
    tree,
    truncated: count >= MAX_ENTRIES,
    count,
  });
}

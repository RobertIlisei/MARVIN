import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { IGNORE_DIR_NAMES } from "@marvin/tools/fs-constants";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

const DEFAULT_MAX_DEPTH = 6;
const MAX_ENTRIES = 2000;

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
    let entries;
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

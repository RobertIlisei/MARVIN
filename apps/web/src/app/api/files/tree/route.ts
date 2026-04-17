import { promises as fs } from "node:fs";
import path from "node:path";

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

const IGNORE = new Set([
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

const DEFAULT_MAX_DEPTH = 6;
const MAX_ENTRIES = 2000;

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const depth = Number(req.nextUrl.searchParams.get("depth") ?? DEFAULT_MAX_DEPTH);
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const root = path.resolve(cwd);
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "path not found" }, { status: 404 });
  }

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
      if (IGNORE.has(e.name)) continue;
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

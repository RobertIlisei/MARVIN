import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 512 * 1024;

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const file = req.nextUrl.searchParams.get("path");
  if (!cwd || !file) {
    return NextResponse.json(
      { error: "cwd and path required" },
      { status: 400 },
    );
  }

  const check = await checkFsPath({ cwd, target: file, mustExist: true });
  if (!check.ok) {
    const status =
      check.error === "not-found"
        ? 404
        : check.error === "path-escapes-cwd" ||
            check.error === "symlink-rejected" ||
            check.error === "symlink-escapes-cwd"
          ? 400
          : check.error === "is-directory"
            ? 400
            : 500;
    return NextResponse.json({ error: check.error }, { status });
  }
  const target = check.absolutePath;

  try {
    const stat = await fs.stat(target);
    if (stat.size > MAX_SIZE) {
      return NextResponse.json(
        {
          path: target,
          size: stat.size,
          maxSize: MAX_SIZE,
          binary: false,
          truncated: true,
          content: null,
        },
        { status: 200 },
      );
    }
    const buf = await fs.readFile(target);
    const sample = buf.subarray(0, Math.min(4096, buf.length));
    let nonPrint = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i]!;
      if (c === 0) {
        nonPrint = sample.length;
        break;
      }
      if (c < 9 || (c > 13 && c < 32)) nonPrint++;
    }
    const binary = sample.length > 0 && nonPrint / sample.length > 0.3;
    if (binary) {
      return NextResponse.json({
        path: target,
        size: stat.size,
        binary: true,
        truncated: false,
        content: null,
      });
    }
    return NextResponse.json({
      path: target,
      size: stat.size,
      binary: false,
      truncated: false,
      content: buf.toString("utf8"),
    });
  } catch {
    return NextResponse.json({ error: "failed to read" }, { status: 500 });
  }
}

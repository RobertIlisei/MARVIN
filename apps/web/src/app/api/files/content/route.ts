import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap for the in-editor preview. Files up to this size are fully loaded;
// larger files are read up to the cap and returned with `truncated: true`
// so the editor can render them read-only (save is disabled). The cap
// balances Monaco's performance envelope against real-world generated
// artefacts (lockfiles, minified bundles, etc.) that are legitimately
// > 1 MB but still worth scanning.
const MAX_SIZE = 4 * 1024 * 1024;

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
    const truncated = stat.size > MAX_SIZE;
    const readSize = truncated ? MAX_SIZE : stat.size;
    const fh = await fs.open(target, "r");
    let buf: Buffer;
    try {
      const holder = Buffer.alloc(readSize);
      if (readSize > 0) await fh.read(holder, 0, readSize, 0);
      buf = holder;
    } finally {
      await fh.close();
    }
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
        mtime: stat.mtimeMs,
        maxSize: MAX_SIZE,
        binary: true,
        truncated,
        content: null,
      });
    }
    return NextResponse.json({
      path: target,
      size: stat.size,
      mtime: stat.mtimeMs,
      maxSize: MAX_SIZE,
      binary: false,
      truncated,
      // For truncated files we still ship the first MAX_SIZE bytes so
      // the editor can mount in read-only mode. Save is disabled client-
      // side when `truncated: true` — prevents the "overwrite a 10 MB
      // file with 4 MB" data-loss scenario.
      content: buf.toString("utf8"),
    });
  } catch {
    return NextResponse.json({ error: "failed to read" }, { status: 500 });
  }
}

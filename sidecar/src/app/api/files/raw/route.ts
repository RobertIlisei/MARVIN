/**
 * GET /api/files/raw?cwd=…&path=…
 *
 * Stream the raw bytes of a sandbox'd file back to the browser with a
 * best-effort `Content-Type`. Used by the binary-file preview (images /
 * PDFs) embedded in `file-viewer.tsx`. Text files should continue to
 * go through `/api/files/content` so the editor gets its binary +
 * truncation metadata in JSON.
 *
 * Cap: 10 MB. Anything larger returns 413 `too-large` rather than
 * streaming gigabytes through Next's handler.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  heic: "image/heic",
  pdf: "application/pdf",
};

function mimeFor(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const target = req.nextUrl.searchParams.get("path");
  if (!cwd || !target) {
    return NextResponse.json({ error: "cwd and path required" }, { status: 400 });
  }
  const check = await checkFsPath({
    cwd,
    target,
    mustExist: true,
    allowDirectory: false,
  });
  if (!check.ok) {
    const status =
      check.error === "not-found"
        ? 404
        : check.error === "io-error"
          ? 500
          : 400;
    return NextResponse.json({ error: check.error }, { status });
  }
  const mime = mimeFor(check.absolutePath);
  if (!mime) {
    // Don't serve arbitrary octet-streams — only the previewable types
    // we have renderers for. Keeps this route out of the "mystery bytes
    // back to the browser" business.
    return NextResponse.json(
      { error: "unsupported-mime" },
      { status: 415 },
    );
  }
  try {
    const stat = await fs.stat(check.absolutePath);
    if (stat.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "too-large", size: stat.size, cap: MAX_BYTES },
        { status: 413 },
      );
    }
    const buf = await fs.readFile(check.absolutePath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(stat.size),
        "Cache-Control": "private, max-age=30",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

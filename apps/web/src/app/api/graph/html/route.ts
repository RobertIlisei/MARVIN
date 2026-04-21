/**
 * GET /api/graph/html?cwd=<path>
 *
 * Returns the raw `graphify-out/graph.html` generated for the given
 * project workDir. Mounted in an <iframe> by `GraphPanel` so the user
 * can see the full interactive graph visualisation alongside the text
 * summary.
 *
 * Path is sandboxed via `checkFsPath`. Response is cached for 60s so
 * repeated iframe reloads are cheap; the graph is regenerated on
 * milestone commits, not per-turn.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_HTML_BYTES = 4 * 1024 * 1024; // 4 MB — pyvis/cytoscape outputs stay well under this

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const cwdCheck = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.error }, { status: 400 });
  }
  const htmlPath = path.join(cwdCheck.absolutePath, "graphify-out", "graph.html");
  const htmlCheck = await checkFsPath({
    cwd: cwdCheck.absolutePath,
    target: htmlPath,
    mustExist: true,
    allowDirectory: false,
  });
  if (!htmlCheck.ok) {
    return NextResponse.json(
      {
        error: "graph-html-missing",
        hint: "run `/graphify .` in this project to generate graphify-out/graph.html",
      },
      { status: 404 },
    );
  }
  try {
    const stat = await fs.stat(htmlCheck.absolutePath);
    if (stat.size > MAX_HTML_BYTES) {
      return NextResponse.json(
        { error: "html-too-large", size: stat.size, cap: MAX_HTML_BYTES },
        { status: 413 },
      );
    }
    const buf = await fs.readFile(htmlCheck.absolutePath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

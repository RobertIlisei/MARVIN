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
 *
 * ### Security — CSP sandbox
 *
 * The HTML body is produced by graphify and lives under the project's
 * `graphify-out/`. It ships with JS that does zoom / pan interaction.
 * Because the file sits inside the user's repo, a malicious PR could
 * in principle land a `graph.html` with injected scripts that hit
 * MARVIN's own API (same-origin `fetch`) — a confused-deputy attack:
 * the reviewer opens the graph panel, their browser runs the
 * attacker's JS with same-origin privileges, and MARVIN executes
 * whatever state change the script requests.
 *
 * Mitigations, layered:
 *
 *   1. `Content-Security-Policy: sandbox allow-scripts` — puts the
 *      iframe in a unique null origin. Its scripts still run (so
 *      zoom / pan keep working), but any `fetch` it makes is
 *      cross-origin. Combined with the CSRF guard on MARVIN's
 *      mutating routes, same-origin API access is no longer
 *      available to the iframe's JS.
 *   2. `X-Content-Type-Options: nosniff` — browsers must treat the
 *      response as `text/html` and not reinterpret it as a script
 *      bundle or other MIME type.
 *   3. `X-Frame-Options: SAMEORIGIN` — this response itself cannot
 *      be framed by pages at other origins. Prevents a drive-by
 *      from embedding the iframe and proxying clicks through it.
 *
 * Note we deliberately do NOT add `allow-same-origin`. That would
 * defeat the whole point — the iframe would regain same-origin
 * privileges and this mitigation would be cosmetic.
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
        // See the file-level header comment for the threat model these
        // three headers close. Tightening them further (e.g. dropping
        // `allow-scripts`) would break the interactive graph viz, so
        // CSRF on MARVIN's mutation routes is the necessary partner
        // to these headers, not a replacement.
        "Content-Security-Policy": "sandbox allow-scripts",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

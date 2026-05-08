/**
 * POST /api/files/reveal
 *
 * Reveal a file or directory in the OS file browser.
 *   - macOS: `open -R <path>` (Finder)
 *   - Linux: `xdg-open <parentDir>` (no recipe for "select" across all
 *     file managers; opening the parent directory is the pragmatic fallback)
 *   - Windows: `explorer /select,<path>` (same contract as macOS)
 *
 * Not a write channel — doesn't mutate files — but it does spawn a
 * subprocess against a user-supplied path, so we still gate with
 * `checkFsPath` and pass the canonical path as a positional argv entry
 * (no shell interpolation).
 */

import { spawn } from "node:child_process";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RevealRequestBody {
  cwd?: unknown;
  path?: unknown;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: RevealRequestBody;
  try {
    body = (await req.json()) as RevealRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const target = typeof body.path === "string" ? body.path : null;
  if (!cwd || !target) {
    return NextResponse.json({ error: "cwd and path required" }, { status: 400 });
  }

  const check = await checkFsPath({
    cwd,
    target,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = ["-R", check.absolutePath];
  } else if (platform === "win32") {
    cmd = "explorer";
    args = [`/select,${check.absolutePath}`];
  } else {
    // xdg-open has no universal "select" — open the containing directory.
    cmd = "xdg-open";
    const parent = check.isDirectory
      ? check.absolutePath
      : check.absolutePath.replace(/\/[^/]+$/, "");
    args = [parent];
  }

  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return NextResponse.json({ ok: true, platform, revealed: check.absolutePath });
  } catch (e) {
    return NextResponse.json(
      { error: "spawn-failed", detail: String(e) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/git/diff?cwd=&path=&mode=working|staged|head
 *
 * Per-file diff for the Source Control panel's middle-panel viewer.
 *
 * Three diff modes:
 *   - `working` (default): `git diff -- <path>` — working tree vs index.
 *   - `staged`: `git diff --cached -- <path>` — index vs HEAD.
 *   - `head`: `git diff HEAD -- <path>` — combined (working tree vs HEAD).
 *
 * Returns `{ diff, binary, truncated }` — never the raw bytes. 2 MB
 * cap on the diff payload; larger renders read-only in the viewer
 * with a "diff too large" affordance.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafePathspec, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

type DiffMode = "working" | "staged" | "head";

function parseMode(raw: string | null): DiffMode {
  if (raw === "staged" || raw === "head") return raw;
  return "working";
}

function diffArgs(mode: DiffMode, path: string): string[] {
  switch (mode) {
    case "staged":
      return ["diff", "--cached", "--no-color", "--", path];
    case "head":
      return ["diff", "HEAD", "--no-color", "--", path];
    default:
      return ["diff", "--no-color", "--", path];
  }
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const relPath = req.nextUrl.searchParams.get("path");
  const mode = parseMode(req.nextUrl.searchParams.get("mode"));

  if (!cwd || !relPath) {
    return NextResponse.json(
      { error: "cwd and path required" },
      { status: 400 },
    );
  }
  if (!isSafePathspec(relPath)) {
    return NextResponse.json({ error: "invalid-pathspec" }, { status: 400 });
  }

  const sandbox = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!sandbox.ok || !sandbox.isDirectory) {
    return NextResponse.json(
      { error: sandbox.ok ? "cwd is not a directory" : sandbox.error },
      { status: 400 },
    );
  }
  const root = sandbox.absolutePath;

  // Binary probe first — for a binary file `git diff` emits "Binary files
  // a/foo and b/foo differ" and we want to surface that as a discrete
  // flag so the viewer renders a binary placeholder instead of trying
  // to shove it into Monaco.
  const numstat = await runGit(
    root,
    ["diff", ...(mode === "staged" ? ["--cached"] : mode === "head" ? ["HEAD"] : []), "--numstat", "--", relPath],
    { timeoutMs: 5000 },
  );
  let binary = false;
  if (numstat.ok) {
    // numstat lines: "<added>\t<deleted>\t<path>". "-\t-" → binary.
    const firstLine = numstat.stdout.split("\n").find((l) => l.trim().length > 0);
    if (firstLine?.startsWith("-\t-\t")) binary = true;
  }

  if (binary) {
    return NextResponse.json({
      path: relPath,
      mode,
      diff: "",
      binary: true,
      truncated: false,
    });
  }

  const diff = await runGit(root, diffArgs(mode, relPath), { timeoutMs: 10_000 });
  if (!diff.ok) {
    // Non-zero exit with stderr is a real failure (bad ref, corrupt
    // repo). Buffer-overflow we surface as `truncated: true` with an
    // empty body — the viewer knows how to handle that.
    if (diff.error === "buffer-overflow") {
      return NextResponse.json({
        path: relPath,
        mode,
        diff: "",
        binary: false,
        truncated: true,
      });
    }
    return NextResponse.json(
      {
        error: diff.error,
        detail: "stderr" in diff ? diff.stderr : diff.detail,
      },
      { status: 502 },
    );
  }

  const bytes = Buffer.byteLength(diff.stdout, "utf8");
  const truncated = bytes > MAX_DIFF_BYTES;
  return NextResponse.json({
    path: relPath,
    mode,
    diff: truncated ? "" : diff.stdout,
    binary: false,
    truncated,
  });
}

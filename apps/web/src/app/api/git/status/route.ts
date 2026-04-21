/**
 * GET /api/git/status?cwd=…
 *
 * Returns the Source Control panel's primary feed: branch metadata +
 * per-file status, parsed from `git status --porcelain=v2 --branch -z`.
 *
 * Shape is stable; see `parsePorcelainV2` in `@marvin/git` for the
 * exact field semantics. `enabled: false` is returned when cwd is
 * outside a git worktree so the panel can render the empty state
 * without a second round-trip.
 *
 * Read route, no mutations — no policy / confirm gate needed. The
 * sandbox anchor still runs because `checkFsPath` rejects symlink
 * escapes and NUL-bearing paths even on reads.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { parsePorcelainV2, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
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

  // `rev-parse --is-inside-work-tree` is the canonical "am I in a git
  // repo" probe. 2s cap — if git isn't installed or the path is a
  // gigantic mount point, fail fast to the empty state rather than
  // hold the poll.
  const probe = await runGit(
    root,
    ["rev-parse", "--is-inside-work-tree"],
    { timeoutMs: 2000 },
  );
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }

  const status = await runGit(
    root,
    ["status", "--porcelain=v2", "--branch", "-z"],
    { timeoutMs: 5000 },
  );
  if (!status.ok) {
    return NextResponse.json(
      {
        enabled: true,
        error: status.error,
        detail: "stderr" in status ? status.stderr : status.detail,
      },
      { status: 502 },
    );
  }

  const parsed = parsePorcelainV2(status.stdout);
  return NextResponse.json({ enabled: true, ...parsed });
}

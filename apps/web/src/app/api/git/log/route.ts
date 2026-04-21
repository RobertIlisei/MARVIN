/**
 * GET /api/git/log?cwd=&limit=50&path?=
 *
 * Recent commits for the history view. When `path` is present, the
 * log is filtered to commits touching that file. Format is a
 * stable `%00`-delimited key so messages containing `|` / tabs /
 * newlines parse cleanly.
 *
 * Hard cap `limit` to 500 — the UI paginates rather than reading
 * more in one shot.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafePathspec, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const LOG_FMT =
  "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s";

interface LogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = clampLimit(limitRaw);
  const relPath = req.nextUrl.searchParams.get("path");
  if (relPath !== null && !isSafePathspec(relPath)) {
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

  const probe = await runGit(
    root,
    ["rev-parse", "--is-inside-work-tree"],
    { timeoutMs: 2000 },
  );
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }

  const argv = [
    "log",
    `-n${limit}`,
    `--pretty=format:${LOG_FMT}`,
    "--no-color",
  ];
  if (relPath) argv.push("--", relPath);

  const res = await runGit(root, argv, { timeoutMs: 8000 });
  if (!res.ok) {
    // Fresh repo with no commits yet → `fatal: your current branch
    // 'main' does not have any commits yet`. Surface as empty list,
    // not an error.
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    if (stderr.includes("does not have any commits")) {
      return NextResponse.json({ enabled: true, commits: [] });
    }
    return NextResponse.json(
      {
        enabled: true,
        error: res.error,
        detail: "stderr" in res ? res.stderr : res.detail,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ enabled: true, commits: parseLog(res.stdout) });
}

function parseLog(raw: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    const [sha, shortSha, author, email, date, subject] = parts;
    if (!sha || !shortSha) continue;
    out.push({
      sha,
      shortSha,
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      subject: subject ?? "",
    });
  }
  return out;
}

function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

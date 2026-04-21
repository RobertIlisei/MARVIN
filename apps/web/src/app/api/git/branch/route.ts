/**
 * GET /api/git/branch?cwd=…
 *
 * Returns the current branch + the full local + remote branch lists
 * for the Source Control panel's branch switcher (M3 wires the
 * switcher; M2 ships the read).
 *
 * Each entry: `{ name, isCurrent, upstream?, ahead?, behind? }`.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BranchEntry {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

interface BranchResponse {
  enabled: true;
  current: string | null;
  locals: BranchEntry[];
  remotes: string[];
}

// `%00` produces a literal NUL byte in the format string output; using
// it as the field separator keeps branch names containing `|` / spaces
// / unicode safe to parse.
const LOCAL_FMT =
  "%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)";
const REMOTE_FMT = "%(refname:short)";

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

  const probe = await runGit(
    root,
    ["rev-parse", "--is-inside-work-tree"],
    { timeoutMs: 2000 },
  );
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }

  const [locals, remotes, head] = await Promise.all([
    runGit(
      root,
      ["for-each-ref", "--format", LOCAL_FMT, "refs/heads/"],
      { timeoutMs: 3000 },
    ),
    runGit(
      root,
      ["for-each-ref", "--format", REMOTE_FMT, "refs/remotes/"],
      { timeoutMs: 3000 },
    ),
    runGit(
      root,
      ["symbolic-ref", "--short", "HEAD"],
      { timeoutMs: 1000 },
    ),
  ]);

  if (!locals.ok) {
    return NextResponse.json(
      { enabled: true, error: "list-locals-failed" },
      { status: 502 },
    );
  }

  const body: BranchResponse = {
    enabled: true,
    current: head.ok ? head.stdout.trim() || null : null,
    locals: parseLocals(locals.stdout),
    remotes: remotes.ok ? parseRemotes(remotes.stdout) : [],
  };
  return NextResponse.json(body);
}

function parseLocals(raw: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name, headMark, upstream, track] = line.split("\0");
    if (!name) continue;
    const ab = parseAheadBehind(track ?? "");
    out.push({
      name,
      isCurrent: headMark === "*",
      upstream: upstream ? upstream : null,
      ahead: ab.ahead,
      behind: ab.behind,
    });
  }
  return out;
}

/** Parse `[ahead N, behind M]` / `[ahead N]` / `[behind M]` / `[gone]`. */
function parseAheadBehind(track: string): {
  ahead: number | null;
  behind: number | null;
} {
  if (!track || track === "[gone]") return { ahead: null, behind: null };
  const aheadMatch = /ahead (\d+)/.exec(track);
  const behindMatch = /behind (\d+)/.exec(track);
  return {
    ahead: aheadMatch?.[1] ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

function parseRemotes(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

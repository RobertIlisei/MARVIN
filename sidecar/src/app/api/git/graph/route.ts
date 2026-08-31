/**
 * GET /api/git/graph?cwd=&limit=100&all=1
 *
 * The commit DAG behind the Source Control panel's Graph section:
 * every commit's sha, parents, ref decorations and author, newest
 * first in `--topo-order` so a renderer can lay out lanes without
 * re-sorting.
 *
 * Distinct from `/api/git/log`, which is a flat list for the file
 * history popover and deliberately carries no parent/ref columns. The
 * graph needs BOTH — parents are what draw the merge lines, and `%D`
 * is what puts the `main` / `origin/main` / tag chips on a row. Adding
 * them to `/log` would make every history popover pay for data it
 * never renders.
 *
 * `all=1` (the default) walks every ref, not just HEAD — a graph that
 * only shows the current branch can't show it merging into anything.
 *
 * Read-only: no policy gate, same as `/log` and `/status`.
 */

import { runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const GRAPH_FMT = [
  "%H",
  "%h",
  "%an",
  "%aI",
  "%cr",
  "%D",
  "%P",
  "%s",
].join("%x00");

interface GraphCommit {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  /** git's relative rendering — "4 days ago". */
  relativeDate: string;
  /** Ref decorations: `main`, `origin/main`, `tag: v1.2.0`, `HEAD`. */
  refs: string[];
  /** Full shas of this commit's parents; length > 1 means a merge. */
  parents: string[];
  subject: string;
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const limit = clampLimit(req.nextUrl.searchParams.get("limit"));
  const all = req.nextUrl.searchParams.get("all") !== "0";

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

  const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"], {
    timeoutMs: 2000,
  });
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }

  const argv = [
    "log",
    `-n${limit}`,
    "--topo-order",
    "--date-order",
    `--pretty=format:${GRAPH_FMT}`,
    "--no-color",
  ];
  if (all) argv.push("--all");

  const res = await runGit(root, argv, { timeoutMs: 10_000 });
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    // Fresh repo, no commits yet — an empty graph, not an error.
    if (
      stderr.includes("does not have any commits") ||
      stderr.includes("bad default revision")
    ) {
      return NextResponse.json({ enabled: true, commits: [] });
    }
    return NextResponse.json(
      {
        enabled: true,
        error: res.error,
        detail: stderr || res.detail,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ enabled: true, commits: parse(res.stdout) });
}

function parse(raw: string): GraphCommit[] {
  const out: GraphCommit[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [sha, shortSha, author, date, relativeDate, refs, parents, subject] =
      line.split("\0");
    if (!sha || !shortSha) continue;
    out.push({
      sha,
      shortSha,
      author: author ?? "",
      date: date ?? "",
      relativeDate: relativeDate ?? "",
      refs: parseRefs(refs ?? ""),
      parents: (parents ?? "").split(" ").filter(Boolean),
      subject: subject ?? "",
    });
  }
  return out;
}

/**
 * `%D` renders as `HEAD -> main, origin/main, tag: v1.2.0`. Splitting
 * on `, ` and unwrapping the `HEAD -> ` arrow gives one chip per ref,
 * which is what the row renders; keeping the raw string would make the
 * client re-parse the same thing.
 */
function parseRefs(raw: string): string[] {
  if (!raw.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(", ")) {
    const ref = part.trim();
    if (!ref) continue;
    // `origin/HEAD` is a symbolic pointer at the remote's default
    // branch — it always duplicates the `origin/main` chip sitting
    // next to it, so it is pure noise on the row.
    if (ref.endsWith("/HEAD")) continue;
    const arrow = ref.indexOf(" -> ");
    if (arrow >= 0) {
      // "HEAD -> main" is two refs pointing at this commit, and the
      // panel wants to show both.
      out.push(ref.slice(0, arrow).trim());
      out.push(ref.slice(arrow + 4).trim());
    } else {
      out.push(ref);
    }
  }
  return out;
}

function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

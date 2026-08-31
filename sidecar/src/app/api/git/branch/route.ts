/**
 * GET /api/git/branch?cwd=…
 *
 * Everything the branch picker needs in one round trip: the current
 * branch, every local branch with its upstream / ahead-behind / last
 * commit, the remote-tracking refs, and the tags.
 *
 * The per-branch last-commit line (`sha · author · subject · relative
 * date`) is what makes the picker usable — a list of bare names gives
 * the user no way to tell `fix/adr0363-followups` from
 * `fix/adr0367-catalog-acl-regression` at a glance. `for-each-ref`
 * resolves it for every ref in ONE process; the obvious alternative
 * (one `git log -1` per branch) is N spawns for the same data.
 *
 * Sorted by commit date, newest first — recency is the only ordering
 * that puts the branch you actually want near the top on a repo with
 * fifty of them.
 *
 * Each entry: `{ name, isCurrent, upstream?, ahead?, behind?, … }`.
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
  /** Abbreviated sha of the commit the ref points at. */
  sha: string | null;
  author: string | null;
  /** `git`'s own relative rendering — "47 minutes ago". */
  relativeDate: string | null;
  subject: string | null;
}

interface RefEntry {
  name: string;
  sha: string | null;
  author: string | null;
  relativeDate: string | null;
  subject: string | null;
}

interface BranchResponse {
  enabled: true;
  current: string | null;
  /** True when HEAD is not on any branch (`git switch --detach`). */
  detached: boolean;
  locals: BranchEntry[];
  remotes: RefEntry[];
  tags: RefEntry[];
}

// `%00` produces a literal NUL byte in the format string output; using
// it as the field separator keeps branch names containing `|` / spaces
// / unicode safe to parse.
//
// `*` prefixes deref the TAG's target commit rather than the tag object
// itself, so an annotated tag reports its commit's author/subject like
// a lightweight one does. On a commit ref the deref fields are empty,
// which is why the tag parser falls back to the non-deref column.
const LOCAL_FMT = [
  "%(refname:short)",
  "%(HEAD)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(objectname:short)",
  "%(authorname)",
  "%(committerdate:relative)",
  "%(contents:subject)",
].join("%00");

const REF_FMT = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname:short)",
  "%(authorname)%00%(*authorname)",
  "%(committerdate:relative)%00%(*committerdate:relative)",
  "%(contents:subject)%00%(*contents:subject)",
].join("%00");

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

  const [locals, remotes, tags, head] = await Promise.all([
    runGit(
      root,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format",
        LOCAL_FMT,
        "refs/heads/",
      ],
      { timeoutMs: 5000 },
    ),
    runGit(
      root,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format",
        REF_FMT,
        "refs/remotes/",
      ],
      { timeoutMs: 5000 },
    ),
    runGit(
      root,
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format",
        REF_FMT,
        "refs/tags/",
      ],
      { timeoutMs: 5000 },
    ),
    runGit(root, ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 1000 }),
  ]);

  if (!locals.ok) {
    return NextResponse.json(
      { enabled: true, error: "list-locals-failed" },
      { status: 502 },
    );
  }

  // `symbolic-ref` exits non-zero on a detached HEAD. That is a state,
  // not a failure — fall back to the short sha so the picker and the
  // status bar have something honest to render.
  let current = head.ok ? head.stdout.trim() || null : null;
  const detached = current === null;
  if (detached) {
    const shortSha = await runGit(root, ["rev-parse", "--short", "HEAD"], {
      timeoutMs: 1000,
    });
    current = shortSha.ok ? shortSha.stdout.trim() || null : null;
  }

  const body: BranchResponse = {
    enabled: true,
    current,
    detached,
    locals: parseLocals(locals.stdout),
    remotes: remotes.ok ? parseRefs(remotes.stdout) : [],
    tags: tags.ok ? parseRefs(tags.stdout) : [],
  };
  return NextResponse.json(body);
}

function parseLocals(raw: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name, headMark, upstream, track, sha, author, relDate, subject] =
      line.split("\0");
    if (!name) continue;
    const hasUpstream = Boolean(upstream);
    const ab = parseAheadBehind(track ?? "", hasUpstream);
    out.push({
      name,
      isCurrent: headMark === "*",
      upstream: hasUpstream ? (upstream as string) : null,
      ahead: ab.ahead,
      behind: ab.behind,
      sha: sha || null,
      author: author || null,
      relativeDate: relDate || null,
      subject: subject || null,
    });
  }
  return out;
}

/**
 * Parse `[ahead N, behind M]` / `[ahead N]` / `[behind M]` / `[gone]`.
 *
 * An EMPTY track field means two different things depending on
 * `hasUpstream`: with one, the branch is exactly level (0/0); without
 * one, there is nothing to compare against (null/null). Collapsing
 * both to null made a tracked, in-sync branch look untracked, which
 * hides the sync control on the branch that most often needs it.
 */
function parseAheadBehind(
  track: string,
  hasUpstream: boolean,
): {
  ahead: number | null;
  behind: number | null;
} {
  if (track === "[gone]") return { ahead: null, behind: null };
  if (!track) {
    return hasUpstream
      ? { ahead: 0, behind: 0 }
      : { ahead: null, behind: null };
  }
  const aheadMatch = /ahead (\d+)/.exec(track);
  const behindMatch = /behind (\d+)/.exec(track);
  return {
    ahead: aheadMatch?.[1] ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

/**
 * Remote + tag refs. Each metadata column arrives as a `direct%00deref`
 * pair; annotated tags fill the deref half, everything else fills the
 * direct half, so we take whichever is non-empty.
 */
function parseRefs(raw: string): RefEntry[] {
  const out: RefEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const f = line.split("\0");
    const full = f[0];
    const name = f[1];
    if (!full || !name) continue;
    // `refs/remotes/origin/HEAD` is a symbolic pointer, not a branch —
    // checking it out is never what the user meant. Test the FULL
    // refname: git short-names `refs/remotes/origin/HEAD` to plain
    // `origin`, so a check against the short name silently lets it
    // through as a ref called "origin".
    if (full.endsWith("/HEAD")) continue;
    const pick = (a?: string, b?: string) => a || b || null;
    out.push({
      name,
      sha: f[2] || null,
      author: pick(f[3], f[4]),
      relativeDate: pick(f[5], f[6]),
      subject: pick(f[7], f[8]),
    });
  }
  return out;
}

/**
 * GET /api/git/repos?cwd=…
 *
 * The repositories the Source Control panel groups its changes under:
 * the main working tree plus every LINKED WORKTREE of the same repo,
 * each with its branch and dirty count.
 *
 * This is MARVIN's answer to VS Code's multi-repo SCM list, and it is
 * not speculative surface — ADR-0081 has MARVIN itself create git
 * worktrees for implementer subagents, so a session routinely has a
 * second checkout of the same repo on disk that the panel could not
 * see. Listing them is what makes "an implementer is working over
 * there" visible instead of invisible.
 *
 * Deliberately NOT a filesystem scan for nested `.git` directories:
 * `git worktree list` is authoritative, bounded, and cannot wander
 * outside the repo the user opened.
 *
 * Read-only.
 */

import { basename } from "node:path";
import { runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RepoEntry {
  /** Absolute path of the working tree. */
  path: string;
  /** Last path component — what the panel's group row shows. */
  name: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  /** `true` for the worktree the user actually has open. */
  isCurrent: boolean;
  /** `true` for the repo's main working tree (not a linked one). */
  isMain: boolean;
  /** Modified + staged + untracked entries; -1 when unreadable. */
  dirtyCount: number;
  /** A linked worktree with a checked-out branch is locked to it. */
  locked: boolean;
}

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

  const probe = await runGit(root, ["rev-parse", "--show-toplevel"], {
    timeoutMs: 2000,
  });
  if (!probe.ok || !probe.stdout.trim()) {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }
  const currentTop = probe.stdout.trim();

  const list = await runGit(root, ["worktree", "list", "--porcelain"], {
    timeoutMs: 5000,
  });
  if (!list.ok) {
    // `git worktree` predates nothing we support, but a repo in an
    // odd state can still fail the call. One repo — the one we are
    // standing in — is a correct answer, not an error page.
    return NextResponse.json({
      enabled: true,
      repos: [await describe(currentTop, currentTop, true, true)],
    });
  }

  const parsed = parseWorktrees(list.stdout);
  const repos = await Promise.all(
    parsed.map((w, i) =>
      describe(w.path, currentTop, i === 0, w.path === currentTop, w),
    ),
  );
  return NextResponse.json({ enabled: true, repos });
}

interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
}

/**
 * `git worktree list --porcelain` emits blank-line-separated records:
 *
 *   worktree /Users/x/marvin
 *   HEAD 6d6ec74d…
 *   branch refs/heads/main
 *
 * with `detached` / `locked` as bare keyword lines. The first record
 * is always the main working tree.
 */
function parseWorktrees(raw: string): ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      cur = {
        path: trimmed.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        locked: false,
      };
    } else if (!cur) {
    } else if (trimmed.startsWith("HEAD ")) {
      cur.head = trimmed.slice("HEAD ".length);
    } else if (trimmed.startsWith("branch ")) {
      cur.branch = trimmed.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (trimmed === "detached") {
      cur.detached = true;
    } else if (trimmed === "locked" || trimmed.startsWith("locked ")) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function describe(
  path: string,
  _currentTop: string,
  isMain: boolean,
  isCurrent: boolean,
  known?: ParsedWorktree,
): Promise<RepoEntry> {
  const status = await runGit(path, ["status", "--porcelain"], {
    timeoutMs: 8000,
  });
  const dirtyCount = status.ok
    ? status.stdout.split("\n").filter((l) => l.trim().length > 0).length
    : -1;

  let branch = known?.branch ?? null;
  let head = known?.head ?? null;
  let detached = known?.detached ?? false;
  if (!known) {
    const [b, h] = await Promise.all([
      runGit(path, ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 1500 }),
      runGit(path, ["rev-parse", "HEAD"], { timeoutMs: 1500 }),
    ]);
    branch = b.ok ? b.stdout.trim() || null : null;
    detached = branch === null;
    head = h.ok ? h.stdout.trim() || null : null;
  }

  return {
    path,
    name: basename(path) || path,
    branch,
    head,
    detached,
    isCurrent,
    isMain,
    dirtyCount,
    locked: known?.locked ?? false,
  };
}

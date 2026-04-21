/**
 * POST /api/git/branch/switch — body `{ cwd, name }`
 *
 * `git switch <name>`. Denied in v1 when the working tree is dirty
 * (see ADR-0012 rules-of-note); stash-on-switch is a v2 feature.
 *
 * Cleanness is probed via `git status --porcelain` (short form —
 * we only need to know if ANY output exists, not to parse it).
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafeRef, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

import { confirmGate } from "@/lib/git-confirm-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { cwd?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const name = typeof body.name === "string" ? body.name : null;
  if (!cwd || !name) {
    return NextResponse.json(
      { error: "cwd and name required" },
      { status: 400 },
    );
  }
  if (!isSafeRef(name)) {
    return NextResponse.json(
      { error: "invalid-ref", value: name },
      { status: 400 },
    );
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

  // `--untracked-files=no` excludes new-but-not-added files from the
  // dirtiness check. Vanilla `git status --porcelain` flags *any*
  // untracked file (.DS_Store, scratch notes, node_modules junk) as
  // dirty, which meant we were blocking legitimate branch switches
  // on a repo that was fine by git's own standards. Git itself
  // allows the switch unless an untracked file would be
  // *overwritten* by the target branch — which git catches in its
  // own refusal, not ours. Our gate now only trips on modified /
  // staged files, same as `git status` in short form.
  const statusProbe = await runGit(
    root,
    ["status", "--porcelain", "--untracked-files=no"],
    { timeoutMs: 3000 },
  );
  if (!statusProbe.ok) {
    return NextResponse.json(
      { error: "status-probe-failed" },
      { status: 502 },
    );
  }
  const workingTreeClean = statusProbe.stdout.trim().length === 0;

  const gate = confirmGate(
    req,
    { kind: "branch-switch", name, workingTreeClean },
    root,
  );
  if (!gate.allow) return gate.response;

  const res = await runGit(root, ["switch", name], { timeoutMs: 5000 });
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    if (stderr.includes("did not match any file")) {
      return NextResponse.json(
        { error: "branch-not-found", name },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: res.error, detail: stderr || res.detail },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, name });
}

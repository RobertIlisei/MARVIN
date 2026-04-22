/**
 * POST /api/git/push — body `{ cwd, remote?, branch?, forceWithLease? }`
 *
 * Defaults: `remote = "origin"`, `branch = <current>`, `forceWithLease = false`.
 *
 * Plain `--force` is **never** available from this route — the
 * policy layer hard-denies it. Users who truly need a plain force
 * push go to the terminal where they have full context + reflog.
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 *
 * Credential inheritance: we spawn `git` with
 * `GIT_TERMINAL_PROMPT=0`, so any credential request that isn't
 * satisfied by the user's credential helper / SSH agent fails fast
 * with readable stderr. MARVIN never prompts, stores, or proxies
 * credentials. See [ADR-0013](../../../../../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import { isSafeRef, isSafeRemote, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { confirmGate } from "@/lib/git-confirm-gate";
import { remoteErrorResponse } from "@/lib/git-remote-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_REMOTE = "origin";
const PUSH_TIMEOUT_MS = 90_000;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: {
    cwd?: unknown;
    remote?: unknown;
    branch?: unknown;
    forceWithLease?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const remote =
    typeof body.remote === "string" && body.remote.length > 0
      ? body.remote
      : DEFAULT_REMOTE;
  const branchArg =
    typeof body.branch === "string" && body.branch.length > 0
      ? body.branch
      : null;
  const forceWithLease = body.forceWithLease === true;
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  if (!isSafeRemote(remote)) {
    return NextResponse.json(
      { error: "invalid-remote", value: remote },
      { status: 400 },
    );
  }
  if (branchArg !== null && !isSafeRef(branchArg)) {
    return NextResponse.json(
      { error: "invalid-ref", field: "branch", value: branchArg },
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

  // Resolve the target branch when the caller didn't pass one.
  let branch = branchArg;
  if (!branch) {
    const head = await runGit(
      root,
      ["symbolic-ref", "--short", "HEAD"],
      { timeoutMs: 1500 },
    );
    if (!head.ok || !head.stdout.trim()) {
      return NextResponse.json(
        { error: "detached-head", remedy: "check out a branch before pushing" },
        { status: 409 },
      );
    }
    branch = head.stdout.trim();
  }

  // Probe upstreamAhead (commits in @{u} not in HEAD) for policy.
  // No upstream → we don't know; treat as 0 for policy purposes.
  // The terminal user's first push typically sets up tracking via
  // `git push -u`, but we don't expose `-u` from this route for v1.
  const upstreamAhead = await detectUpstreamAhead(root);

  const gate = confirmGate(
    req,
    {
      kind: "push",
      force: forceWithLease ? "with-lease" : "none",
      branch,
      upstreamAhead,
    },
    root,
  );
  if (!gate.allow) return gate.response;

  const argv = ["push"];
  if (forceWithLease) argv.push("--force-with-lease");
  argv.push(remote, branch);

  const res = await runGit(root, argv, { timeoutMs: PUSH_TIMEOUT_MS });
  if (!res.ok) {
    return remoteErrorResponse(
      "stderr" in res ? (res.stderr ?? res.detail ?? "") : res.detail ?? "",
    );
  }
  return NextResponse.json({
    ok: true,
    remote,
    branch,
    forced: forceWithLease,
    note: res.stderr.trim() || null,
  });
}

async function detectUpstreamAhead(root: string): Promise<number> {
  const upstream = await runGit(
    root,
    ["rev-parse", "--abbrev-ref", "@{u}"],
    { timeoutMs: 1500 },
  );
  if (!upstream.ok) return 0;

  const behind = await runGit(
    root,
    ["rev-list", "--count", "HEAD..@{u}"],
    { timeoutMs: 3000 },
  );
  if (!behind.ok) return 0;
  const n = Number.parseInt(behind.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

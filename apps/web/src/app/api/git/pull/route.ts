/**
 * POST /api/git/pull — body `{ cwd, strategy: "ff-only" | "rebase" | "merge" }`
 *
 * Three strategies:
 *   - `ff-only` (auto): `git pull --ff-only`. Fails cleanly on
 *     divergence with `non-fast-forward` — safe default.
 *   - `rebase` (confirm warn): `git pull --rebase`. Replays local
 *     commits on top of upstream.
 *   - `merge` (confirm warn): `git pull --no-rebase --no-ff`. Creates
 *     a merge commit.
 *
 * Pull requires a clean tree for safety; if the working tree is
 * dirty, we refuse up-front rather than let git's messy "cannot pull
 * with rebase: You have unstaged changes" stderr filter through.
 *
 * See [ADR-0013](../../../../../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import { runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { confirmGate } from "@/lib/git-confirm-gate";
import { remoteErrorResponse } from "@/lib/git-remote-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PULL_TIMEOUT_MS = 90_000;

type PullStrategy = "ff-only" | "rebase" | "merge";

function isStrategy(v: unknown): v is PullStrategy {
  return v === "ff-only" || v === "rebase" || v === "merge";
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: unknown; strategy?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const strategy = isStrategy(body.strategy) ? body.strategy : null;
  if (!cwd || !strategy) {
    return NextResponse.json(
      { error: "cwd and strategy required" },
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

  // Refuse on dirty tree — git would refuse too for rebase/merge,
  // but for ff-only it'd proceed and potentially smear conflicts
  // across unstaged edits. Cleaner to refuse up front.
  const statusProbe = await runGit(
    root,
    ["status", "--porcelain"],
    { timeoutMs: 3000 },
  );
  if (!statusProbe.ok) {
    return NextResponse.json(
      { error: "status-probe-failed" },
      { status: 502 },
    );
  }
  if (statusProbe.stdout.trim().length > 0) {
    return NextResponse.json(
      {
        error: "dirty-working-tree",
        remedy: "commit or discard changes before pulling",
      },
      { status: 409 },
    );
  }

  const gate = confirmGate(req, { kind: "pull", strategy }, root);
  if (!gate.allow) return gate.response;

  const argv = strategyArgs(strategy);
  const res = await runGit(root, argv, { timeoutMs: PULL_TIMEOUT_MS });
  if (!res.ok) {
    return remoteErrorResponse(
      "stderr" in res ? (res.stderr ?? res.detail ?? "") : res.detail ?? "",
    );
  }
  return NextResponse.json({
    ok: true,
    strategy,
    note: res.stdout.trim() || res.stderr.trim() || null,
  });
}

function strategyArgs(strategy: PullStrategy): string[] {
  switch (strategy) {
    case "ff-only":
      return ["pull", "--ff-only"];
    case "rebase":
      return ["pull", "--rebase"];
    case "merge":
      return ["pull", "--no-rebase", "--no-ff"];
  }
}

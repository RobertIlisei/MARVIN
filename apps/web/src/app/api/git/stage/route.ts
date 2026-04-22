/**
 * POST /api/git/stage — body `{ cwd, paths: string[] }`
 *
 * `git add -- <paths>`. Auto-class policy — reversible via `unstage`.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafePathspec, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { confirmGate } from "@/lib/git-confirm-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: unknown; paths?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string")
    : null;
  if (!cwd || !paths || paths.length === 0) {
    return NextResponse.json(
      { error: "cwd and non-empty paths[] required" },
      { status: 400 },
    );
  }
  for (const p of paths) {
    if (!isSafePathspec(p)) {
      return NextResponse.json(
        { error: "invalid-pathspec", path: p },
        { status: 400 },
      );
    }
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

  const gate = confirmGate(req, { kind: "stage", paths }, root);
  if (!gate.allow) return gate.response;

  const res = await runGit(root, ["add", "--", ...paths], { timeoutMs: 10_000 });
  if (!res.ok) {
    return NextResponse.json(
      {
        error: res.error,
        detail: "stderr" in res ? res.stderr : res.detail,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, staged: paths.length });
}

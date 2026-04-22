/**
 * POST /api/git/branch/delete — body `{ cwd, name, force?: boolean }`
 *
 * `git branch -d <name>` (or `-D` when `force: true`).
 *
 * Denied when `name` is the current branch (git would refuse too;
 * our message is clearer). Unmerged branches with `force: true`
 * are confirm-danger — commits on the branch become unreachable
 * without a reflog lookup.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafeRef, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { confirmGate } from "@/lib/git-confirm-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: unknown; name?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const name = typeof body.name === "string" ? body.name : null;
  const force = body.force === true;
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

  // Probe state: is `name` the current branch? is it merged?
  const [head, mergedList] = await Promise.all([
    runGit(root, ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 1500 }),
    runGit(root, ["branch", "--merged"], { timeoutMs: 3000 }),
  ]);
  const isCurrent = head.ok && head.stdout.trim() === name;
  const merged =
    mergedList.ok &&
    mergedList.stdout
      .split("\n")
      .map((l) => l.replace(/^\*?\s+/, "").trim())
      .includes(name);

  const gate = confirmGate(
    req,
    { kind: "branch-delete", name, merged, isCurrent },
    root,
  );
  if (!gate.allow) return gate.response;

  const res = await runGit(
    root,
    ["branch", force || !merged ? "-D" : "-d", name],
    { timeoutMs: 5000 },
  );
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    if (stderr.includes("not found")) {
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
  return NextResponse.json({ ok: true, name, merged, forced: force || !merged });
}

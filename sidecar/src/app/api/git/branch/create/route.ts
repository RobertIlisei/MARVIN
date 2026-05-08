/**
 * POST /api/git/branch/create — body `{ cwd, name, from?: string }`
 *
 * Creates a new branch pointing at `from` (default: current HEAD).
 * Does NOT switch to the new branch — use `/branch/switch` afterwards
 * if desired. Separating the two ops keeps the policy surface tight
 * (switch requires a clean tree; create doesn't).
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

  let body: { cwd?: unknown; name?: unknown; from?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const name = typeof body.name === "string" ? body.name : null;
  const from =
    typeof body.from === "string" && body.from.length > 0 ? body.from : "HEAD";
  if (!cwd || !name) {
    return NextResponse.json(
      { error: "cwd and name required" },
      { status: 400 },
    );
  }
  if (!isSafeRef(name)) {
    return NextResponse.json(
      { error: "invalid-ref", field: "name", value: name },
      { status: 400 },
    );
  }
  // `from` can legitimately be `HEAD` which isSafeRef rejects (no
  // slash / dot), so whitelist HEAD explicitly then fall through.
  if (from !== "HEAD" && !isSafeRef(from)) {
    return NextResponse.json(
      { error: "invalid-ref", field: "from", value: from },
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

  // Pass `from` through for policy visibility even though isSafeRef
  // was just checked — the policy re-runs the whitelist for defence
  // in depth.
  const gate = confirmGate(
    req,
    { kind: "branch-create", name, from: from === "HEAD" ? "main" : from },
    root,
  );
  if (!gate.allow) return gate.response;

  const res = await runGit(root, ["branch", name, from], { timeoutMs: 5000 });
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    if (stderr.includes("already exists")) {
      return NextResponse.json(
        { error: "branch-exists", name },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: res.error, detail: stderr || res.detail },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, name, from });
}

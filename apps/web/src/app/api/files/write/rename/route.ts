/**
 * POST /api/files/write/rename
 *
 * Rename a file or directory within `cwd`. `to` must not already exist
 * (no implicit overwrite). Case-only renames on case-insensitive volumes
 * go through the confirm path (see `fs-write-policy.ts`).
 *
 * User-initiated write channel — see [ADR-0008](../../../../../../../docs/decisions/0008-user-initiated-write-channel.md).
 *
 * Body: `{ cwd, from, to }`
 */

import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { consumeConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RenameRequestBody {
  cwd?: unknown;
  from?: unknown;
  to?: unknown;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: RenameRequestBody;
  try {
    body = (await req.json()) as RenameRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const from = typeof body.from === "string" ? body.from : null;
  const to = typeof body.to === "string" ? body.to : null;
  if (!cwd || !from || !to) {
    return NextResponse.json(
      { error: "cwd, from, to required" },
      { status: 400 },
    );
  }

  const cwdCheck = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.error }, { status: 400 });
  }
  const absCwd = cwdCheck.absolutePath;

  const fromCheck = await checkFsPath({
    cwd: absCwd,
    target: from,
    mustExist: true,
    allowDirectory: true,
  });
  if (!fromCheck.ok) {
    return NextResponse.json({ error: `from: ${fromCheck.error}` }, { status: 400 });
  }
  const toCheck = await checkFsPath({
    cwd: absCwd,
    target: to,
    mustExist: false,
    allowDirectory: true,
  });
  if (!toCheck.ok) {
    return NextResponse.json({ error: `to: ${toCheck.error}` }, { status: 400 });
  }

  const op: FsWriteOp = {
    kind: "rename",
    from: fromCheck.absolutePath,
    to: toCheck.absolutePath,
  };
  const decision = fsWritePolicy(op, absCwd);
  if (decision.class === "deny") {
    return NextResponse.json(
      { error: "policy-deny", reason: decision.reason },
      { status: 403 },
    );
  }
  if (decision.class === "confirm") {
    const token = req.headers.get("x-marvin-confirmed");
    const consumed = consumeConfirmToken(token, { op, cwd: absCwd });
    if (!consumed.ok) {
      return NextResponse.json(
        {
          error: "needs-confirm",
          reason: decision.reason,
          severity: decision.severity ?? "warn",
          tokenError: consumed.reason,
        },
        { status: 409 },
      );
    }
  }

  // Refuse if `to` already exists and is NOT the case-only rename we just
  // confirmed (APFS is case-insensitive, so fs.rename Foo→foo could silently
  // no-op; we let it through only after confirm).
  if (toCheck.exists) {
    const caseOnly =
      fromCheck.absolutePath.toLowerCase() ===
        toCheck.absolutePath.toLowerCase() &&
      fromCheck.absolutePath !== toCheck.absolutePath;
    if (!caseOnly) {
      return NextResponse.json({ error: "exists" }, { status: 409 });
    }
  }

  try {
    await fs.rename(fromCheck.absolutePath, toCheck.absolutePath);
    return NextResponse.json({
      ok: true,
      from: fromCheck.absolutePath,
      to: toCheck.absolutePath,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/files/write/move
 *
 * Move one or more files/dirs into a destination directory. Batched so
 * multi-select DnD in the tree can move N items with a single round-
 * trip. If any destination already exists the whole batch aborts and
 * `409 collisions` is returned.
 *
 * User-initiated write channel — see [ADR-0008](../../../../../../../docs/decisions/0008-user-initiated-write-channel.md).
 *
 * Body: `{ cwd, from: string[], to: string }`
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { consumeConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MoveRequestBody {
  cwd?: unknown;
  from?: unknown;
  to?: unknown;
}

export async function POST(req: NextRequest) {
  let body: MoveRequestBody;
  try {
    body = (await req.json()) as MoveRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const from = Array.isArray(body.from) ? body.from : null;
  const to = typeof body.to === "string" ? body.to : null;
  if (!cwd || !from || from.length === 0 || !to) {
    return NextResponse.json(
      { error: "cwd, non-empty from[], to required" },
      { status: 400 },
    );
  }
  if (!from.every((p) => typeof p === "string")) {
    return NextResponse.json({ error: "from must be string[]" }, { status: 400 });
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

  const toCheck = await checkFsPath({
    cwd: absCwd,
    target: to,
    mustExist: true,
    allowDirectory: true,
  });
  if (!toCheck.ok) {
    return NextResponse.json({ error: `to: ${toCheck.error}` }, { status: 400 });
  }
  if (!toCheck.isDirectory) {
    return NextResponse.json({ error: "to must be a directory" }, { status: 400 });
  }

  const fromAbsList: string[] = [];
  for (const src of from as string[]) {
    const fromCheck = await checkFsPath({
      cwd: absCwd,
      target: src,
      mustExist: true,
      allowDirectory: true,
    });
    if (!fromCheck.ok) {
      return NextResponse.json(
        { error: `from[${src}]: ${fromCheck.error}` },
        { status: 400 },
      );
    }
    fromAbsList.push(fromCheck.absolutePath);
  }

  const op: FsWriteOp = {
    kind: "move",
    from: fromAbsList,
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

  // Pre-flight: collect collisions before mutating anything.
  const collisions: string[] = [];
  for (const src of fromAbsList) {
    const dest = path.join(toCheck.absolutePath, path.basename(src));
    try {
      await fs.lstat(dest);
      collisions.push(dest);
    } catch {
      // not present → ok
    }
  }
  if (collisions.length > 0) {
    return NextResponse.json({ error: "collisions", collisions }, { status: 409 });
  }

  const moved: Array<{ from: string; to: string }> = [];
  for (const src of fromAbsList) {
    const dest = path.join(toCheck.absolutePath, path.basename(src));
    try {
      await fs.rename(src, dest);
      moved.push({ from: src, to: dest });
    } catch (e) {
      return NextResponse.json(
        { error: "io-error", detail: String(e), partial: moved },
        { status: 500 },
      );
    }
  }
  return NextResponse.json({ ok: true, moved });
}

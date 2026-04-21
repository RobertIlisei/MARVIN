/**
 * POST /api/files/write/save
 *
 * Save an edit to an existing file. Optimistic-concurrency via
 * `expectedMtime`: on mismatch returns `409 stale` with the current
 * mtime so the UI can surface the conflict.
 *
 * User-initiated write channel — see [ADR-0008](../../../../../../../docs/decisions/0008-user-initiated-write-channel.md).
 *
 * Body: `{ cwd, path, content, expectedMtime? }`
 */

import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { consumeConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SaveRequestBody {
  cwd?: unknown;
  path?: unknown;
  content?: unknown;
  expectedMtime?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SaveRequestBody;
  try {
    body = (await req.json()) as SaveRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const target = typeof body.path === "string" ? body.path : null;
  const content = typeof body.content === "string" ? body.content : null;
  const expectedMtime =
    typeof body.expectedMtime === "number" ? body.expectedMtime : null;

  if (!cwd || !target || content === null) {
    return NextResponse.json(
      { error: "cwd, path, content required" },
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

  const pathCheck = await checkFsPath({
    cwd: absCwd,
    target,
    mustExist: true,
    allowDirectory: false,
  });
  if (!pathCheck.ok) {
    const status =
      pathCheck.error === "not-found"
        ? 404
        : pathCheck.error === "is-directory"
          ? 400
          : pathCheck.error === "io-error"
            ? 500
            : 400;
    return NextResponse.json({ error: pathCheck.error }, { status });
  }

  const op: FsWriteOp = {
    kind: "write-file",
    path: pathCheck.absolutePath,
    bytes: Buffer.byteLength(content, "utf8"),
    overwrite: true,
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

  try {
    const stat = await fs.stat(pathCheck.absolutePath);
    if (expectedMtime !== null && stat.mtimeMs !== expectedMtime) {
      return NextResponse.json(
        {
          error: "stale",
          currentMtime: stat.mtimeMs,
          size: stat.size,
        },
        { status: 409 },
      );
    }
    await fs.writeFile(pathCheck.absolutePath, content, "utf8");
    const after = await fs.stat(pathCheck.absolutePath);
    return NextResponse.json({
      ok: true,
      path: pathCheck.absolutePath,
      mtime: after.mtimeMs,
      size: after.size,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/files/write/create
 *
 * Create a new file or directory inside `cwd`. User-initiated write
 * channel — see [ADR-0008](../../../../../../../docs/decisions/0008-user-initiated-write-channel.md).
 *
 * Body: `{ cwd, path, kind: "file"|"dir", content?, overwrite? }`
 *
 * - For `kind: "file"`: writes UTF-8 `content` (default empty). With
 *   `overwrite: false` (default) the write uses the `wx` flag and
 *   returns `409 exists` if the target is already present.
 * - For `kind: "dir"`: `fs.mkdir` non-recursive. Parents must exist.
 */

import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { consumeConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateRequestBody {
  cwd?: unknown;
  path?: unknown;
  kind?: unknown;
  content?: unknown;
  overwrite?: unknown;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: CreateRequestBody;
  try {
    body = (await req.json()) as CreateRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const target = typeof body.path === "string" ? body.path : null;
  const kind = body.kind === "file" || body.kind === "dir" ? body.kind : null;
  const content = typeof body.content === "string" ? body.content : "";
  const overwrite = body.overwrite === true;

  if (!cwd || !target || !kind) {
    return NextResponse.json(
      { error: "cwd, path, kind required" },
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
    mustExist: false,
    allowDirectory: true,
  });
  if (!pathCheck.ok) {
    const status =
      pathCheck.error === "parent-not-found"
        ? 404
        : pathCheck.error === "io-error"
          ? 500
          : 400;
    return NextResponse.json({ error: pathCheck.error }, { status });
  }

  const op: FsWriteOp =
    kind === "file"
      ? {
          kind: "create-file",
          path: pathCheck.absolutePath,
          bytes: Buffer.byteLength(content, "utf8"),
        }
      : { kind: "create-dir", path: pathCheck.absolutePath };

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
    if (kind === "file") {
      await fs.writeFile(pathCheck.absolutePath, content, {
        encoding: "utf8",
        flag: overwrite ? "w" : "wx",
      });
    } else {
      await fs.mkdir(pathCheck.absolutePath, { recursive: false });
    }
    return NextResponse.json({ ok: true, path: pathCheck.absolutePath });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") {
      return NextResponse.json({ error: "exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return NextResponse.json({ error: "parent-not-found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

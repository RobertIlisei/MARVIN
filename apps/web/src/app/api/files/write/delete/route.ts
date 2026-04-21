/**
 * POST /api/files/write/delete
 *
 * Delete one or more files/dirs. `mode: "trash"` is reversible (macOS
 * Trash / Windows Recycle Bin / XDG trash via the `trash` npm package)
 * and auto-classified. `mode: "permanent"` runs `fs.rm` and is always
 * classified as `confirm danger`.
 *
 * User-initiated write channel — see [ADR-0008](../../../../../../../docs/decisions/0008-user-initiated-write-channel.md).
 *
 * Body: `{ cwd, paths: string[], mode: "trash"|"permanent" }`
 */

import { promises as fs } from "node:fs";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { consumeConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";
import trash from "trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeleteRequestBody {
  cwd?: unknown;
  paths?: unknown;
  mode?: unknown;
}

export async function POST(req: NextRequest) {
  let body: DeleteRequestBody;
  try {
    body = (await req.json()) as DeleteRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const paths = Array.isArray(body.paths) ? body.paths : null;
  const mode =
    body.mode === "trash" || body.mode === "permanent" ? body.mode : null;
  if (!cwd || !paths || paths.length === 0 || !mode) {
    return NextResponse.json(
      { error: "cwd, non-empty paths[], mode required" },
      { status: 400 },
    );
  }
  if (!paths.every((p) => typeof p === "string")) {
    return NextResponse.json(
      { error: "paths must be string[]" },
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

  const absPaths: string[] = [];
  for (const p of paths as string[]) {
    const check = await checkFsPath({
      cwd: absCwd,
      target: p,
      mustExist: true,
      allowDirectory: true,
    });
    if (!check.ok) {
      return NextResponse.json(
        { error: `paths[${p}]: ${check.error}` },
        { status: 400 },
      );
    }
    absPaths.push(check.absolutePath);
  }

  const op: FsWriteOp =
    mode === "trash"
      ? { kind: "delete-trash", paths: absPaths }
      : { kind: "delete-permanent", paths: absPaths };
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
    if (mode === "trash") {
      await trash(absPaths);
    } else {
      for (const p of absPaths) {
        await fs.rm(p, { recursive: true, force: false });
      }
    }
    return NextResponse.json({ ok: true, deleted: absPaths, mode });
  } catch (e) {
    return NextResponse.json(
      { error: "io-error", detail: String(e) },
      { status: 500 },
    );
  }
}

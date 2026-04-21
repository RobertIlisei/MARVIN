/**
 * POST /api/files/write/confirm
 *
 * User-initiated write channel: mint a one-shot confirm token for a
 * `confirm`-classified op. Client workflow:
 *
 *   1. Client POSTs the op to a write route (e.g. /delete).
 *   2. Policy classifies as `confirm`. Route returns `409 { needsConfirm,
 *      reason, severity }`.
 *   3. Client renders a modal with the reason, user clicks "confirm".
 *   4. Client POSTs the same op here → gets `{ token, expiresIn }`.
 *   5. Client re-sends the original request with
 *      `X-Marvin-Confirmed: <token>`.
 *
 * Tokens are scoped to the op+cwd combination and are one-shot — see
 * [`fs-write-confirm-registry.ts`](../../../../../../packages/runtime/src/fs-write-confirm-registry.ts).
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { mintConfirmToken } from "@marvin/runtime/fs-write-confirm-registry";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";

import { canonicalizeOp } from "@/lib/canonicalize-op";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfirmRequestBody {
  cwd?: unknown;
  op?: unknown;
}

export async function POST(req: NextRequest) {
  let body: ConfirmRequestBody;
  try {
    body = (await req.json()) as ConfirmRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
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

  const rawOp = body.op as FsWriteOp | undefined;
  if (!rawOp || typeof rawOp !== "object" || typeof rawOp.kind !== "string") {
    return NextResponse.json({ error: "op required" }, { status: 400 });
  }

  // Canonicalise op paths the same way the mutation routes do. Otherwise
  // `/confirm` and (say) `/delete` disagree on the op shape and the token
  // consume-time structural compare fails with `token/op mismatch`.
  const canon = await canonicalizeOp(rawOp, absCwd);
  if (!canon.ok) {
    return NextResponse.json(
      { error: `${canon.field}: ${canon.error}` },
      { status: 400 },
    );
  }
  const op = canon.op;

  const decision = fsWritePolicy(op, absCwd);
  if (decision.class === "deny") {
    return NextResponse.json(
      { error: "policy-deny", reason: decision.reason },
      { status: 403 },
    );
  }
  if (decision.class === "auto") {
    // No token needed — caller can run the op directly.
    return NextResponse.json(
      { needsConfirm: false, reason: decision.reason },
      { status: 200 },
    );
  }
  const { token, expiresIn } = mintConfirmToken(op, absCwd);
  return NextResponse.json({
    needsConfirm: true,
    reason: decision.reason,
    severity: decision.severity ?? "warn",
    token,
    expiresIn,
  });
}

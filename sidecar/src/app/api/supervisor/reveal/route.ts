/**
 * POST /api/supervisor/reveal { projectId, ledgerId } → { ok: true }
 *
 * ADR-0127 milestone 4 (design brief §10.3, open decision 1) — a shadow
 * proposal is blind on the watch row until the user reveals it. The reveal is
 * a ledger line, and the pairing records whether it came before the answer,
 * so agreement can be read with and without anchoring. Idempotent; 404 for no
 * such proposal, 409 once the question was answered. Token-gated and
 * CSRF-guarded like every supervisor mutation.
 */

import { isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { revealProposal } from "@marvin/runtime/supervisor-status";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json({ error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" }, { status: 403 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; ledgerId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const ledgerId = typeof body.ledgerId === "string" ? body.ledgerId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  if (!ledgerId || ledgerId.length > 100) return NextResponse.json({ error: "ledgerId required" }, { status: 400 });
  const r = revealProposal(projectId, ledgerId);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}

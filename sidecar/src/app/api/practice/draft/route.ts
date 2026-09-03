/**
 * POST /api/practice/draft { projectId, id } → { ok, message, rationale, costUsd }
 *
 * Phase 4 (ADR-0105): the user asks a read-only model to draft a rule
 * message from a finding's aggregates. Nothing is persisted here — the pane
 * hands the draft to approve-with-message or the rule's edit-message path.
 */

import { type NextRequest, NextResponse } from "next/server";
import { draftPracticeMessage } from "@marvin/runtime/practice-draft";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: string; id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const projectId = projectIdFrom(req, body);
  if (!projectId) return NextResponse.json({ error: "unknown or missing projectId" }, { status: 400 });
  const id = body.id?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const res = await draftPracticeMessage({ projectId, findingId: id });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 422 });
  return NextResponse.json({ ok: true, message: res.message, rationale: res.rationale, costUsd: res.costUsd ?? null });
}

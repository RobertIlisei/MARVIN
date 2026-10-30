/**
 * POST /api/confirm/answer — answer a pending AskUserQuestion by label
 * (ADR-0127 §9, milestone 2).
 *
 * Body: `{ marvinSessionId, toolUseId, answers?, other?, turnId? }` —
 * `answers` maps the full question text to an option label (an array for a
 * multi-select), `other` gives free text. The server builds
 * `updatedInput: { questions, answers }` from the question the registry kept,
 * exactly as the native sheet does, so no caller hand-builds it.
 *
 * The turn is the session's live turn; a `turnId` that disagrees with it is
 * refused. User authority only (CSRF-guarded like `/api/confirm`): the
 * supervisor answers for real only after the consent gate on
 * supervisor-touched turns ships (plan, milestones 3–4).
 *
 * 200 `{ ok, updatedInput }` · 400 invalid answer or not a question ·
 * 409 no live turn, a turnId mismatch, or already answered · 403 CSRF.
 */

import { answerQuestion } from "@marvin/runtime/confirm-answer";
import { getLiveTurn } from "@marvin/runtime/turn-registry";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

const isStringMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const marvinSessionId = typeof body.marvinSessionId === "string" ? body.marvinSessionId.trim() : "";
  const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId.trim() : "";
  if (!marvinSessionId || !toolUseId) {
    return NextResponse.json({ error: "marvinSessionId and toolUseId are required" }, { status: 400 });
  }
  if (body.answers !== undefined && !isStringMap(body.answers)) return NextResponse.json({ error: "answers must be an object" }, { status: 400 });
  if (body.other !== undefined && !isStringMap(body.other)) return NextResponse.json({ error: "other must be an object" }, { status: 400 });

  const live = getLiveTurn(marvinSessionId);
  if (!live || live.ended) return NextResponse.json({ error: "that session has no live turn — nothing is waiting for an answer" }, { status: 409 });
  if (typeof body.turnId === "string" && body.turnId.trim() && body.turnId.trim() !== live.turnId) {
    return NextResponse.json({ error: "turnId does not match the session's live turn" }, { status: 409 });
  }

  const result = answerQuestion({
    turnId: live.turnId,
    toolUseId,
    answers: (body.answers ?? {}) as Record<string, string | string[]>,
    other: (body.other ?? {}) as Record<string, string>,
    answeredBy: "user",
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, updatedInput: result.updatedInput });
}
